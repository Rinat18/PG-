import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { emailOutbox, mockProviderPayments, orders, payments, productKeys, products, refunds, tradeOffers } from "@/db/schema";
import { encrypt, sha256 } from "@/lib/crypto";
import { decrypt } from "@/lib/crypto";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signMockWebhook,
  verifyMockSignature,
} from "@/lib/payments/mock-elqr";
import { createOrder, expireStaleOrders, getOrderForBuyer, handlePaymentWebhook, OrderError } from "@/lib/orders/service";

const secret = process.env.MOCK_ELQR_WEBHOOK_SECRET!;

function signedHeaders(rawBody: string, ts = Math.floor(Date.now() / 1000), sig?: string) {
  return new Headers({
    "content-type": "application/json",
    [SIGNATURE_HEADER]: sig ?? signMockWebhook(secret, rawBody, ts),
    [TIMESTAMP_HEADER]: String(ts),
  });
}

function successBody(paymentId: string, amount: number, eventId = `evt_${randomUUID()}`, occurredAt = new Date()) {
  return JSON.stringify({ eventId, paymentId, status: "SUCCEEDED", amount, currency: "KGS", occurredAt: occurredAt.toISOString() });
}

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

async function newPaidableOrder(slug: string) {
  const order = await createOrder({ productSlug: slug, email: `buyer+${randomUUID().slice(0, 6)}@test.kg`, adultConfirmed: true, offerAccepted: true });
  const [payment] = await db.select().from(payments).where(eq(payments.orderId, order.id));
  return { order, payment };
}

beforeEach(async () => {
  await db.execute(sql`truncate table webhook_events, email_outbox, refunds, trade_offers, payments, product_keys, order_items, orders, products, mock_provider_payments, audit_log cascade`);
});
afterAll(async () => {
  // пул закрывается вместе с процессом vitest
});

describe("подпись webhook", () => {
  it("принимает корректную подпись", () => {
    const body = '{"a":1}';
    expect(verifyMockSignature(secret, body, signedHeaders(body)).ok).toBe(true);
  });
  it("отклоняет измененное тело", () => {
    const body = '{"a":1}';
    const h = signedHeaders(body);
    expect(verifyMockSignature(secret, '{"a":2}', h).ok).toBe(false);
  });
  it("отклоняет старую метку времени (повтор)", () => {
    const body = '{"a":1}';
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(verifyMockSignature(secret, body, signedHeaders(body, old)).ok).toBe(false);
  });
  it("отклоняет чужой секрет", () => {
    const body = '{"a":1}';
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyMockSignature(secret, body, signedHeaders(body, ts, signMockWebhook("other-secret-123456", body, ts))).ok).toBe(false);
  });
});

