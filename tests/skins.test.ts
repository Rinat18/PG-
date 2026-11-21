import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { mockProviderPayments, orders, payments, products, tradeOffers, users } from "@/db/schema";
import { cancelPendingOrderByBuyer, createOrder, handlePaymentWebhook, type CreateOrderContext } from "@/lib/orders/service";
import { httpSteamApi, type SteamApi } from "@/lib/steam/buyer-checks";
import { getProduct, listProducts } from "@/lib/catalog";
import { signMockWebhook, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "@/lib/payments/mock-elqr";

beforeEach(async () => {
  await db.execute(sql`truncate table settings, sessions, login_tokens, rate_limits, users, webhook_events, email_outbox, refunds,
    trade_offers, payments, product_keys, order_items, orders, products, mock_provider_payments, audit_log cascade`);
});

const BASE = BigInt("76561197960265728");
let seq = 1;

async function steamBuyer() {
  const accountId = 100_000 + seq++;
  const steamId = (BASE + BigInt(accountId)).toString();
  const [u] = await db.insert(users).values({ steamId, displayName: `buyer${accountId}` }).returning();
  return { user: u, tradeUrl: `https://steamcommunity.com/tradeoffer/new/?partner=${accountId}&token=Tok${accountId}` };
}

async function seedSkin(game: "CS2" | "DOTA2" = "CS2") {
  const [p] = await db
    .insert(products)
    .values({
      slug: `skin-${randomUUID().slice(0, 8)}`,
      type: "SHOP_SKIN",
      game,
      title: "AK-47 | Redline (Field-Tested)",
      deliveryMethod: "TRADE_OFFER",
      deliveryEta: "До 30 минут",
      priceMinor: 2_000_00,
      skin: { marketHashName: "AK-47 | Redline (Field-Tested)", exterior: "Field-Tested", float: 0.21 },
    })
    .returning();
  return p;
}

function fakeSteam(over: Partial<{ ban: string; holdDays: number | null; publicInv: boolean; down: boolean; delayMs: number }> = {}) {
  const o = { ban: "none", holdDays: 0, publicInv: true, down: false, delayMs: 0, ...over };
  const wait = () => new Promise((r) => setTimeout(r, o.delayMs));
  const api: SteamApi = {
    getEconomyBan: vi.fn(async () => (await wait(), o.down ? { ok: false as const, unavailable: true as const } : { ok: true as const, value: o.ban })),
    getTradeHoldDays: vi.fn(async () => (await wait(), { ok: true as const, value: o.holdDays })),
    isInventoryPublic: vi.fn(async () => (await wait(), { ok: true as const, value: o.publicInv })),
  };
  return api;
}

function buy(slug: string, userId: string | undefined, tradeUrl: string | undefined, steamApi: SteamApi | null) {
  const ctx: CreateOrderContext = { userId, steamApi };
  return createOrder(
    { productSlug: slug, email: `b${randomUUID().slice(0, 6)}@test.kg`, tradeUrl, adultConfirmed: true, offerAccepted: true },
    ctx,
  );
}

async function orderCount() {
  return (await db.select().from(orders)).length;
}

describe("покупка скина: проверки до QR", () => {
  it("без входа и без Steam-аккаунта купить нельзя", async () => {
    const p = await seedSkin();
    const { tradeUrl } = await steamBuyer();
    await expect(buy(p.slug, undefined, tradeUrl, fakeSteam())).rejects.toMatchObject({ code: "STEAM_LOGIN_REQUIRED" });
    const [emailOnly] = await db.insert(users).values({ email: "e@test.kg" }).returning();
    await expect(buy(p.slug, emailOnly.id, tradeUrl, fakeSteam())).rejects.toMatchObject({ code: "STEAM_LOGIN_REQUIRED" });
    expect(await orderCount()).toBe(0);
  });

  it("с чужой trade-ссылкой купить нельзя (Steam даже не опрашивается)", async () => {
    const p = await seedSkin();
    const me = await steamBuyer();
    const stranger = await steamBuyer();
    const api = fakeSteam();
    await expect(buy(p.slug, me.user.id, stranger.tradeUrl, api)).rejects.toMatchObject({ code: "TRADE_URL" });
    expect(api.getEconomyBan).not.toHaveBeenCalled();
    expect(await orderCount()).toBe(0);
  });

  it("trade-ссылка обязательна", async () => {
    const p = await seedSkin();
    const me = await steamBuyer();
    await expect(buy(p.slug, me.user.id, undefined, fakeSteam())).rejects.toMatchObject({ code: "TRADE_URL" });
  });

  it("при закрытом инвентаре заказ не создается и скин не резервируется", async () => {
    const p = await seedSkin();
    const me = await steamBuyer();
    await expect(buy(p.slug, me.user.id, me.tradeUrl, fakeSteam({ publicInv: false }))).rejects.toMatchObject({
      code: "INVENTORY_PRIVATE",
    });
    expect(await orderCount()).toBe(0);
    expect((await getProduct(p.slug))!.isReserved).toBe(false);
  });

  it("трейд-бан и устаревший токен ссылки отклоняются", async () => {
    const p = await seedSkin();
    const me = await steamBuyer();
    await expect(buy(p.slug, me.user.id, me.tradeUrl, fakeSteam({ ban: "banned" }))).rejects.toMatchObject({ code: "TRADE_BAN" });
    await expect(buy(p.slug, me.user.id, me.tradeUrl, fakeSteam({ ban: "probation" }))).rejects.toMatchObject({ code: "TRADE_BAN" });
    await expect(buy(p.slug, me.user.id, me.tradeUrl, fakeSteam({ holdDays: null }))).rejects.toMatchObject({ code: "TRADE_URL" });
    expect(await orderCount()).toBe(0);
  });

  it("Steam недоступен или ключа нет — понятная ошибка, заказа нет", async () => {
    const p = await seedSkin();
    const me = await steamBuyer();
    await expect(buy(p.slug, me.user.id, me.tradeUrl, fakeSteam({ down: true }))).rejects.toMatchObject({ code: "STEAM_UNAVAILABLE" });
    await expect(buy(p.slug, me.user.id, me.tradeUrl, null)).rejects.toMatchObject({
      code: "STEAM_UNAVAILABLE",
      message: expect.stringContaining("Заказ не создан"),
    });
    expect(await orderCount()).toBe(0);
  });
});

describe("покупка скина: резерв, оплата, очередь трейдов", () => {
  it("резервирует скин, после оплаты — «Оплачен» и трейд в очереди", async () => {
    const p = await seedSkin("DOTA2");
    const me = await steamBuyer();
    const order = await buy(p.slug, me.user.id, me.tradeUrl, fakeSteam({ holdDays: 7 }));
    expect(order.tradeHoldDays).toBe(7);
    expect(order.tradeUrl).toBe(me.tradeUrl);

    // скин пропал из каталога, ссылка сохранена в профиль
    expect((await getProduct(p.slug))!.isReserved).toBe(true);
    expect((await listProducts({ game: "DOTA2" })).find((x) => x.id === p.id)).toBeUndefined();
    const [u] = await db.select().from(users).where(eq(users.id, me.user.id));
    expect(u.tradeUrl).toBe(me.tradeUrl);

    await payOrder(order.id);
    const [o] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(o.status).toBe("PAID");
    const offers = await db.select().from(tradeOffers);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ status: "QUEUED", tradeUrl: me.tradeUrl });
    const [sold] = await db.select().from(products).where(eq(products.id, p.id));
    expect(sold.soldAt).not.toBeNull();
  });

  it("сохраненная в профиле trade-ссылка подставляется сама", async () => {
    const p = await seedSkin();
    const me = await steamBuyer();
    await db.update(users).set({ tradeUrl: me.tradeUrl }).where(eq(users.id, me.user.id));
    const order = await buy(p.slug, me.user.id, undefined, fakeSteam());
    expect(order.tradeUrl).toBe(me.tradeUrl);
  });

  it("отмена покупателем снимает резерв", async () => {
    const p = await seedSkin();
    const me = await steamBuyer();
    const order = await buy(p.slug, me.user.id, me.tradeUrl, fakeSteam());
    expect(await cancelPendingOrderByBuyer(order.accessToken)).toBe(true);
    expect(await cancelPendingOrderByBuyer(order.accessToken)).toBe(false);
    const [o] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(o.status).toBe("CANCELLED");
    expect((await getProduct(p.slug))!.isReserved).toBe(false);
    // скин снова можно купить
    const other = await steamBuyer();
    await expect(buy(p.slug, other.user.id, other.tradeUrl, fakeSteam())).resolves.toBeTruthy();
  });

  it("гонка: один скин нельзя оплатить двумя заказами одновременно", async () => {
    const p = await seedSkin();
    const buyers = await Promise.all([steamBuyer(), steamBuyer(), steamBuyer(), steamBuyer()]);
    // задержка Steam: все покупатели проходят проверки «одновременно», до резерва
    const results = await Promise.allSettled(buyers.map((b) => buy(p.slug, b.user.id, b.tradeUrl, fakeSteam({ delayMs: 30 }))));

    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    for (const f of failed) expect(f.reason).toMatchObject({ code: "OUT_OF_STOCK" });

    // заказы проигравших откатываются вместе с транзакцией резерва, QR создан только один
    expect(await db.select().from(payments)).toHaveLength(1);
    const pending = await db.select().from(orders).where(eq(orders.status, "PENDING_PAYMENT"));
    expect(pending).toHaveLength(1);
    const [prod] = await db.select().from(products).where(eq(products.id, p.id));
    expect(prod.reservedByOrderId).toBe(pending[0].id);
  });
});

