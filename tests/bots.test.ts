import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { emailOutbox, mockProviderPayments, orders, payments, products, tradeOffers, users } from "@/db/schema";
import { cs2Items, dotaItems } from "@/lib/bots/fixtures";
import { isContainer, isSellable, parseSkin, syncBotInventory, type SteamItem } from "@/lib/bots/inventory";
import { BotError, MAX_TRADE_ATTEMPTS, pollSentOffers, processTradeQueue, upsertBotAccount, type BotClient, type OfferState } from "@/lib/bots/trades";
import { MockBotClient } from "@/lib/bots/mock-client";
import { createOrder, handlePaymentWebhook } from "@/lib/orders/service";
import { signMockWebhook, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "@/lib/payments/mock-elqr";
import { permissiveSteamApi } from "@/lib/steam/buyer-checks";
import { refundOrder, requeueTradeOffer } from "@/lib/admin/orders";
import { setProductActive } from "@/lib/admin/catalog";
import { getCatalogIds } from "./helpers";

beforeEach(async () => {
  await db.execute(sql`truncate table settings, bot_accounts, sessions, login_tokens, rate_limits, users, webhook_events, email_outbox,
    refunds, trade_offers, payments, product_keys, order_items, orders, products, mock_provider_payments, audit_log cascade`);
});

// ---------- Фильтр контейнеров на реальных тегах ----------

describe("фильтр контейнеров (теги Steam CS2 и Dota 2)", () => {
  const containers: [string, SteamItem][] = [
    ["CS2 кейс", cs2Items.revolutionCase],
    ["CS2 ключ от кейса", cs2Items.caseKey],
    ["CS2 капсула с наклейками", cs2Items.stickerCapsule],
    ["CS2 сувенирный набор", cs2Items.souvenirPackage],
    ["CS2 коробка музыкальных наборов", cs2Items.musicKitBox],
    ["CS2 коробка граффити без тега Type", cs2Items.graffitiBox],
    ["Dota 2 сокровищница", dotaItems.treasure],
    ["Dota 2 ключ от сокровищницы", dotaItems.treasureKey],
    ["Dota 2 Collector's Cache", dotaItems.cache],
  ];
  const sellable: [string, SteamItem][] = [
    ["AK-47 | Redline", cs2Items.akRedlineFT],
    ["StatTrak AK-47 | Case Hardened (слово Case в названии скина)", cs2Items.akCaseHardenedST],
    ["нож", cs2Items.karambitFade],
    ["агент", cs2Items.agent],
    ["наклейка", cs2Items.sticker],
    ["Dota 2 аркана", dotaItems.arcanaPA],
    ["Dota 2 курьер", dotaItems.courier],
  ];
  it.each(containers)("отбрасывает: %s", (_n, item) => {
    expect(isContainer(item)).toBe(true);
    expect(isSellable(item)).toBe(false);
  });
  it.each(sellable)("пропускает: %s", (_n, item) => {
    expect(isContainer(item)).toBe(false);
    expect(isSellable(item)).toBe(true);
  });
  it("непередаваемый предмет не выставляется", () => {
    expect(isContainer(dotaItems.untradable)).toBe(false);
    expect(isSellable(dotaItems.untradable)).toBe(false);
  });
});

describe("атрибуты скина", () => {
  it("качество, редкость, оружие, наклейки, inspect", () => {
    const p = parseSkin(cs2Items.akRedlineFT);
    expect(p.skin).toMatchObject({
      marketHashName: "AK-47 | Redline (Field-Tested)",
      assetId: "35181112001",
      exterior: "Field-Tested",
      rarity: "Classified",
      weaponOrHero: "AK-47",
    });
    expect(p.skin.statTrak).toBeUndefined();
    expect(p.skin.stickers).toEqual([
      { name: "Ninjas in Pyjamas | Katowice 2014", slot: 0 },
      { name: "Crown (Foil)", slot: 1 },
    ]);
    expect(p.inspectLink).toContain("A35181112001D");
    expect(p.imageUrl).toMatch(/^https:\/\/community\.cloudflare\.steamstatic\.com\/economy\/image\//);
  });
  it("StatTrak и герой Dota", () => {
    expect(parseSkin(cs2Items.akCaseHardenedST).skin.statTrak).toBe(true);
    expect(parseSkin(dotaItems.arcanaPA).skin.weaponOrHero).toBe("Phantom Assassin");
  });
});

// ---------- Синхронизация инвентаря ----------

describe("синхронизация инвентаря", () => {
  it("добавляет скины скрытыми и без цены, контейнеры отбрасывает, float берет у провайдера", async () => {
    const bot = await upsertBotAccount("bot1", "76561190000000001");
    const inspected: string[] = [];
    const floats = { inspect: async (link: string) => (inspected.push(link), { float: 0.1234, pattern: 661 }) };
    const items = Object.values(cs2Items) as SteamItem[];
    const r = await syncBotInventory(bot.id, "CS2", items, floats, bot.steamId);
    expect(r).toMatchObject({ added: 5, skippedContainers: 6, skippedUntradable: 0 });
    // ключ от кейса непередаваемый, но отсекается раньше — как контейнер
    const rows = await db.select().from(products);
    expect(rows).toHaveLength(5);
    expect(rows.every((p) => !p.isActive && p.priceMinor === 0 && p.type === "SHOP_SKIN")).toBe(true);
    expect(rows.some((p) => /Case$|Capsule|Package|Box|Key$/.test(p.title))).toBe(false);
    const ak = rows.find((p) => p.slug === "cs2-35181112001")!;
    expect(ak.skin).toMatchObject({ float: 0.1234, pattern: 661, exterior: "Field-Tested" });
    expect(inspected[0]).toContain(`S${bot.steamId}A35181112001`);

    // повторная синхронизация не дублирует и не перезапрашивает float
    const again = await syncBotInventory(bot.id, "CS2", items, floats, bot.steamId);
    expect(again).toMatchObject({ added: 0, updated: 5 });
    expect(inspected.length).toBe(1); // inspect-ссылка только у AK; повторно float не запрашивается
  });

  it("скин, ушедший из инвентаря, скрывается; проданный не трогается", async () => {
    const bot = await upsertBotAccount("bot1", "76561190000000001");
    await syncBotInventory(bot.id, "CS2", [cs2Items.akRedlineFT, cs2Items.karambitFade]);
    await db.update(products).set({ isActive: true, priceMinor: 100_00 });
    await db.update(products).set({ soldAt: new Date() }).where(eq(products.slug, "cs2-35181112003"));
    const r = await syncBotInventory(bot.id, "CS2", []);
    expect(r.removed).toBe(1);
    const [ak] = await db.select().from(products).where(eq(products.slug, "cs2-35181112001"));
    const [knife] = await db.select().from(products).where(eq(products.slug, "cs2-35181112003"));
    expect(ak.isActive).toBe(false);
    expect(knife.isActive).toBe(true);
  });

  it("без цены скин показать нельзя", async () => {
    const bot = await upsertBotAccount("bot1", "76561190000000001");
    await syncBotInventory(bot.id, "CS2", [cs2Items.akRedlineFT]);
    const [p] = await db.select().from(products);
    const [admin] = await db.insert(users).values({ email: "a@test.kg", role: "ADMIN" }).returning();
    await expect(setProductActive(admin, p.id, true)).rejects.toThrow(/цену/);
    expect(await getCatalogIds()).not.toContain(p.id);
  });
});

// ---------- Очередь трейдов ----------

let seq = 1;
async function setupPaidSkinOrders(n: number, tokenFor: (i: number) => string = () => "OkToken1") {
  const bot = await upsertBotAccount("bot1", "76561190000000001");
  const assets = [cs2Items.akRedlineFT, cs2Items.akCaseHardenedST, cs2Items.karambitFade, cs2Items.agent, cs2Items.sticker].slice(0, n);
  await syncBotInventory(bot.id, "CS2", assets);
  await db.update(products).set({ isActive: true, priceMinor: 1_000_00 });
  const list = await db.select().from(products).orderBy(products.slug);
  const result: { orderId: string; productId: string; tradeUrl: string }[] = [];
  for (let i = 0; i < n; i++) {
    const accountId = 500_000 + seq++;
    const steamId = (BigInt("76561197960265728") + BigInt(accountId)).toString();
    const [u] = await db.insert(users).values({ steamId }).returning();
    const tradeUrl = `https://steamcommunity.com/tradeoffer/new/?partner=${accountId}&token=${tokenFor(i)}`;
    const order = await createOrder(
      { productSlug: list[i].slug, email: `b${accountId}@test.kg`, tradeUrl, adultConfirmed: true, offerAccepted: true },
      { userId: u.id, steamApi: permissiveSteamApi },
    );
    await pay(order.id);
    result.push({ orderId: order.id, productId: list[i].id, tradeUrl });
  }
  return { bot, orders: result };
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
  expect((await handlePaymentWebhook("mock", body, h)).result).toBe("paid_awaiting_delivery");
}

const orderStatus = async (id: string) => (await db.select().from(orders).where(eq(orders.id, id)))[0].status;
const offerOf = async (orderId: string) =>
  (await db.execute<{ status: string; attempts: number; last_error: string | null; id: string }>(
    sql`select t.* from trade_offers t join order_items oi on oi.id = t.order_item_id where oi.order_id = ${orderId}`,
  )).rows[0];
const templates = async () => (await db.select({ t: emailOutbox.template }).from(emailOutbox)).map((r) => r.t);

describe("очередь трейд-офферов", () => {
  it("оплачен → трейд отправлен (письмо) → принят → выдан", async () => {
    const { bot, orders: [o] } = await setupPaidSkinOrders(1);
    expect(await orderStatus(o.orderId)).toBe("PAID");
    const client = new MockBotClient(bot.steamId, 0);
    expect(await processTradeQueue({ [bot.id]: client })).toMatchObject({ sent: 1 });
    expect(await orderStatus(o.orderId)).toBe("TRADE_SENT");
    expect(await templates()).toContain("tradeSent");
    expect(await pollSentOffers({ [bot.id]: client })).toMatchObject({ accepted: 1 });
    expect(await orderStatus(o.orderId)).toBe("DELIVERED");
    expect((await offerOf(o.orderId)).status).toBe("ACCEPTED");
  });

  it("сбой одного трейда не останавливает очередь", async () => {
    const { bot, orders: os } = await setupPaidSkinOrders(4, (i) => (i === 1 ? "failToken" : "OkToken1"));
    const mock = new MockBotClient(bot.steamId, 0);
    // второй оффер — сбой Steam, третий — неожиданное исключение клиента
    const client: BotClient = {
      steamId: bot.steamId,
      getInventory: (a) => mock.getInventory(a),
      getOfferState: (id) => mock.getOfferState(id),
      cancelOffer: (id) => mock.cancelOffer(id),
      sendOffer: async (p) => {
        if (p.assetId === cs2Items.karambitFade.assetid) throw new TypeError("Cannot read properties of undefined");
        return mock.sendOffer(p);
      },
    };
    const r = await processTradeQueue({ [bot.id]: client });
    expect(r).toMatchObject({ sent: 2, retry: 2 });
    const statuses = await Promise.all(os.map((o) => orderStatus(o.orderId)));
    expect(statuses.filter((s) => s === "TRADE_SENT")).toHaveLength(2);
    expect(statuses.filter((s) => s === "PAID")).toHaveLength(2); // ждут повтора
  });

  it("временная ошибка — повторы с паузой, после лимита — «Проблема» и письмо", async () => {
    const { bot, orders: [o] } = await setupPaidSkinOrders(1, () => "failToken");
    const clients = { [bot.id]: new MockBotClient(bot.steamId, 0) };
    await processTradeQueue(clients);
    const first = await offerOf(o.orderId);
    expect(first).toMatchObject({ status: "QUEUED", attempts: 1 });
    // до паузы повторно не берется
    expect(await processTradeQueue(clients)).toMatchObject({ sent: 0, retry: 0, failed: 0 });
    for (let i = 1; i < MAX_TRADE_ATTEMPTS; i++) {
      await db.update(tradeOffers).set({ nextAttemptAt: new Date(Date.now() - 1000) });
      await processTradeQueue(clients);
    }
    expect(await offerOf(o.orderId)).toMatchObject({ status: "FAILED", attempts: MAX_TRADE_ATTEMPTS });
    expect(await orderStatus(o.orderId)).toBe("PROBLEM");
    expect(await templates()).toContain("deliveryProblem");
  });

  it("постоянная ошибка (нет предмета у бота) — сразу «Проблема»", async () => {
    const { bot, orders: [o] } = await setupPaidSkinOrders(1);
    const client: BotClient = {
      ...new MockBotClient(bot.steamId, 0),
      steamId: bot.steamId,
      getInventory: async () => [],
      getOfferState: async () => "Active" as OfferState,
      cancelOffer: async () => {},
      sendOffer: async () => {
        throw new BotError("Trade ban (EResult 15)", true);
      },
    };
    expect(await processTradeQueue({ [bot.id]: client })).toMatchObject({ failed: 1 });
    expect(await orderStatus(o.orderId)).toBe("PROBLEM");
  });

  it("бот не в сети — трейд ждет, попытка не списывается", async () => {
    const { orders: [o] } = await setupPaidSkinOrders(1);
    expect(await processTradeQueue({})).toMatchObject({ retry: 1 });
    expect(await offerOf(o.orderId)).toMatchObject({ status: "QUEUED", attempts: 0, last_error: "bot_offline" });
  });

  it("отклонен покупателем — «Проблема»; возврат из админки возвращает скин в каталог", async () => {
    const { bot, orders: [o] } = await setupPaidSkinOrders(1, () => "declineTok");
    const clients = { [bot.id]: new MockBotClient(bot.steamId, 0) };
    await processTradeQueue(clients);
    expect(await pollSentOffers(clients)).toMatchObject({ declined: 1 });
    expect(await orderStatus(o.orderId)).toBe("PROBLEM");

    const [admin] = await db.insert(users).values({ email: "adm@test.kg", role: "ADMIN" }).returning();
    await refundOrder(admin, o.orderId, "трейд отклонен");
    expect(await orderStatus(o.orderId)).toBe("REFUNDED");
    expect(await getCatalogIds()).toContain(o.productId);
  });

  it("не принят за tradeAcceptHours — оффер отменяется, заказ в «Проблема»", async () => {
    const { bot, orders: [o] } = await setupPaidSkinOrders(1);
    const client = new MockBotClient(bot.steamId, 10 * 3_600_000 * 100); // «висит» долго
    await processTradeQueue({ [bot.id]: client });
    expect(await pollSentOffers({ [bot.id]: client })).toMatchObject({ waiting: 1 });
    await db.update(tradeOffers).set({ sentAt: new Date(Date.now() - 25 * 3_600_000) }); // по умолчанию 24 ч
    expect(await pollSentOffers({ [bot.id]: client })).toMatchObject({ timedOut: 1 });
    expect(await orderStatus(o.orderId)).toBe("PROBLEM");
    const off = await offerOf(o.orderId);
    expect(off.status).toBe("DECLINED");
    expect(await client.getOfferState((await db.select().from(tradeOffers))[0].steamOfferId!)).toBe("Canceled");
  });

  it("trade hold: оффер IN_ESCROW, заказ остается «Трейд отправлен» и не уходит в таймаут", async () => {
    const { bot, orders: [o] } = await setupPaidSkinOrders(1, () => "holdToken");
    const clients = { [bot.id]: new MockBotClient(bot.steamId, 0) };
    await processTradeQueue(clients);
    expect(await pollSentOffers(clients)).toMatchObject({ escrow: 1 });
    await db.update(tradeOffers).set({ sentAt: new Date(Date.now() - 10 * 24 * 3_600_000) });
    expect(await pollSentOffers(clients)).toMatchObject({ escrow: 1, timedOut: 0 });
    expect(await orderStatus(o.orderId)).toBe("TRADE_SENT");
  });

  it("возврат при висящем оффере — воркер отменяет оффер", async () => {
    const { bot, orders: [o] } = await setupPaidSkinOrders(1);
    const client = new MockBotClient(bot.steamId, 3_600_000);
    await processTradeQueue({ [bot.id]: client });
    const [admin] = await db.insert(users).values({ email: "adm2@test.kg", role: "ADMIN" }).returning();
    await refundOrder(admin, o.orderId, "передумал");
    expect(await pollSentOffers({ [bot.id]: client })).toMatchObject({ cancelledRefund: 1 });
  });

  it("повтор упавшего трейда из админки", async () => {
    const { bot, orders: [o] } = await setupPaidSkinOrders(1);
    const failing: BotClient = {
      steamId: bot.steamId,
      getInventory: async () => [],
      getOfferState: async () => "Active",
      cancelOffer: async () => {},
      sendOffer: async () => {
        throw new BotError("Steam недоступен", true);
      },
    };
    await processTradeQueue({ [bot.id]: failing });
    expect(await orderStatus(o.orderId)).toBe("PROBLEM");
    const [support] = await db.insert(users).values({ email: "sup@test.kg", role: "SUPPORT" }).returning();
    await requeueTradeOffer(support, (await offerOf(o.orderId)).id);
    expect(await orderStatus(o.orderId)).toBe("PAID");
    expect(await processTradeQueue({ [bot.id]: new MockBotClient(bot.steamId, 0) })).toMatchObject({ sent: 1 });
  });
});
