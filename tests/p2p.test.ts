import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  balanceEntries,
  deals,
  emailOutbox,
  listings,
  mockProviderPayments,
  orders,
  payments,
  payouts,
  refunds,
  sellerProfiles,
  users,
} from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { cs2Items } from "@/lib/bots/fixtures";
import type { SteamItem } from "@/lib/bots/inventory";
import { createOrder, expireStaleOrders, handlePaymentWebhook, OrderError } from "@/lib/orders/service";
import { signMockWebhook, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "@/lib/payments/mock-elqr";
import { permissiveSteamApi } from "@/lib/steam/buyer-checks";
import { setInventoryApiForTests, type InventoryApi } from "@/lib/p2p/inventory";
import { setMarketSourceForTests } from "@/lib/p2p/market-price";
import { setFileStoreForTests, type FileStore } from "@/lib/p2p/files";
import { recordFingerprint } from "@/lib/p2p/fingerprints";
import {
  createListing,
  getVerification,
  listVerifications,
  reviewVerification,
  SellerError,
  submitVerification,
  withdrawListing,
  type VerificationInput,
} from "@/lib/p2p/seller";
import { approveDealReview, openDisputeByBuyer, processDeals, resolveDispute } from "@/lib/p2p/deals";
import { createPayout } from "@/lib/admin/balances";
import { refundOrder } from "@/lib/admin/orders";
import { AdminAccessError } from "@/lib/admin/rbac";

// ---------- Окружение: инвентари Steam, рыночные цены и хранилище файлов в памяти ----------

const inventories = new Map<string, SteamItem[]>();
const fakeInventory: InventoryApi = {
  async getInventory(steamId, appId) {
    if (inventories.get(`closed:${steamId}`)) return null;
    return (inventories.get(steamId) ?? []).filter((i) => i.appid === appId);
  },
};
let nextAsset = 90_000_000_000;
/** Steam выдает предмету у получателя новый assetid. */
function transfer(from: string, to: string, assetId: string) {
  const item = inventories.get(from)!.find((i) => i.assetid === assetId)!;
  inventories.set(from, inventories.get(from)!.filter((i) => i.assetid !== assetId));
  const moved = { ...item, assetid: String(nextAsset++) };
  inventories.set(to, [...(inventories.get(to) ?? []), moved]);
  return moved.assetid;
}

const files = new Map<string, Buffer>();
const memStore: FileStore = { put: async (k, d) => void files.set(k, d), get: async (k) => files.get(k)! };

const MARKET_SOM = 2_400; // рыночная цена AK-47 | Redline (FT) в тестах
setInventoryApiForTests(fakeInventory);
setFileStoreForTests(memStore);
setMarketSourceForTests({ name: "test", fetch: async (_g, name) => (name.includes("Redline") ? MARKET_SOM * 100 : null) });
afterAll(() => {
  setInventoryApiForTests(null);
  setFileStoreForTests(null);
  setMarketSourceForTests(null);
});

beforeEach(async () => {
  await db.execute(sql`truncate table settings, user_fingerprints, market_prices, balance_entries, payouts, deals, listings, seller_profiles,
    sessions, login_tokens, rate_limits, users, webhook_events, email_outbox, refunds, trade_offers, payments, product_keys,
    order_items, orders, products, mock_provider_payments, audit_log cascade`);
  inventories.clear();
  files.clear();
});

let acc = 700_000;
async function steamUser(opts: { email?: string; role?: SessionUser["role"] } = {}) {
  const accountId = acc++;
  const steamId = (BigInt("76561197960265728") + BigInt(accountId)).toString();
  const [u] = await db.insert(users).values({ steamId, email: opts.email ?? `u${accountId}@test.kg`, role: opts.role ?? "BUYER", displayName: `user${accountId}` }).returning();
  return { user: u as SessionUser, tradeUrl: `https://steamcommunity.com/tradeoffer/new/?partner=${accountId}&token=Tok${accountId}` };
}
const staff = (role: SessionUser["role"]) => steamUser({ role, email: `${role.toLowerCase()}${acc}@shop.kg` }).then((r) => r.user);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("PASSPORT-PHOTO-PIXELS")]);
const validVerification: VerificationInput = {
  fullName: "Асанов Бакыт Тологонович",
  birthDate: "1995-04-12",
  passport: "ID1234567",
  phone: "+996 555 123 456",
  payoutDetails: "4169 5853 1234 5678",
  payoutHolder: "асанов  бакыт тологонович",
  adult: true,
  sellerOffer: true,
};

