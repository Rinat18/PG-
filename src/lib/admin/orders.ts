import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, emailOutbox, orderItems, orders, payments, products, refunds, tradeOffers, webhookEvents } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";
import { processRefund } from "@/lib/orders/service";
import { writeAudit } from "@/lib/audit";
import { actorOf, assertCan } from "./rbac";

export class AdminActionError extends Error {}

type OrderStatus = (typeof orders.$inferSelect)["status"];
export const ORDER_STATUSES: OrderStatus[] = ["PENDING_PAYMENT", "PAID", "TRADE_SENT", "DELIVERED", "PROBLEM", "REFUNDED", "CANCELLED"];

export async function searchOrders(
  actor: SessionUser | null,
  f: { q?: string; status?: string; review?: boolean; manual?: boolean; limit?: number } = {},
) {
  assertCan(actor, "orders.view");
  const where: (SQL | undefined)[] = [];
  const q = f.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_]/g, "")}%`;
    where.push(or(ilike(orders.number, like), ilike(orders.email, like)));
  }
  if (f.status && (ORDER_STATUSES as string[]).includes(f.status)) where.push(eq(orders.status, f.status as OrderStatus));
  if (f.review) where.push(eq(orders.needsReview, true));
  if (f.manual) {
    // оплаченные заказы, которые ждут ручной выдачи оператором
    where.push(eq(orders.status, "PAID"));
    where.push(
      sql`exists (select 1 from order_items oi where oi.order_id = ${orders.id} and oi.delivery_method in ('MANUAL','STEAM_GIFT'))`,
    );
  }
  const rows = await db
    .select()
    .from(orders)
    .where(and(...where))
    .orderBy(desc(orders.createdAt))
    .limit(f.limit ?? 100);
  if (!rows.length) return [];
  const items = await db
    .select({ orderId: orderItems.orderId, title: orderItems.titleSnapshot })
    .from(orderItems)
    .where(inArray(orderItems.orderId, rows.map((r) => r.id)));
  return rows.map((r) => ({ ...r, titles: items.filter((i) => i.orderId === r.id).map((i) => i.title) }));
}

export async function getOrderAdmin(actor: SessionUser | null, orderId: string) {
  assertCan(actor, "orders.view");
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return null;
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return null;
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  const [payment] = await db.select().from(payments).where(eq(payments.orderId, order.id));
  const refundRows = payment
    ? await db.select().from(refunds).where(eq(refunds.paymentId, payment.id)).orderBy(desc(refunds.createdAt))
    : [];
  // журнал webhook по этому платежу (включая отклоненные по подписи)
  const webhooks = payment
    ? await db
        .select()
        .from(webhookEvents)
        .where(ilike(webhookEvents.rawBody, `%${payment.providerPaymentId}%`))
        .orderBy(desc(webhookEvents.receivedAt))
        .limit(50)
    : [];
  const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, order.id)).orderBy(desc(auditLog.createdAt)).limit(100);
  const offers = items.length
    ? await db.select().from(tradeOffers).where(inArray(tradeOffers.orderItemId, items.map((i) => i.id)))
    : [];
  return { order, items, payment, refunds: refundRows, webhooks, audit, offers };
}

/** Ручная выдача (Dota Plus, Prime подарком): оператор отмечает выдачу, покупателю уходит письмо. */
export async function markOrderDelivered(actor: SessionUser | null, orderId: string, note: string) {
  assertCan(actor, "orders.deliver");
  const order = await db.transaction(async (tx) => {
    const [o] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
    if (!o) throw new AdminActionError("Заказ не найден");
    if (o.status !== "PAID" && o.status !== "PROBLEM") {
      throw new AdminActionError(`Выдать можно только оплаченный заказ (сейчас: ${o.status})`);
    }
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, o.id));
    if (!items.every((i) => i.deliveryMethod === "MANUAL" || i.deliveryMethod === "STEAM_GIFT")) {
      throw new AdminActionError("В заказе есть позиции с автоматической выдачей — вручную их отмечать нельзя");
    }
    const [payment] = await tx.select().from(payments).where(eq(payments.orderId, o.id));
    if (payment?.status !== "SUCCEEDED") throw new AdminActionError("Оплата по заказу не подтверждена");
    await tx.update(orders).set({ status: "DELIVERED", deliveredAt: new Date(), needsReview: false }).where(eq(orders.id, o.id));
    await writeAudit(actorOf(actor), "order.delivered_manually", "order", o.id, { note: note.slice(0, 500) }, tx);
    return { ...o, items };
  });
  await db.insert(emailOutbox).values({
    to: order.email,
    subject: `Заказ ${order.number} выдан`,
    encryptedBody: encrypt(
      [
        `Заказ ${order.number} выдан.`,
        ...order.items.map((i) => `• ${i.titleSnapshot}`),
        note.trim() ? `\nКомментарий оператора: ${note.trim()}` : "",
        `\nЗаказ: ${env.APP_URL}/order/${order.accessToken}`,
      ].join("\n"),
    ),
  });
}

/**
 * Полный возврат через PaymentProvider.refund. Повторный клик не создает второй возврат:
 * заказ блокируется, существующий возврат в работе или выполненный — возвращается как есть.
 */
export async function refundOrder(actor: SessionUser | null, orderId: string, reason: string) {
  assertCan(actor, "refunds.manage");
  const why = reason.trim();
  if (why.length < 3) throw new AdminActionError("Укажите причину возврата");

  const res = await db.transaction(async (tx) => {
    const [o] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
    if (!o) throw new AdminActionError("Заказ не найден");
    const [payment] = await tx.select().from(payments).where(eq(payments.orderId, o.id));
    if (!payment) throw new AdminActionError("По заказу не было платежа");

    const existing = await tx.select().from(refunds).where(eq(refunds.paymentId, payment.id));
    const active = existing.find((r) => r.status !== "FAILED");
    if (active) return { refundId: active.id, created: false };
    if (existing.length) throw new AdminActionError("Прошлый возврат не прошел — используйте «Повторить возврат»");
    if (payment.status !== "SUCCEEDED") throw new AdminActionError(`Платеж нельзя вернуть (статус ${payment.status})`);
    if (!["PAID", "TRADE_SENT", "DELIVERED", "PROBLEM"].includes(o.status)) {
      throw new AdminActionError(`Заказ в статусе ${o.status} вернуть нельзя`);
    }

    const [refund] = await tx
      .insert(refunds)
      .values({ paymentId: payment.id, amountMinor: payment.amountMinor, reason: why, requestedBy: actorOf(actor) })
      .returning({ id: refunds.id });

    // скин, который еще не отправлен ботом, возвращается в каталог
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, o.id));
    const cancelled = await tx
      .update(tradeOffers)
      .set({ status: "FAILED", lastError: "order_refunded", updatedAt: new Date() })
      .where(and(inArray(tradeOffers.orderItemId, items.map((i) => i.id)), eq(tradeOffers.status, "QUEUED")))
      .returning({ itemId: tradeOffers.orderItemId });
    for (const c of cancelled) {
      const productId = items.find((i) => i.id === c.itemId)?.productId;
      if (productId) {
        await tx.update(products).set({ soldAt: null, reservedByOrderId: null, reservedUntil: null }).where(eq(products.id, productId));
      }
    }

    await writeAudit(actorOf(actor), "order.refund_requested", "order", o.id, { reason: why, refundId: refund.id }, tx);
    return { refundId: refund.id, created: true };
  });

  if (res.created) await processRefund(res.refundId);
  const [r] = await db.select().from(refunds).where(eq(refunds.id, res.refundId));
  return { ...res, status: r.status, error: r.error };
}

/** Повтор неудавшегося возврата. */
export async function retryRefund(actor: SessionUser | null, refundId: string) {
  assertCan(actor, "refunds.manage");
  const [claimed] = await db
    .update(refunds)
    .set({ status: "PENDING" })
    .where(and(eq(refunds.id, refundId), eq(refunds.status, "FAILED")))
    .returning();
  if (!claimed) throw new AdminActionError("Возврат уже выполнен или в работе");
  const [payment] = await db.select().from(payments).where(eq(payments.id, claimed.paymentId));
  await writeAudit(actorOf(actor), "refund.retried", "order", payment.orderId, { refundId });
  await processRefund(refundId);
  const [r] = await db.select().from(refunds).where(eq(refunds.id, refundId));
  return r;
}

export async function listRefunds(actor: SessionUser | null, status?: string) {
  assertCan(actor, "refunds.manage");
  return db
    .select({ refund: refunds, orderId: orders.id, number: orders.number, email: orders.email })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(status ? eq(refunds.status, status) : undefined)
    .orderBy(desc(refunds.createdAt))
    .limit(200);
}

