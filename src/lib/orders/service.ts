import { and, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import {
  auditLog,
  emailOutbox,
  orderItems,
  users,
  orders,
  payments,
  productKeys,
  products,
  refunds,
  tradeOffers,
  webhookEvents,
} from "@/db/schema";
import { decrypt, encrypt, randomToken } from "@/lib/crypto";
import { env } from "@/lib/env";
import { formatKgs } from "@/lib/format";
import { getPaymentProvider } from "@/lib/payments";
import type { PaymentWebhookEvent } from "@/lib/payments/types";
import { checkSkinBuyer, getSteamApi, SkinBuyerError, type SteamApi } from "@/lib/steam/buyer-checks";

/** Оплата, пришедшая чуть позже таймера (задержка банка), еще принимается. */
const LATE_PAYMENT_GRACE_MS = 2 * 60 * 1000;

export class OrderError extends Error {
  constructor(
    public readonly code:
      | "VALIDATION"
      | "NOT_FOUND"
      | "OUT_OF_STOCK"
      | "RATE_LIMIT"
      | "STEAM_LOGIN_REQUIRED"
      | "TRADE_URL"
      | "INVENTORY_PRIVATE"
      | "TRADE_BAN"
      | "STEAM_UNAVAILABLE"
      | "PAYMENT_PROVIDER",
    message: string,
  ) {
    super(message);
  }
}

// ---------- Создание заказа ----------

const steamTradeUrl = /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[\w-]{6,}$/;

export const checkoutSchema = z.object({
  productSlug: z.string().min(1),
  email: z.string().trim().toLowerCase().email("Укажите корректный email"),
  tradeUrl: z
    .string()
    .trim()
    .regex(steamTradeUrl, "Нужна trade-ссылка вида https://steamcommunity.com/tradeoffer/new/?partner=...&token=...")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  adultConfirmed: z.boolean().refine((v) => v, "Подтвердите, что вам есть 18 лет"),
  offerAccepted: z.boolean().refine((v) => v, "Нужно согласие с офертой и правилами возврата"),
});
export type CheckoutInput = z.input<typeof checkoutSchema>;

function newOrderNumber(): string {
  // PG-ГГММДД-XXXXXX: читается в поддержке и уникален (проверяется индексом)
  const d = new Date();
  const ymd = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const rnd = randomToken(6).replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6).padEnd(6, "0");
  return `PG-${ymd}-${rnd}`;
}

export type CreateOrderContext = {
  ip?: string;
  userId?: string;
  /** Клиент Steam Web API для проверок покупателя скина; undefined — из env, null — Steam недоступен */
  steamApi?: SteamApi | null;
};

