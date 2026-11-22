import { and, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { deals, listings, orderItems, orders, payments, payouts, refunds, sellerProfiles, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { parseTradeUrl } from "@/lib/auth/steam-id";
import { writeAudit } from "@/lib/audit";
import { APP_ID, type SkinGame, type SteamItem } from "@/lib/bots/inventory";
import { env } from "@/lib/env";
import { queueEmail } from "@/lib/email/outbox";
import { formatKgs } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { AdminActionError } from "@/lib/admin/orders";
import { sendPayout } from "@/lib/admin/balances";
import { actorOf, assertCan } from "@/lib/admin/rbac";
import { processRefund } from "@/lib/orders/service";
import { findLinks, linkReasonLabel } from "./fingerprints";
import { getInventoryApi, mockTransferItem, type InventoryApi } from "./inventory";
import { priceDeviationPercent } from "./market-price";

/**
 * Сделка P2P (ТЗ 5.1): «Оплачена» → «Ожидает передачи» → «Передана» → «Защита от отката» → «Выплачена»;
 * ветки «Спор», «Отменена», «На проверке».
 *
 * Деньги покупателя держит провайдер, продавцу они уходят только после окончания защиты от отката.
 * Не передал вовремя — сделка отменяется, покупателю полный возврат.
 */

export const dealStatusLabel: Record<string, string> = {
  PAID: "Оплачена",
  AWAITING_TRANSFER: "Ожидает передачи",
  TRANSFERRED: "Передана",
  PROTECTION: "Защита от отката",
  PAID_OUT: "Выплачена",
  DISPUTE: "Спор",
  CANCELLED: "Отменена",
  REVIEW: "На проверке",
};

/** Подпись статуса с учетом того, что после защиты сделка ждет выплату. */
export function dealStage(d: Pick<typeof deals.$inferSelect, "status" | "earningCreditedAt">) {
  if (d.status === "PROTECTION" && d.earningCreditedAt) return "Ожидает выплаты";
  return dealStatusLabel[d.status] ?? d.status;
}

const commissionOf = (priceMinor: number, percent: number) => Math.round((priceMinor * percent) / 100);
const sellerAmount = (d: Pick<typeof deals.$inferSelect, "priceMinor" | "commissionMinor">) => d.priceMinor - d.commissionMinor;
const dealUrl = (id: string) => `${env.APP_URL}/sell/deals/${id}`;

// ---------- Создание при оплате ----------

/**
 * Вызывается из обработки webhook в той же транзакции, что и перевод заказа в «Оплачен».
 * Связанные аккаунты и цена вне рынка → «На проверке» (передача не начинается, пока комплаенс не одобрит).
 */
export async function createDealForItem(
  tx: Tx,
  order: typeof orders.$inferSelect,
  item: typeof orderItems.$inferSelect,
): Promise<{ dealId: string } | { problem: string }> {
  const [listing] = await tx.select().from(listings).where(eq(listings.id, item.listingId!)).for("update");
  if (!listing || listing.status !== "RESERVED" || listing.reservedByOrderId !== order.id) return { problem: "listing_unavailable" };
  await tx.update(listings).set({ status: "SOLD", reservedUntil: null }).where(eq(listings.id, listing.id));

  const cfg = await getSettings();
  const reasons: string[] = [];
  if (order.userId) {
    const links = await findLinks(order.userId, listing.sellerId, tx);
    if (links.length) reasons.push(`связанные аккаунты: ${links.map((l) => linkReasonLabel[l]).join(", ")}`);
  }
  const deviation = priceDeviationPercent(listing.priceMinor, listing.marketPriceMinor);
  if (deviation === null) reasons.push("нет рыночной цены предмета");
  else if (deviation > cfg.p2pMaxPriceDeviationPercent) reasons.push(`цена отличается от рыночной на ${deviation}%`);
  const [seller] = await tx.select({ blocked: users.isBlocked }).from(users).where(eq(users.id, listing.sellerId));
  if (seller?.blocked) reasons.push("продавец заблокирован");

  const review = reasons.length > 0;
  const now = new Date();
  const [deal] = await tx
    .insert(deals)
    .values({
      listingId: listing.id,
      orderId: order.id,
      sellerId: listing.sellerId,
      buyerId: order.userId,
      status: review ? "REVIEW" : "AWAITING_TRANSFER",
      priceMinor: item.priceMinor,
      commissionMinor: commissionOf(item.priceMinor, cfg.p2pCommissionPercent),
      transferDeadline: review ? null : new Date(now.getTime() + cfg.p2pTransferHours * 3_600_000),
      reviewReason: review ? reasons.join("; ") : null,
    })
    .returning({ id: deals.id });
  await tx.insert(sellerProfiles).values({ userId: listing.sellerId }).onConflictDoNothing();
  await writeAudit("system", review ? "deal.review" : "deal.created", "deal", deal.id, { orderId: order.id, reasons }, tx);
  return { dealId: deal.id };
}

/** Письмо продавцу «лот продан» — после коммита оплаты (для сделок на проверке — после одобрения). */
export async function notifyDealStarted(dealId: string) {
  const [row] = await db
    .select({ deal: deals, listing: listings, sellerEmail: users.email })
    .from(deals)
    .innerJoin(listings, eq(listings.id, deals.listingId))
    .innerJoin(users, eq(users.id, deals.sellerId))
    .where(eq(deals.id, dealId));
  if (!row || row.deal.status !== "AWAITING_TRANSFER" || !row.deal.transferDeadline || !row.sellerEmail) return;
  await queueEmail(row.sellerEmail, "lotSold", {
    title: row.listing.title,
    priceMinor: row.deal.priceMinor,
    payoutMinor: sellerAmount(row.deal),
    deadline: row.deal.transferDeadline,
    dealUrl: dealUrl(dealId),
  });
}

// ---------- Проверка передачи и выплаты (крон / воркер) ----------

type DealCtx = { deal: typeof deals.$inferSelect; listing: typeof listings.$inferSelect; order: typeof orders.$inferSelect; item: typeof orderItems.$inferSelect };

async function loadDeal(dealId: string): Promise<DealCtx | undefined> {
  const [row] = await db
    .select({ deal: deals, listing: listings, order: orders, item: orderItems })
    .from(deals)
    .innerJoin(listings, eq(listings.id, deals.listingId))
    .innerJoin(orders, eq(orders.id, deals.orderId))
    .innerJoin(orderItems, and(eq(orderItems.orderId, deals.orderId), eq(orderItems.listingId, deals.listingId)))
    .where(eq(deals.id, dealId));
  return row;
}

/** Предмет, пришедший покупателю: то же название (и classid, если известен), assetid не из списка «было до сделки». */
export function findReceivedItem(inventory: SteamItem[], ctx: Pick<DealCtx, "listing" | "item">): SteamItem | undefined {
  const baseline = new Set(ctx.item.buyerBaselineAssetIds ?? []);
  const { skin } = ctx.listing;
  return inventory.find(
    (i) =>
      i.market_hash_name === skin.marketHashName &&
      !baseline.has(i.assetid) &&
      (!skin.classId || !i.classid || i.classid === skin.classId),
  );
}

export type ProcessDealsResult = {
  transferred: number;
  cancelled: number;
  reminded: number;
  earned: number;
  paidOut: number;
  payoutBlocked: number;
  disputes: number;
  errors: number;
};

/**
 * Один проход по активным сделкам. Каждая сделка — отдельно, в своем try/catch.
 * minIntervalMs — не чаще одной проверки сделки в Steam за этот интервал (лимиты Steam).
 */
export async function processDeals(opts: { now?: Date; inventory?: InventoryApi; minIntervalMs?: number } = {}): Promise<ProcessDealsResult> {
  const now = opts.now ?? new Date();
  const api = opts.inventory ?? getInventoryApi();
  const minInterval = opts.minIntervalMs ?? 2 * 60_000;
  const res: ProcessDealsResult = { transferred: 0, cancelled: 0, reminded: 0, earned: 0, paidOut: 0, payoutBlocked: 0, disputes: 0, errors: 0 };

  const due = await db
    .select({ id: deals.id })
    .from(deals)
    .where(
      and(
        inArray(deals.status, ["AWAITING_TRANSFER", "PROTECTION"]),
        or(isNull(deals.lastCheckAt), lte(deals.lastCheckAt, new Date(now.getTime() - minInterval))),
      ),
    )
    .orderBy(deals.createdAt)
    .limit(100);

  for (const { id } of due) {
    try {
      const ctx = await loadDeal(id);
      if (!ctx) continue;
      await db.update(deals).set({ lastCheckAt: now }).where(eq(deals.id, id));
      if (ctx.deal.status === "AWAITING_TRANSFER") await checkTransfer(ctx, api, now, res);
      else if (!ctx.deal.earningCreditedAt) {
        if (ctx.deal.protectionUntil && ctx.deal.protectionUntil <= now) await finishProtection(ctx, api, now, res);
      } else {
        const r = await payoutDeal(id);
        if (r === "sent") res.paidOut++;
        else if (r === "blocked") res.payoutBlocked++;
      }
    } catch (e) {
      res.errors++;
      await db
        .update(deals)
        .set({ lastCheckError: (e as Error).message.slice(0, 500), updatedAt: now })
        .where(eq(deals.id, id));
    }
  }
  return res;
}

async function checkTransfer(ctx: DealCtx, api: InventoryApi, now: Date, res: ProcessDealsResult) {
  const { deal, listing, order } = ctx;
  const buyer = order.tradeUrl ? parseTradeUrl(order.tradeUrl) : null;
  const deadline = deal.transferDeadline!;
  if (!buyer) {
    await toReview(deal.id, "у заказа нет trade-ссылки покупателя", now);
    return;
  }

  const inventory = await api.getInventory(buyer.steamId, APP_ID[listing.game as SkinGame]);
  if (!inventory) {
    await db.update(deals).set({ lastCheckError: "инвентарь покупателя недоступен", updatedAt: now }).where(eq(deals.id, deal.id));
    // Steam долго не отвечает или покупатель закрыл инвентарь после дедлайна — решает человек
    if (now.getTime() > deadline.getTime() + 6 * 3_600_000) await toReview(deal.id, "не удалось проверить передачу: инвентарь покупателя недоступен", now);
    return;
  }

  const received = findReceivedItem(inventory, ctx);
  if (received) {
    const cfg = await getSettings();
    const moved = await db
      .update(deals)
      .set({
        status: "PROTECTION",
        transferredAt: now,
        receivedAssetId: received.assetid,
        protectionUntil: new Date(now.getTime() + cfg.p2pProtectionDays * 86_400_000),
        lastCheckError: null,
        updatedAt: now,
      })
      .where(and(eq(deals.id, deal.id), eq(deals.status, "AWAITING_TRANSFER")))
      .returning({ id: deals.id });
    if (!moved.length) return;
    await db
      .update(orders)
      .set({ status: "DELIVERED", deliveredAt: now })
      .where(and(eq(orders.id, order.id), inArray(orders.status, ["PAID", "TRADE_SENT"])));
    await writeAudit("system", "deal.transferred", "deal", deal.id, { receivedAssetId: received.assetid });
    await queueEmail(order.email, "orderDelivered", {
      number: order.number,
      items: [listing.title],
      note: "Продавец передал предмет, мы проверили его получение через Steam.",
      orderUrl: `${env.APP_URL}/order/${order.accessToken}`,
    });
    res.transferred++;
    return;
  }

  if (now > deadline) {
    await cancelDeal(deal.id, "not_transferred", "system", "Продавец не передал скин вовремя");
    res.cancelled++;
    return;
  }

  const hoursLeft = Math.ceil((deadline.getTime() - now.getTime()) / 3_600_000);
  if (hoursLeft <= 3 && !deal.reminderSentAt) {
    await db.update(deals).set({ reminderSentAt: now }).where(eq(deals.id, deal.id));
    const [seller] = await db.select({ email: users.email }).from(users).where(eq(users.id, deal.sellerId));
    if (seller?.email) {
      await queueEmail(seller.email, "transferReminder", { title: listing.title, deadline, hoursLeft, dealUrl: dealUrl(deal.id) });
    }
    res.reminded++;
  }
}

/** Конец защиты от отката: предмет все еще у покупателя → заработок на баланс продавца и выплата. */
async function finishProtection(ctx: DealCtx, api: InventoryApi, now: Date, res: ProcessDealsResult) {
  const { deal, listing, order } = ctx;
  const buyer = order.tradeUrl ? parseTradeUrl(order.tradeUrl) : null;
  const inventory = buyer ? await api.getInventory(buyer.steamId, APP_ID[listing.game as SkinGame]) : null;
  if (!inventory) {
    await db.update(deals).set({ lastCheckError: "инвентарь покупателя недоступен", updatedAt: now }).where(eq(deals.id, deal.id));
    return;
  }
  if (!inventory.some((i) => i.assetid === deal.receivedAssetId)) {
    // откат обмена Steam или предмет ушел дальше — решает комплаенс, деньги продавцу не уходят
    await db
      .update(deals)
      .set({
        status: "DISPUTE",
        statusBeforeDispute: "PROTECTION",
        disputeReason: "предмет пропал из инвентаря покупателя до конца защиты от отката (возможен откат обмена Steam)",
        updatedAt: now,
      })
      .where(and(eq(deals.id, deal.id), eq(deals.status, "PROTECTION")));
    await writeAudit("system", "deal.item_missing", "deal", deal.id);
    res.disputes++;
    return;
  }

  const credited = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(deals).where(eq(deals.id, deal.id)).for("update");
    if (locked.status !== "PROTECTION" || locked.earningCreditedAt) return false;
    await tx.update(deals).set({ earningCreditedAt: now, updatedAt: now }).where(eq(deals.id, deal.id));
    await tx.execute(sql`insert into balance_entries (seller_id, kind, amount_minor, deal_id, reason, actor)
      values (${deal.sellerId}, 'DEAL_EARNING', ${sellerAmount(deal)}, ${deal.id},
        ${`Сделка по заказу ${order.number}: ${formatKgs(deal.priceMinor)} минус комиссия ${formatKgs(deal.commissionMinor)}`}, 'system')`);
    await writeAudit("system", "deal.earning_credited", "deal", deal.id, { amountMinor: sellerAmount(deal) }, tx);
    return true;
  });
  if (!credited) return;
  res.earned++;
  const r = await payoutDeal(deal.id);
  if (r === "sent") res.paidOut++;
  else if (r === "blocked") res.payoutBlocked++;
}