describe("покупка ключа", () => {
  it("выдает ключ только после подписанного webhook и ровно один раз", async () => {
    const p = await seedKeyProduct(2);
    const { order, payment } = await newPaidableOrder(p.slug);
    expect(order.status).toBe("PENDING_PAYMENT");
    expect(payment.qrPayload).toContain("KGS");

    // до оплаты ключа не видно
    expect((await getOrderForBuyer(order.accessToken))!.keys).toHaveLength(0);

    await db.update(mockProviderPayments).set({ status: "SUCCEEDED" }).where(eq(mockProviderPayments.id, payment.providerPaymentId));
    const body = successBody(payment.providerPaymentId, payment.amountMinor, "evt-1");
    const r1 = await handlePaymentWebhook("mock", body, signedHeaders(body));
    expect(r1).toEqual({ httpStatus: 200, result: "paid_delivered" });

    const view = (await getOrderForBuyer(order.accessToken))!;
    expect(view.order.status).toBe("DELIVERED");
    expect(view.keys).toHaveLength(1);
    expect(view.keys[0].code).toMatch(/^CODE-/);

    // повтор того же события
    const r2 = await handlePaymentWebhook("mock", body, signedHeaders(body));
    expect(r2.result).toBe("duplicate");
    // новое событие по тому же платежу
    const body2 = successBody(payment.providerPaymentId, payment.amountMinor, "evt-2");
    const r3 = await handlePaymentWebhook("mock", body2, signedHeaders(body2));
    expect(r3.result).toBe("already_processed");

    const issued = await db.select().from(productKeys).where(eq(productKeys.status, "ISSUED"));
    expect(issued).toHaveLength(1);

    const [mail] = await db.select().from(emailOutbox).where(eq(emailOutbox.to, view.order.email));
    expect(decrypt(mail.encryptedBody)).toContain(view.keys[0].code);
  });

  it("не выдает товар по поддельному webhook", async () => {
    const p = await seedKeyProduct(1);
    const { order, payment } = await newPaidableOrder(p.slug);
    const body = successBody(payment.providerPaymentId, payment.amountMinor, "evt-forged");
    const ts = Math.floor(Date.now() / 1000);
    const r = await handlePaymentWebhook("mock", body, signedHeaders(body, ts, signMockWebhook("attacker-secret-0000", body, ts)));
    expect(r.httpStatus).toBe(401);
    const [o] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(o.status).toBe("PENDING_PAYMENT");

    // настоящее событие с тем же eventId после подделки все равно проходит
    await db.update(mockProviderPayments).set({ status: "SUCCEEDED" }).where(eq(mockProviderPayments.id, payment.providerPaymentId));
    const real = await handlePaymentWebhook("mock", body, signedHeaders(body));
    expect(real.result).toBe("paid_delivered");
  });

  it("сумма не совпала: заказ в «Проблема», товар не выдан", async () => {
    const p = await seedKeyProduct(1);
    const { order, payment } = await newPaidableOrder(p.slug);
    const body = successBody(payment.providerPaymentId, payment.amountMinor - 100);
    const r = await handlePaymentWebhook("mock", body, signedHeaders(body));
    expect(r.result).toBe("amount_mismatch");
    const view = (await getOrderForBuyer(order.accessToken))!;
    expect(view.order.status).toBe("PROBLEM");
    expect(view.keys).toHaveLength(0);
  });

  it("нет ключей: купить нельзя", async () => {
    const p = await seedKeyProduct(1);
    await newPaidableOrder(p.slug);
    await expect(newPaidableOrder(p.slug)).rejects.toMatchObject({ code: "OUT_OF_STOCK" } satisfies Partial<OrderError>);
  });
});

describe("просрочка", () => {
  it("снимает резерв через 15 минут и возвращает оплату, пришедшую после отмены", async () => {
    const p = await seedKeyProduct(1);
    const { order, payment } = await newPaidableOrder(p.slug);

    // переносим срок в прошлое
    const past = new Date(Date.now() - 30 * 60 * 1000);
    await db.update(orders).set({ expiresAt: past }).where(eq(orders.id, order.id));
    expect(await expireStaleOrders()).toBe(1);

    const [key] = await db.select().from(productKeys).where(eq(productKeys.productId, p.id));
    expect(key.status).toBe("AVAILABLE");

    // банк все-таки провел оплату
    await db.update(mockProviderPayments).set({ status: "SUCCEEDED" }).where(eq(mockProviderPayments.id, payment.providerPaymentId));
    const body = successBody(payment.providerPaymentId, payment.amountMinor);
    const r = await handlePaymentWebhook("mock", body, signedHeaders(body));
    expect(r.result).toBe("late_paid_refund_queued");

    const [o] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(o.status).toBe("REFUNDED");
    const [rf] = await db.select().from(refunds);
    expect(rf.status).toBe("DONE");
    const [k2] = await db.select().from(productKeys).where(eq(productKeys.productId, p.id));
    expect(k2.status).toBe("AVAILABLE");
  });
});

describe("скин магазина", () => {
  it("без входа через Steam купить нельзя", async () => {
    const [p] = await db
      .insert(products)
      .values({ slug: "skin-x", type: "SHOP_SKIN", game: "CS2", title: "Skin", deliveryMethod: "TRADE_OFFER", deliveryEta: "x", priceMinor: 100_00, skin: { marketHashName: "Skin" } })
      .returning();
    await expect(newPaidableOrder(p.slug)).rejects.toMatchObject({ code: "STEAM_LOGIN_REQUIRED" });
    expect(await db.select().from(tradeOffers)).toHaveLength(0);
  });
});

describe("каталог", () => {
  it("считает остаток ключей и скрывает купленный скин", async () => {
    const { getProduct, listProducts } = await import("@/lib/catalog");
    const p = await seedKeyProduct(3);
    expect((await getProduct(p.slug))!.stock).toBe(3);
    await newPaidableOrder(p.slug);
    expect((await getProduct(p.slug))!.stock).toBe(2);
    const listed = await listProducts({ game: "OTHER" });
    expect(listed.find((x) => x.slug === p.slug)?.stock).toBe(2);
  });
});