export async function createOrder(input: CheckoutInput, ctx: CreateOrderContext = {}) {
  const parsed = checkoutSchema.safeParse(input);
  if (!parsed.success) throw new OrderError("VALIDATION", parsed.error.issues[0]?.message ?? "Проверьте форму");
  const data = parsed.data;

  await expireStaleOrders();

  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.slug, data.productSlug), eq(products.isActive, true)));
  if (!product) throw new OrderError("NOT_FOUND", "Товар не найден или снят с продажи");
  if (product.type === "SHOP_SKIN" && !ctx.userId) {
    throw new OrderError("STEAM_LOGIN_REQUIRED", "Скины покупаются только со входом через Steam");
  }

  // Антифрод: не более N заказов с одного email или аккаунта в час (ТЗ, раздел 7)
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(
        ctx.userId ? or(eq(orders.email, data.email), eq(orders.userId, ctx.userId)) : eq(orders.email, data.email),
        gte(orders.createdAt, hourAgo),
      ),
    );
  if (count >= env.MAX_ORDERS_PER_EMAIL_PER_HOUR) {
    throw new OrderError("RATE_LIMIT", "Слишком много заказов за час. Попробуйте позже или напишите в поддержку");
  }

  // Скин: вход через Steam, своя trade-ссылка, открытый инвентарь, нет трейд-бана — до создания QR
  let tradeUrl = data.tradeUrl;
  let tradeHoldDays: number | null = null;
  let buyer: typeof users.$inferSelect | undefined;
  if (product.type === "SHOP_SKIN") {
    [buyer] = await db.select().from(users).where(eq(users.id, ctx.userId!));
    if (!buyer?.steamId || buyer.isBlocked) {
      throw new OrderError("STEAM_LOGIN_REQUIRED", "Скины покупаются только со входом через Steam");
    }
    if (product.soldAt || product.reservedByOrderId) throw new OrderError("OUT_OF_STOCK", "Скин уже купили или он оплачивается");
    tradeUrl = tradeUrl ?? buyer.tradeUrl ?? undefined;
    if (!tradeUrl) throw new OrderError("TRADE_URL", "Укажите trade-ссылку Steam: на нее бот отправит скин");
    if (product.game !== "CS2" && product.game !== "DOTA2") throw new OrderError("NOT_FOUND", "Товар не найден");
    try {
      const res = await checkSkinBuyer(
        { steamId: buyer.steamId, tradeUrl, game: product.game },
        ctx.steamApi === undefined ? getSteamApi() : ctx.steamApi,
      );
      tradeHoldDays = res.tradeHoldDays;
    } catch (e) {
      if (e instanceof SkinBuyerError) throw new OrderError(e.code, e.message);
      throw e;
    }
  }

  const expiresAt = new Date(Date.now() + env.ORDER_TTL_MINUTES * 60 * 1000);
  const needsReview = env.REVIEW_THRESHOLD_MINOR !== undefined && product.priceMinor > env.REVIEW_THRESHOLD_MINOR;

  const order = await db.transaction(async (tx) => {
    const [order] = await tx
      .insert(orders)
      .values({
        number: newOrderNumber(),
        accessToken: randomToken(),
        userId: ctx.userId,
        email: data.email,
        tradeUrl,
        tradeHoldDays,
        totalMinor: product.priceMinor,
        adultConfirmed: true,
        offerAccepted: true,
        clientIp: ctx.ip,
        needsReview,
        expiresAt,
      })
      .returning();
    const [item] = await tx
      .insert(orderItems)
      .values({
        orderId: order.id,
        productId: product.id,
        titleSnapshot: product.title,
        typeSnapshot: product.type,
        deliveryMethod: product.deliveryMethod,
        priceMinor: product.priceMinor,
      })
      .returning();

    if (product.deliveryMethod === "KEY") {
      // Резервируем один ключ. SKIP LOCKED: два покупателя не получат один ключ.
      const [key] = await tx
        .select({ id: productKeys.id })
        .from(productKeys)
        .where(and(eq(productKeys.productId, product.id), eq(productKeys.status, "AVAILABLE")))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!key) throw new OrderError("OUT_OF_STOCK", "Ключи закончились");
      await tx
        .update(productKeys)
        .set({ status: "RESERVED", orderItemId: item.id, reservedUntil: expiresAt })
        .where(eq(productKeys.id, key.id));
    }

    if (product.type === "SHOP_SKIN") {
      // Один скин = одна карточка: резерв на время оплаты, из каталога пропадает.
      const reserved = await tx
        .update(products)
        .set({ reservedByOrderId: order.id, reservedUntil: expiresAt })
        .where(and(eq(products.id, product.id), sql`${products.reservedByOrderId} is null`, sql`${products.soldAt} is null`))
        .returning({ id: products.id });
      if (reserved.length === 0) throw new OrderError("OUT_OF_STOCK", "Скин уже купили или он оплачивается");
    }
    return order;
  });

  // QR создаем вне транзакции: внешний вызов не должен держать блокировки.
  const provider = getPaymentProvider();
  try {
    const qr = await provider.createQr({
      orderId: order.id,
      orderNumber: order.number,
      amountMinor: order.totalMinor,
      expiresAt,
      description: `Заказ ${order.number}`,
    });
    await db.insert(payments).values({
      orderId: order.id,
      provider: provider.name,
      providerPaymentId: qr.providerPaymentId,
      qrPayload: qr.qrPayload,
      deeplinks: qr.deeplinks,
      amountMinor: order.totalMinor,
      expiresAt,
    });
  } catch (e) {
    await db.transaction((tx) => cancelOrder(tx, order.id, "qr_creation_failed"));
    throw new OrderError("PAYMENT_PROVIDER", `Не удалось создать QR для оплаты: ${(e as Error).message}`);
  }

  if (buyer && !buyer.tradeUrl && tradeUrl) {
    // проверенная ссылка пригодится в следующий раз
    await db.update(users).set({ tradeUrl }).where(eq(users.id, buyer.id));
  }
  await audit("system", "order.created", "order", order.id, { product: product.slug, needsReview, tradeHoldDays });
  return order;
}