/**
 * Выплата по сделке на реквизиты продавца. Без одобренной верификации, без реквизитов на его имя
 * и сверх лимитов — не уходит (деньги остаются на балансе, причина видна продавцу и в админке).
 */
export async function payoutDeal(dealId: string): Promise<"sent" | "blocked" | "skipped"> {
  const [deal] = await db.select().from(deals).where(eq(deals.id, dealId));
  if (!deal || deal.status !== "PROTECTION" || !deal.earningCreditedAt) return "skipped";
  const [live] = await db
    .select({ id: payouts.id })
    .from(payouts)
    .where(and(eq(payouts.dealId, dealId), inArray(payouts.status, ["PENDING", "SENT"])));
  if (live) return "skipped";

  const amount = sellerAmount(deal);
  try {
    const r = await sendPayout({ sellerId: deal.sellerId, amountMinor: amount, actor: "system", dealId });
    if (r.status === "SENT") {
      await db.update(deals).set({ status: "PAID_OUT", payoutError: null, updatedAt: new Date() }).where(eq(deals.id, dealId));
      await writeAudit("system", "deal.paid_out", "deal", dealId, { payoutId: r.payoutId });
      return "sent";
    }
    await db.update(deals).set({ payoutError: `Сервис выплат: ${r.error}`.slice(0, 500), updatedAt: new Date() }).where(eq(deals.id, dealId));
    return "blocked";
  } catch (e) {
    if (!(e instanceof AdminActionError)) throw e;
    await db.update(deals).set({ payoutError: e.message, updatedAt: new Date() }).where(eq(deals.id, dealId));
    return "blocked";
  }
}

