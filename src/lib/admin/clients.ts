import { desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { orders, sellerProfiles, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { decrypt } from "@/lib/crypto";
import { writeAudit } from "@/lib/audit";
import { getBalance } from "./balances";
import { AdminActionError } from "./orders";
import { actorOf, assertCan, can } from "./rbac";

const PAID = sql`('PAID','TRADE_SENT','DELIVERED')`;

export async function listClients(actor: SessionUser | null, q?: string) {
  assertCan(actor, "clients.view");
  const term = q?.trim().replace(/[%_]/g, "");
  const ordersCount = sql<number>`(select count(*)::int from orders o where o.user_id = ${users.id})`;
  const paidSum = sql<number>`(select coalesce(sum(o.total_minor), 0)::int from orders o where o.user_id = ${users.id} and o.status in ${PAID})`;
  const balance = sql<number>`(select coalesce(sum(be.amount_minor), 0)::int from balance_entries be where be.seller_id = ${users.id})`;
  const rows = await db
    .select({ user: users, ordersCount, paidSum, balance })
    .from(users)
    .where(term ? or(ilike(users.email, `%${term}%`), ilike(users.displayName, `%${term}%`), eq(users.steamId, term)) : undefined)
    .orderBy(desc(users.createdAt))
    .limit(300);
  return rows.map((r) => ({ ...r, ordersCount: Number(r.ordersCount), paidSum: Number(r.paidSum), balance: Number(r.balance) }));
}

/**
 * Карточка клиента. Паспортные данные продавца расшифровываются только для роли COMPLIANCE
 * (ТЗ, раздел 7), каждый просмотр пишется в журнал.
 */
export async function getClient(actor: SessionUser | null, userId: string) {
  assertCan(actor, "clients.view");
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return null;
  const userOrders = await db.select().from(orders).where(eq(orders.userId, userId)).orderBy(desc(orders.createdAt)).limit(100);
  const [profile] = await db.select().from(sellerProfiles).where(eq(sellerProfiles.userId, userId));

  let pii: { fullName: string | null; birthDate: string | null; passport: string | null; payoutDetails: string | null } | null = null;
  if (profile && can(actor, "pii.view")) {
    const d = (v: string | null) => (v ? decrypt(v) : null);
    pii = {
      fullName: d(profile.encryptedFullName),
      birthDate: d(profile.encryptedBirthDate),
      passport: d(profile.encryptedPassport),
      payoutDetails: d(profile.encryptedPayoutDetails),
    };
    await writeAudit(actorOf(actor), "pii.viewed", "user", userId);
  }
  const seller = profile
    ? {
        verificationStatus: profile.verificationStatus,
        phone: can(actor, "pii.view") ? profile.phone : null,
        hasPayoutDetails: Boolean(profile.encryptedPayoutDetails),
        dailyLimitMinor: profile.dailyLimitMinor,
        monthlyLimitMinor: profile.monthlyLimitMinor,
      }
    : null;
  const balance = can(actor, "balances.view") ? await getBalance(userId) : null;
  return { user, orders: userOrders, seller, pii, balance };
}

export async function setUserRole(actor: SessionUser | null, userId: string, role: SessionUser["role"]) {
  assertCan(actor, "users.roles");
  if (actor.id === userId) throw new AdminActionError("Нельзя менять собственную роль");
  if (!["BUYER", "ADMIN", "SUPPORT", "COMPLIANCE"].includes(role)) throw new AdminActionError("Неизвестная роль");
  const [before] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  if (!before) throw new AdminActionError("Пользователь не найден");
  await db.update(users).set({ role }).where(eq(users.id, userId));
  await writeAudit(actorOf(actor), "user.role_changed", "user", userId, { from: before.role, to: role });
}

export async function setUserBlocked(actor: SessionUser | null, userId: string, blocked: boolean) {
  assertCan(actor, "users.roles");
  if (actor.id === userId) throw new AdminActionError("Нельзя заблокировать себя");
  await db.update(users).set({ isBlocked: blocked }).where(eq(users.id, userId));
  await writeAudit(actorOf(actor), blocked ? "user.blocked" : "user.unblocked", "user", userId);
}
