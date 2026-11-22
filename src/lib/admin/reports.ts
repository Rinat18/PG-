import { and, desc, gte, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { assertCan } from "./rbac";

const PAID = sql`('PAID','TRADE_SENT','DELIVERED','REFUNDED')`;

export type Period = { from: Date; to: Date }; // to — не включительно

export function parsePeriod(from?: string, to?: string): Period {
  const d = (s: string | undefined, fallback: Date) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00+06:00`) : fallback);
  const today = new Date(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bishkek" }) + "T00:00:00+06:00");
  const end = d(to, today);
  return { from: d(from, new Date(today.getTime() - 29 * 86_400_000)), to: new Date(end.getTime() + 86_400_000) };
}

/** Продажи (по дате оплаты, включая потом возвращенные) и возвраты (по дате возврата) за период, время Бишкека. */
export async function salesReport(actor: SessionUser | null, p: Period) {
  assertCan(actor, "reports.view");
  const days = await db.execute<{ day: string; orders: number; revenue: number }>(sql`
    select to_char(paid_at at time zone 'Asia/Bishkek', 'YYYY-MM-DD') as day, count(*)::int as orders, sum(total_minor)::int as revenue
    from orders where status in ${PAID} and paid_at >= ${p.from} and paid_at < ${p.to}
    group by 1 order by 1`);
  const byType = await db.execute<{ type: string; items: number; revenue: number }>(sql`
    select oi.type_snapshot as type, count(*)::int as items, sum(oi.price_minor)::int as revenue
    from order_items oi join orders o on o.id = oi.order_id
    where o.status in ${PAID} and o.paid_at >= ${p.from} and o.paid_at < ${p.to}
    group by 1 order by 3 desc`);
  const [ref] = (
    await db.execute<{ count: number; sum: number }>(sql`
      select count(*)::int as count, coalesce(sum(amount_minor), 0)::int as sum
      from refunds where status = 'DONE' and done_at >= ${p.from} and done_at < ${p.to}`)
  ).rows;
  const revenue = days.rows.reduce((s, r) => s + Number(r.revenue), 0);
  const ordersCount = days.rows.reduce((s, r) => s + Number(r.orders), 0);
  return {
    days: days.rows.map((r) => ({ ...r, orders: Number(r.orders), revenue: Number(r.revenue) })),
    byType: byType.rows.map((r) => ({ ...r, items: Number(r.items), revenue: Number(r.revenue) })),
    totals: { orders: ordersCount, revenue, refunds: Number(ref.count), refundedMinor: Number(ref.sum), net: revenue - Number(ref.sum) },
  };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // защита от формул в Excel
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",;\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export function toCsv(rows: unknown[][]): string {
  return "﻿" + rows.map((r) => r.map(csvCell).join(";")).join("\r\n") + "\r\n";
}

/** Выгрузка заказов и возвратов за период в CSV (открывается в Excel). */
export async function exportOrdersCsv(actor: SessionUser | null, p: Period) {
  assertCan(actor, "reports.view");
  const rows = await db.execute<Record<string, unknown>>(sql`
    select o.number, to_char(o.paid_at at time zone 'Asia/Bishkek', 'YYYY-MM-DD HH24:MI') as paid_at, o.status, o.email,
      string_agg(oi.title_snapshot, ', ') as items, o.total_minor,
      (select coalesce(sum(r.amount_minor), 0) from refunds r join payments p on p.id = r.payment_id
        where p.order_id = o.id and r.status = 'DONE') as refunded_minor
    from orders o join order_items oi on oi.order_id = o.id
    where o.paid_at >= ${p.from} and o.paid_at < ${p.to}
    group by o.id order by o.paid_at`);
  return toCsv([
    ["Номер", "Оплачен", "Статус", "Email", "Товары", "Сумма, сом", "Возвращено, сом"],
    ...rows.rows.map((r) => [
      r.number,
      r.paid_at,
      r.status,
      r.email,
      r.items,
      (Number(r.total_minor) / 100).toFixed(2),
      (Number(r.refunded_minor) / 100).toFixed(2),
    ]),
  ]);
}

/** История сделок P2P за период — по запросу провайдера (ТЗ 5.1). */
export async function exportDealsCsv(actor: SessionUser | null, p: Period) {
  assertCan(actor, "deals.manage");
  const rows = await db.execute<Record<string, unknown>>(sql`
    select d.id, o.number, to_char(d.created_at at time zone 'Asia/Bishkek', 'YYYY-MM-DD HH24:MI') as created, d.status,
      l.title, l.game, d.price_minor, d.commission_minor, l.market_price_minor,
      s.steam_id as seller_steam, b.steam_id as buyer_steam,
      to_char(d.transferred_at at time zone 'Asia/Bishkek', 'YYYY-MM-DD HH24:MI') as transferred,
      d.review_reason, d.dispute_reason, d.cancel_reason,
      (select string_agg(py.status::text || ' ' || py.amount_minor, ', ') from payouts py where py.deal_id = d.id) as payouts
    from deals d join listings l on l.id = d.listing_id join orders o on o.id = d.order_id
    join users s on s.id = d.seller_id left join users b on b.id = d.buyer_id
    where d.created_at >= ${p.from} and d.created_at < ${p.to}
    order by d.created_at`);
  return toCsv([
    ["Сделка", "Заказ", "Создана", "Статус", "Предмет", "Игра", "Цена, сом", "Комиссия, сом", "Рыночная, сом", "Продавец SteamID", "Покупатель SteamID", "Передан", "Проверка", "Спор", "Отмена", "Выплаты"],
    ...rows.rows.map((r) => [
      r.id, r.number, r.created, r.status, r.title, r.game,
      (Number(r.price_minor) / 100).toFixed(2), (Number(r.commission_minor) / 100).toFixed(2),
      r.market_price_minor === null ? "" : (Number(r.market_price_minor) / 100).toFixed(2),
      r.seller_steam, r.buyer_steam, r.transferred, r.review_reason, r.dispute_reason, r.cancel_reason, r.payouts,
    ]),
  ]);
}

/** Реестр выплат продавцам за период (реквизиты — только маской). */
export async function exportPayoutsCsv(actor: SessionUser | null, p: Period) {
  assertCan(actor, "deals.manage");
  const rows = await db.execute<Record<string, unknown>>(sql`
    select py.id, to_char(py.created_at at time zone 'Asia/Bishkek', 'YYYY-MM-DD HH24:MI') as created, py.status, py.amount_minor,
      u.steam_id, u.display_name, py.deal_id, py.provider_payout_id, py.requested_by, py.error
    from payouts py join users u on u.id = py.seller_id
    where py.created_at >= ${p.from} and py.created_at < ${p.to}
    order by py.created_at`);
  return toCsv([
    ["Выплата", "Создана", "Статус", "Сумма, сом", "Продавец SteamID", "Продавец", "Сделка", "ID у провайдера", "Инициатор", "Ошибка"],
    ...rows.rows.map((r) => [
      r.id, r.created, r.status, (Number(r.amount_minor) / 100).toFixed(2), r.steam_id, r.display_name, r.deal_id, r.provider_payout_id, r.requested_by, r.error,
    ]),
  ]);
}

export async function dashboardStats(actor: SessionUser | null) {
  assertCan(actor, "dashboard.view");
  const [r] = (
    await db.execute<Record<string, number>>(sql`
      select
        (select count(*) from users)::int as clients,
        (select count(*) from users where created_at > now() - interval '30 days')::int as new_clients,
        (select count(distinct email) from orders where user_id is null)::int as guest_emails,
        (select count(*) from orders where status in ${PAID} and paid_at > now() - interval '1 day')::int as orders_day,
        (select coalesce(sum(total_minor), 0) from orders where status in ${PAID} and paid_at > now() - interval '1 day')::int as revenue_day,
        (select coalesce(sum(total_minor), 0) from orders where status in ${PAID} and paid_at > now() - interval '30 days')::int as revenue_30d,
        (select count(*) from orders where needs_review)::int as needs_review,
        (select count(*) from orders o where o.status = 'PAID' and exists (select 1 from order_items oi
          where oi.order_id = o.id and oi.delivery_method in ('MANUAL','STEAM_GIFT')))::int as manual_queue,
        (select count(*) from refunds where status = 'FAILED')::int as failed_refunds,
        (select count(*) from orders where status = 'PROBLEM')::int as problems,
        (select coalesce(sum(amount_minor), 0) from balance_entries)::int as sellers_balance,
        (select count(*) from seller_profiles where verification_status = 'PENDING')::int as verification_queue,
        (select count(*) from bot_accounts where is_active and (status <> 'ONLINE' or last_heartbeat_at < now() - interval '5 minutes'))::int as bots_down,
        (select count(*) from trade_offers where status = 'QUEUED')::int as trades_queued,
        (select count(*) from deals where status = 'REVIEW')::int as deals_review,
        (select count(*) from deals where status = 'DISPUTE')::int as deals_dispute
    `)
  ).rows;
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)])) as Record<string, number>;
}

export async function listAudit(actor: SessionUser | null, p?: Period) {
  assertCan(actor, "audit.view");
  return db
    .select()
    .from(auditLog)
    .where(p ? and(gte(auditLog.createdAt, p.from), lt(auditLog.createdAt, p.to)) : undefined)
    .orderBy(desc(auditLog.createdAt))
    .limit(300);
}
