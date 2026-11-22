import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, botAccounts, orderItems, orders, products, tradeOffers } from "@/db/schema";
import { getSettings } from "@/lib/settings";
import { notifyDeliveryProblem, notifyTradeSent } from "@/lib/orders/service";
import { APP_ID, type SkinGame, type SteamItem } from "./inventory";

/**
 * Обработка очереди trade_offers воркером ботов.
 * Каждый оффер обрабатывается отдельно в try/catch: сбой одного трейда не останавливает очередь.
 */

/** Состояния ETradeOfferState из Steam (steam-tradeoffer-manager). */
export type OfferState =
  | "Invalid"
  | "Active"
  | "Accepted"
  | "Countered"
  | "Expired"
  | "Canceled"
  | "Declined"
  | "InvalidItems"
  | "CreatedNeedsConfirmation"
  | "CanceledBySecondFactor"
  | "InEscrow";

export class BotError extends Error {
  /** permanent — повтор бессмыслен (трейд-бан, неверная ссылка, предмета нет у бота) */
  constructor(
    message: string,
    public readonly permanent = false,
  ) {
    super(message);
  }
}

export interface BotClient {
  readonly steamId: string;
  getInventory(appId: number): Promise<SteamItem[]>;
  sendOffer(p: { tradeUrl: string; appId: number; assetId: string; message: string }): Promise<{ offerId: string }>;
  getOfferState(offerId: string): Promise<OfferState>;
  cancelOffer(offerId: string): Promise<void>;
}

export const MAX_TRADE_ATTEMPTS = 5;
const retryMinutes = (attempt: number) => [1, 5, 15, 60][attempt - 1] ?? 60;

const FAILED_STATES: OfferState[] = ["Declined", "Canceled", "Expired", "InvalidItems", "Countered", "Invalid", "CanceledBySecondFactor"];
const stateText: Partial<Record<OfferState, string>> = {
  Declined: "покупатель отклонил трейд",
  Canceled: "трейд отменен",
  Expired: "трейд истек",
  InvalidItems: "предмет недоступен",
  Countered: "покупатель изменил трейд",
  CanceledBySecondFactor: "трейд отменен Steam Guard",
};

type Clients = Record<string, BotClient>; // botAccounts.id -> клиент

async function markOrderProblem(orderId: string, reason: string) {
  const changed = await db
    .update(orders)
    .set({ status: "PROBLEM", needsReview: true, problemReason: reason.slice(0, 300) })
    .where(and(eq(orders.id, orderId), inArray(orders.status, ["PAID", "TRADE_SENT"])))
    .returning({ id: orders.id });
  if (changed.length) {
    await db.insert(auditLog).values({ actor: "worker", action: "order.trade_problem", entity: "order", entityId: orderId, data: { reason } });
    await notifyDeliveryProblem(orderId);
  }
}

