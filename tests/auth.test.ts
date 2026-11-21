import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { emailOutbox, loginTokens, mockProviderPayments, orders, payments, productKeys, products, sessions, users } from "@/db/schema";
import { decrypt, encrypt, sha256 } from "@/lib/crypto";
import { createSession, deleteSessionByCookie, getUserBySessionCookie, verifySessionCookie } from "@/lib/auth/session";
import {
  buildSteamLoginUrl,
  STEAM_OPENID_ENDPOINT,
  steamCallbackUrl,
  upsertSteamUser,
  verifySteamResponse,
} from "@/lib/auth/steam-openid";
import { consumeEmailLogin, requestEmailLogin, safeNextPath } from "@/lib/auth/email-login";
import { parseTradeUrl } from "@/lib/auth/steam-id";
import { getUserOrder, listUserOrders, saveTradeUrl } from "@/lib/account";
import { hitRateLimit, isHoneypotTripped } from "@/lib/security/rate-limit";
import { createOrder, handlePaymentWebhook } from "@/lib/orders/service";
import { signMockWebhook, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "@/lib/payments/mock-elqr";
import { middleware } from "@/middleware";

beforeEach(async () => {
  await db.execute(sql`truncate table settings, sessions, login_tokens, rate_limits, users, webhook_events, email_outbox, refunds,
    trade_offers, payments, product_keys, order_items, orders, products, mock_provider_payments, audit_log cascade`);
});

async function newUser(values: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await db.insert(users).values(values).returning();
  return u;
}

// ---------- Сессии ----------

describe("сессии", () => {
  it("создает сессию и находит по cookie", async () => {
    const u = await newUser({ email: "a@test.kg" });
    const { cookieValue } = await createSession(u.id);
    expect((await getUserBySessionCookie(cookieValue))?.id).toBe(u.id);
    // в базе только хэш токена
    const [row] = await db.select().from(sessions);
    expect(cookieValue.startsWith(row.id)).toBe(false);
  });

  it("отклоняет подделанную подпись и чужой токен", async () => {
    const u = await newUser();
    const { cookieValue } = await createSession(u.id);
    const [token] = cookieValue.split(".");
    expect(verifySessionCookie(`${token}.AAAA`)).toBeNull();
    expect(await getUserBySessionCookie(`${token}x.${cookieValue.split(".")[1]}`)).toBeNull();
    expect(await getUserBySessionCookie(token)).toBeNull();
    expect(await getUserBySessionCookie(undefined)).toBeNull();
  });

  it("просроченная сессия, выход и блокировка закрывают доступ", async () => {
    const u = await newUser();
    const a = await createSession(u.id);
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await getUserBySessionCookie(a.cookieValue)).toBeNull();

    const b = await createSession(u.id);
    await deleteSessionByCookie(b.cookieValue);
    expect(await getUserBySessionCookie(b.cookieValue)).toBeNull();

    const c = await createSession(u.id);
    await db.update(users).set({ isBlocked: true }).where(eq(users.id, u.id));
    expect(await getUserBySessionCookie(c.cookieValue)).toBeNull();
  });
});

// ---------- Steam OpenID ----------

const STEAM_ID = "76561198000000001";
const STATE = "state-abc";

function steamResponse(overrides: Record<string, string> = {}) {
  const claimed = `https://steamcommunity.com/openid/id/${STEAM_ID}`;
  return new URLSearchParams({
    state: STATE,
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": STEAM_OPENID_ENDPOINT,
    "openid.claimed_id": claimed,
    "openid.identity": claimed,
    "openid.return_to": steamCallbackUrl(STATE),
    "openid.response_nonce": "2026-11-21T10:00:00ZabcDEF",
    "openid.assoc_handle": "1234567890",
    "openid.signed": "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "c2lnbmF0dXJl",
    ...overrides,
  });
}

function steamFetch(body: string) {
  return vi.fn(async (...args: [string, RequestInit?]) => {
    void args;
    return new Response(body, { status: 200 });
  });
}