// ---------- Отмена с возвратом ----------

/**
 * Отмена сделки с полным возвратом покупателю. Нельзя, если заработок уже начислен продавцу:
 * тогда сначала корректировка баланса в админке.
 */
export async function cancelDeal(dealId: string, reason: string, actor: string, note?: string) {
  const refundId = await db.transaction(async (tx) => {
    const [deal] = await tx.select().from(deals).where(eq(deals.id, dealId)).for("update");
    if (!deal) throw new AdminActionError("Сделка не найдена");
    if (deal.status === "CANCELLED" || deal.status === "PAID_OUT") throw new AdminActionError(`Сделка уже ${dealStatusLabel[deal.status].toLowerCase()}`);
    if (deal.earningCreditedAt) throw new AdminActionError("Заработок уже начислен продавцу: сначала скорректируйте его баланс");

    await tx.update(deals).set({ status: "CANCELLED", cancelReason: reason, updatedAt: new Date() }).where(eq(deals.id, dealId));
    await tx.update(listings).set({ status: "WITHDRAWN" }).where(and(eq(listings.id, deal.listingId), eq(listings.status, "SOLD")));
    await tx
      .update(orders)
      .set({ status: "PROBLEM", problemReason: `deal_cancelled: ${reason}` })
      .where(and(eq(orders.id, deal.orderId), inArray(orders.status, ["PAID", "TRADE_SENT", "DELIVERED", "PROBLEM"])));

    const [payment] = await tx.select().from(payments).where(eq(payments.orderId, deal.orderId));
    let refund: string | null = null;
    if (payment?.status === "SUCCEEDED") {
      const existing = await tx.select().from(refunds).where(eq(refunds.paymentId, payment.id));
      const active = existing.find((r) => r.status !== "FAILED");
      if (active) refund = active.id;
      else {
        const [r] = await tx
          .insert(refunds)
          .values({ paymentId: payment.id, amountMinor: payment.amountMinor, reason: `p2p: ${note ?? reason}`, requestedBy: actor })
          .returning({ id: refunds.id });
        refund = r.id;
      }
    }
    await writeAudit(actor, "deal.cancelled", "deal", dealId, { reason, refundId: refund }, tx);
    return refund;
  });
  if (refundId) await processRefund(refundId);
  return refundId;
}