async function loadContext(offerId: string) {
  const [row] = await db
    .select({ offer: tradeOffers, item: orderItems, order: orders, product: products })
    .from(tradeOffers)
    .innerJoin(orderItems, eq(orderItems.id, tradeOffers.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .leftJoin(products, eq(products.id, orderItems.productId))
    .where(eq(tradeOffers.id, offerId));
  return row;
}

/** Отправка поставленных в очередь офферов. */
export async function processTradeQueue(clients: Clients, now = new Date()) {
  const due = await db
    .select({ id: tradeOffers.id })
    .from(tradeOffers)
    .where(and(eq(tradeOffers.status, "QUEUED"), or(isNull(tradeOffers.nextAttemptAt), lte(tradeOffers.nextAttemptAt, now))))
    .orderBy(tradeOffers.createdAt)
    .limit(25);

  const result = { sent: 0, retry: 0, failed: 0, skipped: 0 };
  for (const { id } of due) {
    try {
      const r = await sendOne(id, clients, now);
      result[r]++;
    } catch (e) {
      // непредвиденная ошибка одного оффера не останавливает остальные
      result.retry++;
      await db
        .update(tradeOffers)
        .set({ lastError: `internal: ${(e as Error).message}`.slice(0, 500), nextAttemptAt: new Date(now.getTime() + 60_000), updatedAt: now })
        .where(eq(tradeOffers.id, id));
    }
  }
  return result;
}

async function sendOne(offerRowId: string, clients: Clients, now: Date): Promise<"sent" | "retry" | "failed" | "skipped"> {
  // Захват: второй воркер (если по ошибке запущено два) этот оффер не возьмет 10 минут
  const claimed = await db
    .update(tradeOffers)
    .set({ nextAttemptAt: new Date(now.getTime() + 10 * 60_000) })
    .where(
      and(
        eq(tradeOffers.id, offerRowId),
        eq(tradeOffers.status, "QUEUED"),
        or(isNull(tradeOffers.nextAttemptAt), lte(tradeOffers.nextAttemptAt, now)),
      ),
    )
    .returning({ id: tradeOffers.id });
  if (!claimed.length) return "skipped";
  const ctx = await loadContext(offerRowId);
  if (!ctx || ctx.offer.status !== "QUEUED") return "skipped";
  const { offer, item, order, product } = ctx;

  if (order.status !== "PAID") {
    await db.update(tradeOffers).set({ status: "FAILED", lastError: `order_${order.status.toLowerCase()}`, updatedAt: now }).where(eq(tradeOffers.id, offer.id));
    return "skipped";
  }
  const assetId = product?.skin?.assetId;
  const botId = product?.botAccountId;
  if (!product || !assetId || !botId || (product.game !== "CS2" && product.game !== "DOTA2")) {
    await failOffer(offer.id, order.id, "у товара нет предмета бота", now);
    return "failed";
  }
  const client = clients[botId];
  if (!client) {
    // бот не в сети — ждем, попытку не списываем
    await db
      .update(tradeOffers)
      .set({ lastError: "bot_offline", nextAttemptAt: new Date(now.getTime() + 60_000), updatedAt: now })
      .where(eq(tradeOffers.id, offer.id));
    return "retry";
  }

  const attempts = offer.attempts + 1;
  try {
    const { offerId } = await client.sendOffer({
      tradeUrl: offer.tradeUrl,
      appId: APP_ID[product.game as SkinGame],
      assetId,
      message: `Заказ ${order.number}`,
    });
    await db.transaction(async (tx) => {
      await tx
        .update(tradeOffers)
        .set({ status: "SENT", steamOfferId: offerId, botAccountId: botId, attempts, sentAt: now, lastError: null, updatedAt: now })
        .where(eq(tradeOffers.id, offer.id));
      await tx.update(orders).set({ status: "TRADE_SENT" }).where(and(eq(orders.id, order.id), eq(orders.status, "PAID")));
      await tx.insert(auditLog).values({ actor: "worker", action: "trade.sent", entity: "order", entityId: order.id, data: { offerId } });
    });
    await notifyTradeSent(order.id, item.titleSnapshot);
    return "sent";
  } catch (e) {
    const err = e instanceof BotError ? e : new BotError((e as Error)?.message ?? String(e));
    if (err.permanent || attempts >= MAX_TRADE_ATTEMPTS) {
      await failOffer(offer.id, order.id, err.message, now, attempts);
      return "failed";
    }
    await db
      .update(tradeOffers)
      .set({ attempts, lastError: err.message.slice(0, 500), nextAttemptAt: new Date(now.getTime() + retryMinutes(attempts) * 60_000), updatedAt: now })
      .where(eq(tradeOffers.id, offer.id));
    return "retry";
  }
}

async function failOffer(id: string, orderId: string, reason: string, now: Date, attempts?: number) {
  await db
    .update(tradeOffers)
    .set({ status: "FAILED", lastError: reason.slice(0, 500), finishedAt: now, updatedAt: now, ...(attempts ? { attempts } : {}) })
    .where(eq(tradeOffers.id, id));
  await markOrderProblem(orderId, `trade_failed: ${reason}`);
}

/**
 * Проверка отправленных офферов: принят → «Выдан», отклонен → «Проблема»,
 * не принят за tradeAcceptHours → оффер отменяется, заказ в «Проблема» (возврат — из админки).
 * Если заказ вернули деньгами, пока оффер висит, оффер отменяется.
 */
export async function pollSentOffers(clients: Clients, now = new Date()) {
  const cfg = await getSettings();
  const deadlineMs = cfg.tradeAcceptHours * 3_600_000;
  const rows = await db
    .select({ id: tradeOffers.id })
    .from(tradeOffers)
    .where(inArray(tradeOffers.status, ["SENT", "IN_ESCROW"]))
    .limit(200);

  const result = { accepted: 0, escrow: 0, declined: 0, timedOut: 0, cancelledRefund: 0, errors: 0, waiting: 0 };
  for (const { id } of rows) {
    try {
      const ctx = await loadContext(id);
      const steamOfferId = ctx?.offer.steamOfferId;
      const botId = ctx?.offer.botAccountId;
      if (!ctx || !steamOfferId || !botId) continue;
      const { offer, order } = ctx;
      const client = clients[botId];
      if (!client) continue;

      if (order.status === "REFUNDED" && offer.status === "SENT") {
        await client.cancelOffer(steamOfferId);
        await finish(offer.id, "DECLINED", "cancelled_after_refund", now);
        result.cancelledRefund++;
        continue;
      }

      const state = await client.getOfferState(steamOfferId);
      if (state === "Accepted") {
        await finish(offer.id, "ACCEPTED", null, now);
        const done = await db
          .update(orders)
          .set({ status: "DELIVERED", deliveredAt: now })
          .where(and(eq(orders.id, order.id), inArray(orders.status, ["TRADE_SENT", "PAID"])))
          .returning({ id: orders.id });
        if (done.length) await db.insert(auditLog).values({ actor: "worker", action: "trade.accepted", entity: "order", entityId: order.id, data: {} });
        result.accepted++;
      } else if (state === "InEscrow") {
        if (offer.status !== "IN_ESCROW") {
          await db.update(tradeOffers).set({ status: "IN_ESCROW", updatedAt: now }).where(eq(tradeOffers.id, offer.id));
        }
        result.escrow++;
      } else if (FAILED_STATES.includes(state)) {
        await finish(offer.id, "DECLINED", stateText[state] ?? state, now);
        await markOrderProblem(order.id, `trade_${state.toLowerCase()}`);
        result.declined++;
      } else if (offer.status === "SENT" && offer.sentAt && now.getTime() - offer.sentAt.getTime() > deadlineMs) {
        await client.cancelOffer(steamOfferId);
        await finish(offer.id, "DECLINED", "не принят вовремя", now);
        await markOrderProblem(order.id, "trade_not_accepted_in_time");
        result.timedOut++;
      } else {
        result.waiting++;
      }
    } catch (e) {
      result.errors++;
      await db
        .update(tradeOffers)
        .set({ lastError: `poll: ${(e as Error).message}`.slice(0, 500), updatedAt: now })
        .where(eq(tradeOffers.id, id));
    }
  }
  return result;
}

async function finish(id: string, status: "ACCEPTED" | "DECLINED", error: string | null, now: Date) {
  await db.update(tradeOffers).set({ status, lastError: error, finishedAt: now, updatedAt: now }).where(eq(tradeOffers.id, id));
}

// ---------- Боты ----------

/** Регистрирует бота по SteamID (секреты в базу не пишутся — они только в env воркера). */
export async function upsertBotAccount(name: string, steamId: string) {
  const [row] = await db
    .insert(botAccounts)
    .values({ name, steamId, status: "ONLINE", lastHeartbeatAt: new Date() })
    .onConflictDoUpdate({ target: botAccounts.steamId, set: { name, status: "ONLINE", lastHeartbeatAt: new Date(), lastError: null } })
    .returning();
  return row;
}

export async function botHeartbeat(botId: string, status: "ONLINE" | "OFFLINE" | "ERROR", error?: string) {
  await db
    .update(botAccounts)
    .set({ status, lastHeartbeatAt: new Date(), ...(error !== undefined ? { lastError: error.slice(0, 500) } : status === "ONLINE" ? { lastError: null } : {}) })
    .where(eq(botAccounts.id, botId));
}

export const tradeQueueStats = () =>
  db
    .select({ status: tradeOffers.status, n: sql<number>`count(*)::int` })
    .from(tradeOffers)
    .groupBy(tradeOffers.status);