/** Покупатель передумал до оплаты: заказ отменяется, резерв скина или ключа снимается сразу. */
export async function cancelPendingOrderByBuyer(accessToken: string): Promise<boolean> {
  const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.accessToken, accessToken));
  if (!order) return false;
  const ok = await db.transaction((tx) => cancelOrder(tx, order.id, "cancelled_by_buyer"));
  if (ok) await audit("buyer", "order.cancelled_by_buyer", "order", order.id, {});
  return ok;
}

// ---------- Отмена и истечение ----------

async function releaseReservations(tx: Tx, orderId: string) {
  const items = await tx.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, orderId));
  const itemIds = items.map((i) => i.id);
  if (itemIds.length) {
    await tx
      .update(productKeys)
      .set({ status: "AVAILABLE", orderItemId: null, reservedUntil: null })
      .where(and(inArray(productKeys.orderItemId, itemIds), eq(productKeys.status, "RESERVED")));
  }
  await tx
    .update(products)
    .set({ reservedByOrderId: null, reservedUntil: null })
    .where(and(eq(products.reservedByOrderId, orderId), sql`${products.soldAt} is null`));
}

async function cancelOrder(tx: Tx, orderId: string, reason: string) {
  const changed = await tx
    .update(orders)
    .set({ status: "CANCELLED", problemReason: reason })
    .where(and(eq(orders.id, orderId), eq(orders.status, "PENDING_PAYMENT")))
    .returning({ id: orders.id });
  if (!changed.length) return false;
  await tx
    .update(payments)
    .set({ status: "EXPIRED" })
    .where(and(eq(payments.orderId, orderId), eq(payments.status, "CREATED")));
  await releaseReservations(tx, orderId);
  return true;
}

/** Отменяет неоплаченные за ORDER_TTL_MINUTES заказы и снимает резервы. Вызывается лениво и по крону. */
export async function expireStaleOrders(now = new Date()) {
  const stale = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.status, "PENDING_PAYMENT"), lt(orders.expiresAt, new Date(now.getTime() - LATE_PAYMENT_GRACE_MS))))
    .limit(200);
  let cancelled = 0;
  for (const o of stale) {
    if (await db.transaction((tx) => cancelOrder(tx, o.id, "payment_timeout"))) cancelled++;
  }
  return cancelled;
}

// ---------- Webhook ----------

export type WebhookResult = { httpStatus: number; result: string };

/**
 * Единственная точка, после которой выдается товар.
 * 1) подпись проверяется адаптером провайдера;
 * 2) каждое событие пишется в журнал, повтор события (тот же eventId) ничего не делает;
 * 3) переход оплаты CREATED -> SUCCEEDED делается условным UPDATE: двойной выдачи нет даже при гонке.
 */