describe("вход через Steam OpenID", () => {
  it("ссылка входа ведет на Steam с нашим return_to", () => {
    const url = new URL(buildSteamLoginUrl(STATE));
    expect(url.origin + url.pathname).toBe(STEAM_OPENID_ENDPOINT);
    expect(url.searchParams.get("openid.return_to")).toBe(steamCallbackUrl(STATE));
  });

  it("принимает ответ, подтвержденный check_authentication", async () => {
    const f = steamFetch("ns:http://specs.openid.net/auth/2.0\nis_valid:true\n");
    const r = await verifySteamResponse(steamResponse(), STATE, f);
    expect(r).toEqual({ ok: true, steamId: STEAM_ID });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(STEAM_OPENID_ENDPOINT);
    const sent = new URLSearchParams(String(init?.body));
    expect(sent.get("openid.mode")).toBe("check_authentication");
    expect(sent.get("openid.sig")).toBe("c2lnbmF0dXJl");
    expect(sent.has("state")).toBe(false);
  });

  it("отклоняет подделанный ответ: Steam вернул is_valid:false", async () => {
    const f = steamFetch("ns:http://specs.openid.net/auth/2.0\nis_valid:false\n");
    const forged = steamResponse({ "openid.sig": "forged" });
    expect(await verifySteamResponse(forged, STATE, f)).toEqual({ ok: false, reason: "check_invalid" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("отклоняет ответ, если Steam недоступен или отвечает ошибкой", async () => {
    const down = vi.fn(async () => {
      throw new Error("network");
    });
    expect((await verifySteamResponse(steamResponse(), STATE, down)).ok).toBe(false);
    const err = vi.fn(async () => new Response("is_valid:true", { status: 500 }));
    expect((await verifySteamResponse(steamResponse(), STATE, err)).ok).toBe(false);
  });

  it.each([
    ["чужой state (login CSRF)", {}, "other-state", "state"],
    ["чужой op_endpoint", { "openid.op_endpoint": "https://evil.example/openid/login" }, STATE, "op_endpoint"],
    ["claimed_id другого сайта", { "openid.claimed_id": `https://evil.example/openid/id/${STEAM_ID}`, "openid.identity": `https://evil.example/openid/id/${STEAM_ID}` }, STATE, "claimed_id"],
    ["claimed_id не совпадает с identity", { "openid.identity": "https://steamcommunity.com/openid/id/76561198000000002" }, STATE, "claimed_id"],
    ["чужой return_to", { "openid.return_to": "https://evil.example/cb" }, STATE, "return_to"],
    ["claimed_id не подписан", { "openid.signed": "signed,op_endpoint,identity,return_to,response_nonce,assoc_handle" }, STATE, "unsigned_claimed_id"],
    ["mode не id_res", { "openid.mode": "cancel" }, STATE, "mode"],
  ] as const)("отклоняет без запроса к Steam: %s", async (_name, overrides, expectedState, reason) => {
    const f = steamFetch("is_valid:true\n");
    const r = await verifySteamResponse(steamResponse(overrides), expectedState, f);
    expect(r).toEqual({ ok: false, reason });
    expect(f).not.toHaveBeenCalled();
  });

  it("создает пользователя один раз и обновляет профиль", async () => {
    const a = await upsertSteamUser(STEAM_ID, { personaName: "Rin", avatarUrl: "https://a/x.jpg" });
    const b = await upsertSteamUser(STEAM_ID, { personaName: "Rin2", avatarUrl: null });
    expect(b.id).toBe(a.id);
    const all = await db.select().from(users);
    expect(all).toHaveLength(1);
    expect(all[0].displayName).toBe("Rin2");
  });
});

// ---------- Вход по email ----------

async function lastLoginToken(email: string): Promise<string> {
  const rows = await db.select().from(emailOutbox).where(eq(emailOutbox.to, email));
  const body = decrypt(rows[rows.length - 1].encryptedBody);
  const m = /token=([\w-]+)/.exec(body);
  if (!m) throw new Error("no token in email");
  return m[1];
}

describe("вход по email", () => {
  it("одноразовая ссылка: создает пользователя, второй раз не работает", async () => {
    await requestEmailLogin("Buyer@Test.KG", { next: "/account" });
    const [tok] = await db.select().from(loginTokens);
    expect(tok.email).toBe("buyer@test.kg");
    const token = await lastLoginToken("buyer@test.kg");
    expect(tok.tokenHash).toBe(sha256(token)); // в базе только хэш

    const r = await consumeEmailLogin(token);
    expect(r.next).toBe("/account");
    const [u] = await db.select().from(users).where(eq(users.id, r.userId));
    expect(u.email).toBe("buyer@test.kg");
    expect(u.emailVerifiedAt).not.toBeNull();

    await expect(consumeEmailLogin(token)).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("ссылка старше 15 минут не работает", async () => {
    await requestEmailLogin("late@test.kg");
    const token = await lastLoginToken("late@test.kg");
    await db.update(loginTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    await expect(consumeEmailLogin(token)).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    await expect(consumeEmailLogin("garbage")).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("не больше 3 ссылок на email за 15 минут", async () => {
    for (let i = 0; i < 3; i++) await requestEmailLogin("spam@test.kg");
    await expect(requestEmailLogin("spam@test.kg")).rejects.toMatchObject({ code: "RATE_LIMIT" });
  });

  it("привязывает гостевые заказы с подтвержденным email и не трогает чужие", async () => {
    const p = await seedKeyProduct(3);
    const mine = await createOrder({ productSlug: p.slug, email: "guest@test.kg", adultConfirmed: true, offerAccepted: true });
    const other = await createOrder({ productSlug: p.slug, email: "other@test.kg", adultConfirmed: true, offerAccepted: true });

    await requestEmailLogin("guest@test.kg");
    const r = await consumeEmailLogin(await lastLoginToken("guest@test.kg"));
    expect(r.attachedOrders).toBe(1);

    const list = await listUserOrders(r.userId);
    expect(list.map((o) => o.id)).toEqual([mine.id]);
    const [o2] = await db.select().from(orders).where(eq(orders.id, other.id));
    expect(o2.userId).toBeNull();
  });

  it("Steam-пользователь подтверждает email; занятый email привязать нельзя", async () => {
    const steamUser = await newUser({ steamId: STEAM_ID });
    await requestEmailLogin("s@test.kg", { linkToUserId: steamUser.id });
    const r = await consumeEmailLogin(await lastLoginToken("s@test.kg"));
    expect(r.userId).toBe(steamUser.id);

    await newUser({ email: "taken@test.kg", emailVerifiedAt: new Date() });
    await requestEmailLogin("taken@test.kg", { linkToUserId: steamUser.id });
    await expect(consumeEmailLogin(await lastLoginToken("taken@test.kg"))).rejects.toMatchObject({ code: "EMAIL_TAKEN" });
  });

  it("next разрешает только внутренние пути", () => {
    expect(safeNextPath("/account/orders/1")).toBe("/account/orders/1");
    expect(safeNextPath("//evil.example")).toBe("/account");
    expect(safeNextPath("https://evil.example")).toBe("/account");
    expect(safeNextPath("/\\evil.example")).toBe("/account");
  });
});

// ---------- Доступ к заказам и ключам ----------

async function seedKeyProduct(keys = 2) {
  const slug = `key-${randomUUID().slice(0, 8)}`;
  const [p] = await db
    .insert(products)
    .values({ slug, type: "GAME_KEY", game: "OTHER", title: "Ключ " + slug, deliveryMethod: "KEY", deliveryEta: "Сразу", priceMinor: 500_00 })
    .returning();
  for (let i = 0; i < keys; i++) {
    const code = `CODE-${randomUUID()}`;
    await db.insert(productKeys).values({ productId: p.id, encryptedCode: encrypt(code), codeHash: sha256(code) });
  }
  return p;
}

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
  expect((await handlePaymentWebhook("mock", body, headers)).result).toBe("paid_delivered");
}

describe("кабинет: доступ только к своему", () => {
  it("чужой заказ и чужие ключи недоступны", async () => {
    const alice = await newUser({ email: "alice@test.kg", emailVerifiedAt: new Date() });
    const bob = await newUser({ email: "bob@test.kg", emailVerifiedAt: new Date() });
    const p = await seedKeyProduct(2);
    const order = await createOrder(
      { productSlug: p.slug, email: "alice@test.kg", adultConfirmed: true, offerAccepted: true },
      { userId: alice.id },
    );
    await payOrder(order.id);

    const own = await getUserOrder(alice.id, order.id);
    expect(own?.keys).toHaveLength(1);
    expect(own?.keys[0].code).toMatch(/^CODE-/);

    expect(await getUserOrder(bob.id, order.id)).toBeNull();
    expect(await listUserOrders(bob.id)).toHaveLength(0);
    expect(await getUserOrder(bob.id, "not-a-uuid")).toBeNull();
  });
});

describe("trade-ссылка", () => {
  const own = `https://steamcommunity.com/tradeoffer/new/?partner=${BigInt(STEAM_ID) - BigInt("76561197960265728")}&token=AbC123xy`;

  it("сохраняется только своя", async () => {
    expect(parseTradeUrl(own)?.steamId).toBe(STEAM_ID);
    const u = await newUser({ steamId: STEAM_ID });
    await expect(saveTradeUrl(u.id, "https://steamcommunity.com/tradeoffer/new/?partner=1&token=AbC123xy")).rejects.toThrow(
      /другому аккаунту/,
    );
    await expect(saveTradeUrl(u.id, "https://evil.example")).rejects.toThrow();
    await saveTradeUrl(u.id, own);
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row.tradeUrl).toBe(own);
  });

  it("без Steam сохранить нельзя", async () => {
    const u = await newUser({ email: "x@test.kg" });
    await expect(saveTradeUrl(u.id, own)).rejects.toThrow(/Steam/);
  });
});

// ---------- Редирект и защита форм ----------

describe("кабинет без входа", () => {
  it("редиректит на /login с возвратом", () => {
    const res = middleware(new NextRequest("http://localhost:3000/account/orders/123"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next")).toBe("/account/orders/123");
  });
  it("пропускает при наличии cookie (подпись проверяет сервер)", () => {
    const req = new NextRequest("http://localhost:3000/account", { headers: { cookie: "pg_session=abc.def" } });
    expect(middleware(req).headers.get("location")).toBeNull();
  });
});

describe("защита форм", () => {
  it("ограничение частоты по ключу", async () => {
    const key = `ip:test:${randomUUID()}`;
    expect(await hitRateLimit(key, 2, 60)).toBe(true);
    expect(await hitRateLimit(key, 2, 60)).toBe(true);
    expect(await hitRateLimit(key, 2, 60)).toBe(false);
    // окно истекло — счетчик сбрасывается
    await db.execute(sql`update rate_limits set window_ends_at = now() - interval '1 second' where key = ${key}`);
    expect(await hitRateLimit(key, 2, 60)).toBe(true);
  });
  it("honeypot", () => {
    const f = new FormData();
    expect(isHoneypotTripped(f)).toBe(false);
    f.set("website", "http://spam");
    expect(isHoneypotTripped(f)).toBe(true);
  });
});