async function verifiedSeller(details = validVerification) {
  const s = await steamUser();
  await submitVerification(s.user, details, { passport: PNG, selfie: PNG });
  await reviewVerification(await staff("COMPLIANCE"), s.user.id, true);
  return s;
}

/** Продавец с AK-47 | Redline в инвентаре, лот за priceSom. */
async function listAk(seller: { user: SessionUser }, priceSom = 2_500) {
  inventories.set(seller.user.steamId!, [{ ...cs2Items.akRedlineFT, assetid: String(nextAsset++) }]);
  const assetId = inventories.get(seller.user.steamId!)![0].assetid;
  const r = await createListing(seller.user, { game: "CS2", assetId, priceSom, sellerOffer: true });
  return { ...r, assetId };
}

async function buy(listingId: string, buyer: { user: SessionUser; tradeUrl: string }, ctx: { deviceId?: string; ip?: string } = {}) {
  return createOrder(
    { listingId, email: buyer.user.email!, tradeUrl: buyer.tradeUrl, adultConfirmed: true, offerAccepted: true },
    { userId: buyer.user.id, steamApi: permissiveSteamApi, inventory: fakeInventory, ...ctx },
  );
}

async function pay(orderId: string) {
  const [payment] = await db.select().from(payments).where(eq(payments.orderId, orderId));
  await db.update(mockProviderPayments).set({ status: "SUCCEEDED" }).where(eq(mockProviderPayments.id, payment.providerPaymentId));
  const body = JSON.stringify({
    eventId: `evt_${randomUUID()}`,
    paymentId: payment.providerPaymentId,
    status: "SUCCEEDED",
    amount: payment.amountMinor,
    currency: "KGS",
    occurredAt: new Date().toISOString(),
  });
  const ts = Math.floor(Date.now() / 1000);
  const h = new Headers({ [SIGNATURE_HEADER]: signMockWebhook(process.env.MOCK_ELQR_WEBHOOK_SECRET!, body, ts), [TIMESTAMP_HEADER]: String(ts) });
  return handlePaymentWebhook("mock", body, h);
}

const dealOf = async (orderId: string) => (await db.select().from(deals).where(eq(deals.orderId, orderId)))[0];
const orderOf = async (id: string) => (await db.select().from(orders).where(eq(orders.id, id)))[0];
const mailsTo = async (to: string) => (await db.select().from(emailOutbox).where(eq(emailOutbox.to, to))).map((m) => m.template);
const tick = (hoursFromNow = 0) => processDeals({ now: new Date(Date.now() + hoursFromNow * 3_600_000), inventory: fakeInventory, minIntervalMs: 0 });

// ---------- Верификация ----------

describe("верификация продавца", () => {
  it("данные шифруются, фото — в приватном хранилище зашифрованными, видит только комплаенс", async () => {
    const s = await steamUser();
    await submitVerification(s.user, validVerification, { passport: PNG, selfie: PNG });
    const [p] = await db.select().from(sellerProfiles).where(eq(sellerProfiles.userId, s.user.id));
    expect(p.verificationStatus).toBe("PENDING");
    const raw = JSON.stringify(p);
    for (const plain of ["ID1234567", "Асанов", "1995-04-12", "4169", "555 123"]) expect(raw).not.toContain(plain);
    expect(files.size).toBe(2);
    for (const data of files.values()) expect(data.includes(Buffer.from("PASSPORT-PHOTO-PIXELS"))).toBe(false);

    await expect(listVerifications(await staff("SUPPORT"))).rejects.toBeInstanceOf(AdminAccessError);
    await expect(listVerifications(await staff("ADMIN"))).rejects.toBeInstanceOf(AdminAccessError);
    const v = await getVerification(await staff("COMPLIANCE"), s.user.id);
    expect(v).toMatchObject({ fullName: "Асанов Бакыт Тологонович", passport: "ID1234567", phone: "+996555123456", age: expect.any(Number) });
  });

  it.each([
    ["реквизиты на чужое имя", { payoutHolder: "Петров Петр Петрович" }, /самого продавца/],
    ["младше 18", { birthDate: `${new Date().getUTCFullYear() - 17}-01-01` }, /18/],
    ["неверный паспорт", { passport: "12345" }, /паспорт/i],
    ["без согласия с офертой", { sellerOffer: false }, /оферт/],
  ])("отклоняет: %s", async (_n, patch, msg) => {
    const s = await steamUser();
    await expect(submitVerification(s.user, { ...validVerification, ...patch }, { passport: PNG, selfie: PNG })).rejects.toThrow(msg);
  });

  it("не картинка вместо фото паспорта — отказ", async () => {
    const s = await steamUser();
    await expect(submitVerification(s.user, validVerification, { passport: Buffer.from("%PDF-1.4 ..."), selfie: PNG })).rejects.toThrow(/JPG, PNG/);
  });
});