describe("Steam Web API: разбор ответов", () => {
  const STEAM_ID = "76561198000000001";
  const route = (map: Record<string, Response | Error>) =>
    vi.fn(async (url: string) => {
      const key = Object.keys(map).find((k) => url.includes(k));
      const v = key ? map[key] : new Response("", { status: 404 });
      if (v instanceof Error) throw v;
      return v.clone();
    });

  it("закрытый инвентарь — 403, лимит Steam — «недоступно»", async () => {
    expect(await httpSteamApi("k", route({ "/inventory/": new Response("null", { status: 403 }) })).isInventoryPublic(STEAM_ID, 730)).toEqual({
      ok: true,
      value: false,
    });
    expect(await httpSteamApi("k", route({ "/inventory/": new Response("{}", { status: 200 }) })).isInventoryPublic(STEAM_ID, 730)).toEqual({
      ok: true,
      value: true,
    });
    expect((await httpSteamApi("k", route({ "/inventory/": new Response("", { status: 429 }) })).isInventoryPublic(STEAM_ID, 730)).ok).toBe(false);
    expect((await httpSteamApi("k", route({ "/inventory/": new Error("net") })).isInventoryPublic(STEAM_ID, 730)).ok).toBe(false);
  });

  it("трейд-бан и trade hold", async () => {
    const api = httpSteamApi(
      "k",
      route({
        GetPlayerBans: Response.json({ players: [{ SteamId: STEAM_ID, EconomyBan: "banned" }] }),
        GetTradeHoldDurations: Response.json({ response: { their_escrow: { escrow_end_duration_seconds: 15 * 86400 } } }),
      }),
    );
    expect(await api.getEconomyBan(STEAM_ID)).toEqual({ ok: true, value: "banned" });
    expect(await api.getTradeHoldDays(STEAM_ID, "tok")).toEqual({ ok: true, value: 15 });

    const badToken = httpSteamApi("k", route({ GetTradeHoldDurations: Response.json({ response: {} }) }));
    expect(await badToken.getTradeHoldDays(STEAM_ID, "tok")).toEqual({ ok: true, value: null });
  });
});

async function payOrder(orderId: string) {
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
  const headers = new Headers({
    [SIGNATURE_HEADER]: signMockWebhook(process.env.MOCK_ELQR_WEBHOOK_SECRET!, body, ts),
    [TIMESTAMP_HEADER]: String(ts),
  });
  expect((await handlePaymentWebhook("mock", body, headers)).result).toBe("paid_awaiting_delivery");
}