/** Хук для возврата заказа из админки: сделка отменяется, заработок продавцу не начисляется. */
export async function cancelDealForRefundedOrder(tx: Tx, orderId: string, actor: string) {
  const [deal] = await tx.select().from(deals).where(eq(deals.orderId, orderId)).for("update");
  if (!deal || deal.status === "CANCELLED") return;
  if (deal.earningCreditedAt || deal.status === "PAID_OUT") {
    throw new AdminActionError("По сделке уже начислен заработок продавцу: сначала скорректируйте его баланс");
  }
  await tx.update(deals).set({ status: "CANCELLED", cancelReason: "refunded_by_admin", updatedAt: new Date() }).where(eq(deals.id, deal.id));
  await tx.update(listings).set({ status: "WITHDRAWN" }).where(and(eq(listings.id, deal.listingId), eq(listings.status, "SOLD")));
  await writeAudit(actor, "deal.cancelled", "deal", deal.id, { reason: "refunded_by_admin" }, tx);
}

async function toReview(dealId: string, reason: string, now: Date) {
  await db
    .update(deals)
    .set({ status: "REVIEW", reviewReason: reason, updatedAt: now })
    .where(and(eq(deals.id, dealId), inArray(deals.status, ["AWAITING_TRANSFER", "PAID"])));
  await writeAudit("system", "deal.review", "deal", dealId, { reasons: [reason] });
}