export async function handlePaymentWebhook(providerName: string, rawBody: string, headers: Headers): Promise<WebhookResult> {
  const provider = getPaymentProvider(providerName);
  const verification = provider.verifyWebhook(rawBody, headers);
  const headerObj = Object.fromEntries(headers.entries());

  if (!verification.ok) {
    // eventId не сохраняем: иначе поддельное событие могло бы «занять» id настоящего.
    await db.insert(webhookEvents).values({
      provider: provider.name,
      eventId: null,
      signatureValid: false,
      rawBody,
      headers: headerObj,
      result: `rejected: ${verification.reason}`,
    });
    return { httpStatus: 401, result: "invalid signature" };
  }

  const event = verification.event;
  const inserted = await db
    .insert(webhookEvents)
    .values({ provider: provider.name, eventId: event.eventId, signatureValid: true, rawBody, headers: headerObj })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });

  let eventRowId: string;
  if (inserted.length) {
    eventRowId = inserted[0].id;
  } else {
    const [existing] = await db
      .select()
      .from(webhookEvents)
      .where(and(eq(webhookEvents.provider, provider.name), eq(webhookEvents.eventId, event.eventId)));
    if (existing.processedAt) return { httpStatus: 200, result: "duplicate" };
    eventRowId = existing.id; // прошлый прием упал до обработки — обрабатываем снова
  }

  const outcome = await applyPaymentEvent(provider.name, event);
  await db.update(webhookEvents).set({ processedAt: new Date(), result: outcome.result }).where(eq(webhookEvents.id, eventRowId));

  if (outcome.refundId) await processRefund(outcome.refundId);
  if (outcome.deliveredOrderId) await queueReceiptEmail(outcome.deliveredOrderId);
  return { httpStatus: 200, result: outcome.result };
}

type ApplyOutcome = { result: string; refundId?: string; deliveredOrderId?: string };

async function applyPaymentEvent(providerName: string, event: PaymentWebhookEvent): Promise<ApplyOutcome> {
  return db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.provider, providerName), eq(payments.providerPaymentId, event.providerPaymentId)))
      .for("update");
    if (!payment) return { result: "unknown_payment" };
    const [order] = await tx.select().from(orders).where(eq(orders.id, payment.orderId)).for("update");

    if (event.status !== "SUCCEEDED") {
      if (event.status === "EXPIRED") await cancelOrder(tx, order.id, "provider_expired");
      return { result: `ignored_${event.status.toLowerCase()}` };
    }

    if (event.amountMinor !== payment.amountMinor) {
      await tx
        .update(orders)
        .set({ status: "PROBLEM", needsReview: true, problemReason: `amount_mismatch: got ${event.amountMinor}` })
        .where(eq(orders.id, order.id));
      await auditTx(tx, "system", "payment.amount_mismatch", "order", order.id, { expected: payment.amountMinor, got: event.amountMinor });
      return { result: "amount_mismatch" };
    }

    const lateByClock = event.occurredAt.getTime() > order.expiresAt.getTime() + LATE_PAYMENT_GRACE_MS;
    const canAccept = payment.status === "CREATED" && order.status === "PENDING_PAYMENT" && !lateByClock;

    if (!canAccept) {
      if (payment.status === "SUCCEEDED" || payment.status === "LATE_PAID" || payment.status === "REFUNDED") {
        return { result: "already_processed" };
      }
      // Оплата по просроченному или отмененному заказу: товар не выдаем, деньги возвращаем.
      if (order.status === "PENDING_PAYMENT") await cancelOrder(tx, order.id, "paid_after_expiry");
      await tx.update(payments).set({ status: "LATE_PAID", paidAt: event.occurredAt }).where(eq(payments.id, payment.id));
      const [refund] = await tx
        .insert(refunds)
        .values({ paymentId: payment.id, amountMinor: payment.amountMinor, reason: "paid_after_expiry" })
        .returning({ id: refunds.id });
      await auditTx(tx, "system", "payment.late_paid", "order", order.id, {});
      return { result: "late_paid_refund_queued", refundId: refund.id };
    }

    const switched = await tx
      .update(payments)
      .set({ status: "SUCCEEDED", paidAt: event.occurredAt })
      .where(and(eq(payments.id, payment.id), eq(payments.status, "CREATED")))
      .returning({ id: payments.id });
    if (!switched.length) return { result: "already_processed" };

    await tx.update(orders).set({ status: "PAID", paidAt: event.occurredAt }).where(eq(orders.id, order.id));
    const delivered = await fulfillOrder(tx, order.id);
    await auditTx(tx, "system", "order.paid", "order", order.id, { delivered });
    return { result: delivered ? "paid_delivered" : "paid_awaiting_delivery", deliveredOrderId: order.id };
  });
}