// ---------- Лоты ----------

describe("выставление лота", () => {
  it("кейс выставить нельзя, чужой предмет — тоже, повторно один предмет — нельзя", async () => {
    const s = await steamUser();
    inventories.set(s.user.steamId!, [cs2Items.revolutionCase, cs2Items.akRedlineFT]);
    await expect(createListing(s.user, { game: "CS2", assetId: cs2Items.revolutionCase.assetid, priceSom: 100, sellerOffer: true })).rejects.toThrow(/Кейсы/);
    await expect(createListing(s.user, { game: "CS2", assetId: "99999", priceSom: 100, sellerOffer: true })).rejects.toThrow(/нет в вашем инвентаре/);
    const r = await createListing(s.user, { game: "CS2", assetId: cs2Items.akRedlineFT.assetid, priceSom: 2_500, sellerOffer: true });
    expect(r.listing).toMatchObject({ status: "ACTIVE", priceMinor: 250_000, marketPriceMinor: MARKET_SOM * 100, title: "AK-47 | Redline (Field-Tested)" });
    expect(r.warning).toBeNull();
    await expect(createListing(s.user, { game: "CS2", assetId: cs2Items.akRedlineFT.assetid, priceSom: 2_600, sellerOffer: true })).rejects.toThrow(/уже выставлен/);
  });

  it("свой лот купить нельзя; неоплаченный резерв возвращает лот на витрину", async () => {
    const seller = await steamUser();
    const { listing } = await listAk(seller);
    await expect(buy(listing.id, seller)).rejects.toMatchObject({ code: "OWN_LISTING" });

    const buyer = await steamUser();
    const order = await buy(listing.id, buyer);
    expect((await db.select().from(listings).where(eq(listings.id, listing.id)))[0].status).toBe("RESERVED");
    await expect(buy(listing.id, await steamUser())).rejects.toBeInstanceOf(OrderError);
    await expireStaleOrders(new Date(order.expiresAt.getTime() + 10 * 60_000));
    expect((await db.select().from(listings).where(eq(listings.id, listing.id)))[0].status).toBe("ACTIVE");
  });
});

// ---------- Сделка ----------