// ---------- Покупатель и продавец ----------

export async function getDealForOrder(orderId: string) {
  const [row] = await db
    .select({ deal: deals, listing: listings, sellerName: users.displayName })
    .from(deals)
    .innerJoin(listings, eq(listings.id, deals.listingId))
    .innerJoin(users, eq(users.id, deals.sellerId))
    .where(eq(deals.orderId, orderId));
  return row ?? null;
}

/** Спор открывает покупатель по ссылке заказа: скин не пришел или не соответствует карточке. */
export async function openDisputeByBuyer(orderAccessToken: string, reason: string) {
  const why = reason.trim();
  if (why.length < 10) throw new AdminActionError("Опишите проблему (минимум 10 символов)");
  const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.accessToken, orderAccessToken));
  if (!order) throw new AdminActionError("Заказ не найден");
  const [deal] = await db.select().from(deals).where(eq(deals.orderId, order.id));
  if (!deal || !["AWAITING_TRANSFER", "PROTECTION"].includes(deal.status) || deal.earningCreditedAt) {
    throw new AdminActionError("По этой сделке спор открыть нельзя: напишите в поддержку");
  }
  const res = await db
    .update(deals)
    .set({ status: "DISPUTE", statusBeforeDispute: deal.status, disputeReason: why.slice(0, 1000), updatedAt: new Date() })
    .where(and(eq(deals.id, deal.id), eq(deals.status, deal.status)))
    .returning({ id: deals.id });
  if (!res.length) throw new AdminActionError("Статус сделки изменился, обновите страницу");
  await writeAudit("buyer", "deal.dispute_opened", "deal", deal.id, { reason: why });
}