/** Выдача после оплаты. Возвращает true, если все позиции выданы сразу. */
async function fulfillOrder(tx: Tx, orderId: string): Promise<boolean> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
  const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  let allDelivered = true;
  let problem: string | null = null;

  for (const item of items) {
    switch (item.deliveryMethod) {
      case "KEY": {
        const issued = await tx
          .update(productKeys)
          .set({ status: "ISSUED", issuedAt: new Date(), reservedUntil: null })
          .where(and(eq(productKeys.orderItemId, item.id), eq(productKeys.status, "RESERVED")))
          .returning({ id: productKeys.id });
        if (issued.length < item.quantity) problem = "key_reservation_lost";
        break;
      }
      case "TRADE_OFFER": {
        if (!order.tradeUrl) {
          problem = "trade_url_missing";
          break;
        }
        await tx.insert(tradeOffers).values({ orderItemId: item.id, tradeUrl: order.tradeUrl });
        if (item.productId) {
          await tx.update(products).set({ soldAt: new Date() }).where(eq(products.id, item.productId));
        }
        allDelivered = false;
        break;
      }
      case "STEAM_GIFT":
      case "MANUAL":
        allDelivered = false; // очередь оператора в админке
        break;
    }
  }

  if (problem) {
    await tx.update(orders).set({ status: "PROBLEM", needsReview: true, problemReason: problem }).where(eq(orders.id, orderId));
    return false;
  }
  if (allDelivered) {
    await tx.update(orders).set({ status: "DELIVERED", deliveredAt: new Date() }).where(eq(orders.id, orderId));
  }
  return allDelivered;
}

// ---------- Возвраты ----------

export async function processRefund(refundId: string) {
  const [refund] = await db.select().from(refunds).where(eq(refunds.id, refundId));
  if (!refund || refund.status !== "PENDING") return;
  const [payment] = await db.select().from(payments).where(eq(payments.id, refund.paymentId));
  const provider = getPaymentProvider(payment.provider);
  try {
    const res = await provider.refund(payment.providerPaymentId, refund.amountMinor);
    await db.transaction(async (tx) => {
      await tx.update(refunds).set({ status: "DONE", providerRefundId: res.providerRefundId, doneAt: new Date() }).where(eq(refunds.id, refund.id));
      await tx.update(payments).set({ status: "REFUNDED" }).where(eq(payments.id, payment.id));
      await tx.update(orders).set({ status: "REFUNDED" }).where(eq(orders.id, payment.orderId));
    });
    const [order] = await db.select().from(orders).where(eq(orders.id, payment.orderId));
    await db.insert(emailOutbox).values({
      to: order.email,
      subject: `Возврат по заказу ${order.number}`,
      encryptedBody: encrypt(
        `Мы вернули ${formatKgs(refund.amountMinor)} по заказу ${order.number}. ` +
          `Деньги поступят на счет, с которого была оплата, в срок [__] рабочих дней.`,
      ),
    });
  } catch (e) {
    // остается в очереди возвратов админки
    await db.update(refunds).set({ status: "FAILED", error: (e as Error).message }).where(eq(refunds.id, refund.id));
    await db.update(orders).set({ needsReview: true }).where(eq(orders.id, payment.orderId));
  }
}

// ---------- Запрос статуса (страница оплаты) ----------