describe("сделка P2P", () => {
  it("полный цикл: оплата → передача → защита от отката → выплата за вычетом комиссии", async () => {
    const seller = await verifiedSeller();
    const { listing, assetId } = await listAk(seller, 2_500);
    const buyer = await steamUser();
    const order = await buy(listing.id, buyer);
    expect((await pay(order.id)).result).toBe("paid_awaiting_delivery");

    const deal = await dealOf(order.id);
    expect(deal).toMatchObject({ status: "AWAITING_TRANSFER", priceMinor: 250_000, commissionMinor: 25_000 }); // комиссия 10 %
    expect(await mailsTo(seller.user.email!)).toContain("lotSold");

    expect(await tick()).toMatchObject({ transferred: 0 });
    transfer(seller.user.steamId!, buyer.user.steamId!, assetId);
    expect(await tick()).toMatchObject({ transferred: 1 });
    expect(await dealOf(order.id)).toMatchObject({ status: "PROTECTION" });
    expect((await orderOf(order.id)).status).toBe("DELIVERED");
    expect(await mailsTo(buyer.user.email!)).toContain("orderDelivered");

    expect(await tick(24)).toMatchObject({ earned: 0 }); // защита еще идет (7 дней)
    expect(await tick(8 * 24)).toMatchObject({ earned: 1, paidOut: 1 });
    expect(await dealOf(order.id)).toMatchObject({ status: "PAID_OUT" });
    const [p] = await db.select().from(payouts).where(eq(payouts.dealId, deal.id));
    expect(p).toMatchObject({ status: "SENT", amountMinor: 225_000 });
    const entries = await db.select().from(balanceEntries).where(eq(balanceEntries.sellerId, seller.user.id));
    expect(entries.reduce((s, e) => s + e.amountMinor, 0)).toBe(0);
    expect(await mailsTo(seller.user.email!)).toContain("payoutSent");
  });

  it("без верификации выплату получить нельзя (приемка)", async () => {
    const seller = await steamUser(); // лот выставить можно, выплату получить — нет
    const { listing, assetId } = await listAk(seller);
    const buyer = await steamUser();
    const order = await buy(listing.id, buyer);
    await pay(order.id);
    transfer(seller.user.steamId!, buyer.user.steamId!, assetId);
    await tick();
    expect(await tick(8 * 24)).toMatchObject({ earned: 1, paidOut: 0, payoutBlocked: 1 });

    const deal = await dealOf(order.id);
    expect(deal.status).toBe("PROTECTION");
    expect(deal.payoutError).toMatch(/не верифицирован/);
    expect(await db.select().from(payouts).where(eq(payouts.sellerId, seller.user.id))).toHaveLength(0);
    // и вручную из админки тоже нельзя
    await expect(createPayout(await staff("ADMIN"), seller.user.id, 1_000)).rejects.toThrow(/не верифицирован/);

    // после верификации выплата уходит на следующем проходе
    await submitVerification(seller.user, validVerification, { passport: PNG, selfie: PNG });
    await reviewVerification(await staff("COMPLIANCE"), seller.user.id, true);
    expect(await tick(8 * 24 + 1)).toMatchObject({ paidOut: 1 });
    expect((await dealOf(order.id)).status).toBe("PAID_OUT");
  });

  it("сделка между связанными аккаунтами уходит на проверку (приемка): общее устройство", async () => {
    const seller = await verifiedSeller();
    const buyer = await steamUser();
    await recordFingerprint(seller.user.id, { deviceId: "device-0123456789abcdef", ip: "10.0.0.1" });
    const { listing, assetId } = await listAk(seller);
    const order = await buy(listing.id, buyer, { deviceId: "device-0123456789abcdef", ip: "10.0.0.2" });
    await pay(order.id);

    const deal = await dealOf(order.id);
    expect(deal.status).toBe("REVIEW");
    expect(deal.reviewReason).toMatch(/связанные аккаунты: общее устройство/);
    expect(deal.transferDeadline).toBeNull();
    expect(await mailsTo(seller.user.email!)).not.toContain("lotSold");

    // пока на проверке, передача не засчитывается
    transfer(seller.user.steamId!, buyer.user.steamId!, assetId);
    expect(await tick()).toMatchObject({ transferred: 0 });

    await expect(approveDealReview(await staff("SUPPORT"), deal.id)).rejects.toBeInstanceOf(AdminAccessError);
    await approveDealReview(await staff("COMPLIANCE"), deal.id);
    expect(await mailsTo(seller.user.email!)).toContain("lotSold");
    expect(await tick()).toMatchObject({ transferred: 1 });
  });

  it("связанные аккаунты: общий IP и одинаковые реквизиты", async () => {
    const seller = await verifiedSeller();
    await recordFingerprint(seller.user.id, { ip: "203.0.113.7" });
    const buyer1 = await steamUser();
    const { listing } = await listAk(seller);
    const o1 = await buy(listing.id, buyer1, { ip: "203.0.113.7" });
    await pay(o1.id);
    expect((await dealOf(o1.id)).reviewReason).toMatch(/общий IP-адрес/);

    const buyer2 = await verifiedSeller(); // покупатель — тоже продавец с теми же реквизитами
    const { listing: l2 } = await listAk(seller);
    const o2 = await buy(l2.id, buyer2);
    await pay(o2.id);
    expect((await dealOf(o2.id)).reviewReason).toMatch(/одинаковые реквизиты выплаты/);
  });

  it("цена вне рынка больше чем на 30 % — на проверку", async () => {
    const seller = await verifiedSeller();
    const { listing, warning } = await listAk(seller, 5_000); // рынок 2 400
    expect(warning).toMatch(/108%/);
    const order = await buy(listing.id, await steamUser());
    await pay(order.id);
    expect(await dealOf(order.id)).toMatchObject({ status: "REVIEW", reviewReason: expect.stringMatching(/отличается от рыночной на 108%/) });
  });

  it("не переданный вовремя скин — полный возврат покупателю (приемка)", async () => {
    const seller = await verifiedSeller();
    const { listing } = await listAk(seller);
    const buyer = await steamUser();
    const order = await buy(listing.id, buyer);
    await pay(order.id);

    expect(await tick(10)).toMatchObject({ reminded: 1, cancelled: 0 }); // срок 12 ч, за 3 ч — напоминание
    expect(await mailsTo(seller.user.email!)).toContain("transferReminder");
    expect(await tick(13)).toMatchObject({ cancelled: 1 });

    expect(await dealOf(order.id)).toMatchObject({ status: "CANCELLED", cancelReason: "not_transferred" });
    expect((await orderOf(order.id)).status).toBe("REFUNDED");
    const [r] = await db.select().from(refunds);
    expect(r).toMatchObject({ status: "DONE", amountMinor: order.totalMinor });
    expect(await mailsTo(buyer.user.email!)).toContain("refund");
    expect((await db.select().from(listings).where(eq(listings.id, listing.id)))[0].status).toBe("WITHDRAWN");
    expect(await db.select().from(balanceEntries)).toHaveLength(0);
  });

  it("такой же скин, который был у покупателя до сделки, передачей не считается", async () => {
    const seller = await verifiedSeller();
    const buyer = await steamUser();
    inventories.set(buyer.user.steamId!, [{ ...cs2Items.akRedlineFT, assetid: "11112222" }]);
    const { listing } = await listAk(seller);
    const order = await buy(listing.id, buyer);
    await pay(order.id);
    expect(await tick()).toMatchObject({ transferred: 0 });
  });

  it("предмет пропал до конца защиты (откат) — спор, решение в пользу покупателя — возврат", async () => {
    const seller = await verifiedSeller();
    const { listing, assetId } = await listAk(seller);
    const buyer = await steamUser();
    const order = await buy(listing.id, buyer);
    await pay(order.id);
    const got = transfer(seller.user.steamId!, buyer.user.steamId!, assetId);
    await tick();
    transfer(buyer.user.steamId!, seller.user.steamId!, got); // Steam откатил обмен
    expect(await tick(8 * 24)).toMatchObject({ disputes: 1, earned: 0 });
    const deal = await dealOf(order.id);
    expect(deal.status).toBe("DISPUTE");

    await resolveDispute(await staff("COMPLIANCE"), deal.id, "buyer", "Обмен откатился, возвращаем деньги");
    expect((await dealOf(order.id)).status).toBe("CANCELLED");
    expect((await orderOf(order.id)).status).toBe("REFUNDED");
    expect(await db.select().from(balanceEntries)).toHaveLength(0);
  });

  it("спор покупателя: в пользу продавца — сделка продолжается с новым сроком передачи", async () => {
    const seller = await verifiedSeller();
    const { listing } = await listAk(seller);
    const order = await buy(listing.id, await steamUser());
    await pay(order.id);
    await openDisputeByBuyer(order.accessToken, "Продавец пишет в личку и просит доплату");
    const deal = await dealOf(order.id);
    expect(deal.status).toBe("DISPUTE");
    expect(await tick(13)).toMatchObject({ cancelled: 0 }); // в споре срок не идет
    await resolveDispute(await staff("ADMIN"), deal.id, "seller", "Доплату не требовал, продолжаем");
    expect(await dealOf(order.id)).toMatchObject({ status: "AWAITING_TRANSFER" });
  });

  it("возврат из админки отменяет сделку; после начисления заработка — запрещен", async () => {
    const seller = await verifiedSeller();
    const admin = await staff("ADMIN");
    const { listing } = await listAk(seller);
    const o1 = await buy(listing.id, await steamUser());
    await pay(o1.id);
    await refundOrder(admin, o1.id, "покупатель передумал");
    expect(await dealOf(o1.id)).toMatchObject({ status: "CANCELLED", cancelReason: "refunded_by_admin" });

    // без верификации заработок начислится, а выплата не уйдет — возврат должен быть запрещен
    const s2 = await steamUser();
    const { listing: l2, assetId } = await listAk(s2);
    const b2 = await steamUser();
    const o2 = await buy(l2.id, b2);
    await pay(o2.id);
    transfer(s2.user.steamId!, b2.user.steamId!, assetId);
    await tick();
    await tick(8 * 24);
    await expect(refundOrder(admin, o2.id, "ошибка")).rejects.toThrow(/начислен заработок/);
  });

  it("снятый продавцом лот купить нельзя", async () => {
    const seller = await steamUser();
    const { listing } = await listAk(seller);
    await withdrawListing(seller.user, listing.id);
    await expect(buy(listing.id, await steamUser())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(withdrawListing(seller.user, listing.id)).rejects.toBeInstanceOf(SellerError);
  });
});