export async function getDealForSeller(user: SessionUser, dealId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(dealId)) return null;
  const ctx = await loadDeal(dealId);
  if (!ctx || ctx.deal.sellerId !== user.id) return null;
  const show = ["AWAITING_TRANSFER", "DISPUTE"].includes(ctx.deal.status);
  return {
    deal: ctx.deal,
    listing: ctx.listing,
    orderNumber: ctx.order.number,
    // trade-ссылку покупателя продавец видит только пока нужно передать предмет
    buyerTradeUrl: show ? ctx.order.tradeUrl : null,
    stage: dealStage(ctx.deal),
    payoutMinor: sellerAmount(ctx.deal),
  };
}

/** Продавец отказывается от сделки — покупателю полный возврат, отказ портит рейтинг продавца. */
export async function declineDealBySeller(user: SessionUser, dealId: string) {
  const [deal] = await db.select().from(deals).where(eq(deals.id, dealId));
  if (!deal || deal.sellerId !== user.id) throw new AdminActionError("Сделка не найдена");
  if (!["AWAITING_TRANSFER", "REVIEW"].includes(deal.status)) throw new AdminActionError("Отказаться можно только до передачи предмета");
  await cancelDeal(dealId, "seller_declined", `user:${user.id}`, "Продавец отказался от сделки");
}