/**
 * Страница оплаты опрашивает статус. Если webhook задерживается, сайт спрашивает провайдера через API,
 * но товар по этому ответу НЕ выдает: только помечает заказ на проверку (выдача — только по подписанному webhook).
 */
export async function getOrderForBuyer(accessToken: string) {
  const [order] = await db.select().from(orders).where(eq(orders.accessToken, accessToken));
  if (!order) return null;

  if (order.status === "PENDING_PAYMENT" && order.expiresAt.getTime() + LATE_PAYMENT_GRACE_MS < Date.now()) {
    await db.transaction((tx) => cancelOrder(tx, order.id, "payment_timeout"));
    return getOrderForBuyer(accessToken);
  }

  const [payment] = await db.select().from(payments).where(eq(payments.orderId, order.id));
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));

  if (order.status === "PENDING_PAYMENT" && payment && shouldCheckProvider(payment)) {
    await db.update(payments).set({ lastStatusCheckAt: new Date() }).where(eq(payments.id, payment.id));
    try {
      const st = await getPaymentProvider(payment.provider).getStatus(payment.providerPaymentId);
      if (st === "SUCCEEDED" && !order.needsReview) {
        await db.update(orders).set({ needsReview: true, problemReason: "provider_succeeded_webhook_missing" }).where(eq(orders.id, order.id));
        await audit("system", "payment.webhook_missing", "order", order.id, {});
      }
    } catch {
      // провайдер недоступен — просто ждем webhook
    }
  }

  // Ключи расшифровываем только для выданного заказа и только по секретной ссылке
  let keys: { title: string; code: string }[] = [];
  if (order.status === "DELIVERED" || order.status === "PAID") {
    const itemIds = items.map((i) => i.id);
    if (itemIds.length) {
      const rows = await db
        .select({ code: productKeys.encryptedCode, itemId: productKeys.orderItemId })
        .from(productKeys)
        .where(and(inArray(productKeys.orderItemId, itemIds), eq(productKeys.status, "ISSUED")));
      keys = rows.map((r) => ({
        title: items.find((i) => i.id === r.itemId)?.titleSnapshot ?? "",
        code: decrypt(r.code),
      }));
    }
  }

  return { order, payment, items, keys };
}

function shouldCheckProvider(p: typeof payments.$inferSelect) {
  const now = Date.now();
  const age = now - p.createdAt.getTime();
  const sinceCheck = p.lastStatusCheckAt ? now - p.lastStatusCheckAt.getTime() : Infinity;
  return p.status === "CREATED" && age > 60_000 && sinceCheck > 30_000;
}

// ---------- Письма и аудит ----------

async function queueReceiptEmail(orderId: string) {
  const data = await db.select().from(orders).where(eq(orders.id, orderId));
  const order = data[0];
  if (!order) return;
  const view = await getOrderForBuyer(order.accessToken);
  if (!view) return;
  const lines = [
    `Заказ ${order.number} оплачен: ${formatKgs(order.totalMinor)}.`,
    ...view.items.map((i) => `• ${i.titleSnapshot} — ${formatKgs(i.priceMinor)}`),
    ...(view.keys.length ? ["", "Ваши ключи:", ...view.keys.map((k) => `${k.title}: ${k.code}`)] : []),
    "",
    `Заказ: ${env.APP_URL}/order/${order.accessToken}`,
  ];
  await db.insert(emailOutbox).values({
    to: order.email,
    subject: `Заказ ${order.number}: оплата получена`,
    encryptedBody: encrypt(lines.join("\n")),
  });
}

async function audit(actor: string, action: string, entity: string, entityId: string, data: unknown) {
  await db.insert(auditLog).values({ actor, action, entity, entityId, data });
}
async function auditTx(tx: Tx, actor: string, action: string, entity: string, entityId: string, data: unknown) {
  await tx.insert(auditLog).values({ actor, action, entity, entityId, data });
}