/** Только mock-режим: «передать» предмет покупателю в тестовом инвентаре. */
export async function mockTransferForDeal(user: SessionUser, dealId: string) {
  if (env.STEAM_CHECKS !== "mock") throw new AdminActionError("Доступно только в режиме разработки");
  const ctx = await loadDeal(dealId);
  if (!ctx || ctx.deal.sellerId !== user.id || ctx.deal.status !== "AWAITING_TRANSFER") throw new AdminActionError("Сделка не ожидает передачи");
  const buyer = ctx.order.tradeUrl ? parseTradeUrl(ctx.order.tradeUrl) : null;
  if (!buyer || !user.steamId) throw new AdminActionError("Нет Steam-аккаунтов сторон");
  const newId = await mockTransferItem(user.steamId, buyer.steamId, ctx.listing.assetId);
  if (!newId) throw new AdminActionError("Предмета уже нет в инвентаре продавца");
  await db.update(deals).set({ lastCheckAt: null }).where(eq(deals.id, dealId)); // проверить на следующем проходе
}

// ---------- Админка ----------

export const DEAL_STATUSES = Object.keys(dealStatusLabel);

export async function listDealsAdmin(actor: SessionUser | null, f: { status?: string; q?: string } = {}) {
  assertCan(actor, "deals.view");
  const where = [];
  if (f.status && DEAL_STATUSES.includes(f.status)) where.push(eq(deals.status, f.status as typeof deals.$inferSelect.status));
  if (f.q?.trim()) where.push(sql`(${orders.number} ilike ${`%${f.q.trim().replace(/[%_]/g, "")}%`} or ${listings.title} ilike ${`%${f.q.trim().replace(/[%_]/g, "")}%`})`);
  return db
    .select({ deal: deals, title: listings.title, orderNumber: orders.number, sellerName: users.displayName })
    .from(deals)
    .innerJoin(listings, eq(listings.id, deals.listingId))
    .innerJoin(orders, eq(orders.id, deals.orderId))
    .innerJoin(users, eq(users.id, deals.sellerId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(sql`case when ${deals.status} in ('REVIEW', 'DISPUTE') then 0 else 1 end`, desc(deals.createdAt))
    .limit(300);
}

export async function getDealAdmin(actor: SessionUser | null, dealId: string) {
  assertCan(actor, "deals.view");
  if (!/^[0-9a-f-]{36}$/i.test(dealId)) return null;
  const ctx = await loadDeal(dealId);
  if (!ctx) return null;
  const [seller] = await db.select().from(users).where(eq(users.id, ctx.deal.sellerId));
  const [buyer] = ctx.deal.buyerId ? await db.select().from(users).where(eq(users.id, ctx.deal.buyerId)) : [undefined];
  const [profile] = await db.select({ status: sellerProfiles.verificationStatus }).from(sellerProfiles).where(eq(sellerProfiles.userId, ctx.deal.sellerId));
  const dealPayouts = await db.select().from(payouts).where(eq(payouts.dealId, dealId)).orderBy(desc(payouts.createdAt));
  const links = ctx.deal.buyerId ? await findLinks(ctx.deal.buyerId, ctx.deal.sellerId) : [];
  return { ...ctx, seller, buyer, sellerVerification: profile?.status ?? "NOT_STARTED", payouts: dealPayouts, links, stage: dealStage(ctx.deal), sellerAmount: sellerAmount(ctx.deal) };
}

/** Проверка пройдена: продавцу открывается срок передачи. */
export async function approveDealReview(actor: SessionUser | null, dealId: string) {
  assertCan(actor, "deals.manage");
  const cfg = await getSettings();
  const now = new Date();
  const res = await db
    .update(deals)
    .set({ status: "AWAITING_TRANSFER", transferDeadline: new Date(now.getTime() + cfg.p2pTransferHours * 3_600_000), lastCheckAt: null, updatedAt: now })
    .where(and(eq(deals.id, dealId), eq(deals.status, "REVIEW")))
    .returning({ id: deals.id });
  if (!res.length) throw new AdminActionError("Сделка не на проверке");
  await writeAudit(actorOf(actor), "deal.review_approved", "deal", dealId);
  await notifyDealStarted(dealId);
}

export async function rejectDealReview(actor: SessionUser | null, dealId: string, reason: string) {
  assertCan(actor, "deals.manage");
  if (reason.trim().length < 5) throw new AdminActionError("Укажите причину (минимум 5 символов)");
  const [deal] = await db.select({ status: deals.status }).from(deals).where(eq(deals.id, dealId));
  if (deal?.status !== "REVIEW") throw new AdminActionError("Сделка не на проверке");
  await cancelDeal(dealId, "review_rejected", actorOf(actor), reason.trim());
}

/** Спор: в пользу покупателя — отмена и возврат; в пользу продавца — сделка продолжается с того же места. */
export async function resolveDispute(actor: SessionUser | null, dealId: string, outcome: "buyer" | "seller", note: string) {
  assertCan(actor, "deals.manage");
  if (note.trim().length < 5) throw new AdminActionError("Опишите решение (минимум 5 символов)");
  const [deal] = await db.select().from(deals).where(eq(deals.id, dealId));
  if (deal?.status !== "DISPUTE") throw new AdminActionError("Сделка не в споре");
  if (outcome === "buyer") {
    await cancelDeal(dealId, "dispute_buyer", actorOf(actor), note.trim());
  } else {
    const back = deal.statusBeforeDispute ?? "AWAITING_TRANSFER";
    const cfg = await getSettings();
    const now = new Date();
    await db
      .update(deals)
      .set({
        status: back,
        statusBeforeDispute: null,
        lastCheckAt: null,
        updatedAt: now,
        // время на передачу, съеденное спором, возвращаем
        ...(back === "AWAITING_TRANSFER" ? { transferDeadline: new Date(now.getTime() + cfg.p2pTransferHours * 3_600_000) } : {}),
      })
      .where(and(eq(deals.id, dealId), eq(deals.status, "DISPUTE")));
  }
  await writeAudit(actorOf(actor), "deal.dispute_resolved", "deal", dealId, { outcome, note: note.trim() });
}

export async function blockListing(actor: SessionUser | null, listingId: string, reason: string) {
  assertCan(actor, "deals.manage");
  if (reason.trim().length < 5) throw new AdminActionError("Укажите причину блокировки");
  const res = await db
    .update(listings)
    .set({ status: "BLOCKED", blockedReason: reason.trim() })
    .where(and(eq(listings.id, listingId), eq(listings.status, "ACTIVE")))
    .returning({ id: listings.id });
  if (!res.length) throw new AdminActionError("Лот не активен");
  await writeAudit(actorOf(actor), "listing.blocked", "listing", listingId, { reason: reason.trim() });
}

export async function listActiveListingsAdmin(actor: SessionUser | null) {
  assertCan(actor, "deals.view");
  return db
    .select({ listing: listings, sellerName: users.displayName, sellerBlocked: users.isBlocked })
    .from(listings)
    .innerJoin(users, eq(users.id, listings.sellerId))
    .where(inArray(listings.status, ["ACTIVE", "RESERVED", "BLOCKED"]))
    .orderBy(desc(listings.createdAt))
    .limit(300);
}

export async function dealQueueCounts() {
  const [r] = await db
    .select({
      review: sql<number>`count(*) filter (where ${deals.status} = 'REVIEW')::int`,
      dispute: sql<number>`count(*) filter (where ${deals.status} = 'DISPUTE')::int`,
      awaitingPayout: sql<number>`count(*) filter (where ${deals.status} = 'PROTECTION' and ${isNotNull(deals.earningCreditedAt)})::int`,
    })
    .from(deals);
  return { review: Number(r.review), dispute: Number(r.dispute), awaitingPayout: Number(r.awaitingPayout) };
}
