import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { balanceEntries, payouts, sellerProfiles, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { decrypt } from "@/lib/crypto";
import { formatKgs } from "@/lib/format";
import { getPayoutProvider } from "@/lib/payouts";
import { getSettings } from "@/lib/settings";
import { queueEmail } from "@/lib/email/outbox";
import { maskDetails } from "@/lib/email/templates";
import { writeAudit } from "@/lib/audit";
import { AdminActionError } from "./orders";
import { actorOf, assertCan } from "./rbac";

/**
 * Баланс продавца P2P: сумма проводок balance_entries.
 * Все изменения идут под блокировкой строки seller_profiles продавца, поэтому два параллельных
 * списания не уведут баланс в минус.
 */

export async function getBalance(sellerId: string, tx: Tx | typeof db = db): Promise<number> {
  const [row] = await tx
    .select({ sum: sql<number>`coalesce(sum(${balanceEntries.amountMinor}), 0)::int` })
    .from(balanceEntries)
    .where(eq(balanceEntries.sellerId, sellerId));
  return Number(row.sum);
}

async function lockSeller(tx: Tx, sellerId: string) {
  const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, sellerId));
  if (!user) throw new AdminActionError("Пользователь не найден");
  await tx.insert(sellerProfiles).values({ userId: sellerId }).onConflictDoNothing();
  const [profile] = await tx.select().from(sellerProfiles).where(eq(sellerProfiles.userId, sellerId)).for("update");
  return profile;
}

export async function listSellerBalances(actor: SessionUser | null) {
  assertCan(actor, "balances.view");
  const rows = await db.execute<{
    id: string;
    display_name: string | null;
    email: string | null;
    steam_id: string | null;
    verification_status: string | null;
    balance: number;
    paid_out: number;
  }>(sql`
    select u.id, u.display_name, u.email, u.steam_id, sp.verification_status,
      coalesce((select sum(amount_minor) from balance_entries be where be.seller_id = u.id), 0)::int as balance,
      coalesce((select sum(amount_minor) from payouts p where p.seller_id = u.id and p.status = 'SENT'), 0)::int as paid_out
    from users u
    left join seller_profiles sp on sp.user_id = u.id
    where sp.user_id is not null or exists (select 1 from balance_entries be where be.seller_id = u.id)
    order by balance desc, u.created_at desc
    limit 500
  `);
  return rows.rows.map((r) => ({ ...r, balance: Number(r.balance), paid_out: Number(r.paid_out) }));
}

export async function getSellerLedger(actor: SessionUser | null, sellerId: string) {
  assertCan(actor, "balances.view");
  const entries = await db
    .select()
    .from(balanceEntries)
    .where(eq(balanceEntries.sellerId, sellerId))
    .orderBy(desc(balanceEntries.createdAt))
    .limit(300);
  const payoutRows = await db.select().from(payouts).where(eq(payouts.sellerId, sellerId)).orderBy(desc(payouts.createdAt)).limit(100);
  return { balance: await getBalance(sellerId), entries, payouts: payoutRows };
}

/** Ручная корректировка (+ или −) с обязательной причиной. Пополнения деньгами нет: это исправление учета. */
export async function adjustBalance(actor: SessionUser | null, sellerId: string, amountMinor: number, reason: string) {
  assertCan(actor, "balances.manage");
  if (!Number.isInteger(amountMinor) || amountMinor === 0) throw new AdminActionError("Сумма корректировки не может быть нулевой");
  if (Math.abs(amountMinor) > 100_000_000) throw new AdminActionError("Слишком большая сумма");
  const why = reason.trim();
  if (why.length < 5) throw new AdminActionError("Опишите причину корректировки (минимум 5 символов)");

  return db.transaction(async (tx) => {
    await lockSeller(tx, sellerId);
    const before = await getBalance(sellerId, tx);
    if (before + amountMinor < 0) {
      throw new AdminActionError(`Баланс не может стать отрицательным: сейчас ${formatKgs(before)}`);
    }
    await tx.insert(balanceEntries).values({ sellerId, kind: "ADJUSTMENT", amountMinor, reason: why, actor: actorOf(actor) });
    await writeAudit(actorOf(actor), "balance.adjusted", "user", sellerId, { amountMinor, reason: why, before }, tx);
    return before + amountMinor;
  });
}

/**
 * Выплата с баланса на реквизиты продавца. Условия (ТЗ, раздел 5.1):
 * верификация одобрена, реквизиты на имя продавца, сумма не больше баланса, лимиты в сутки и в месяц.
 * Списание фиксируется до вызова провайдера; если выплата не прошла — сторно на баланс.
 */
export async function createPayout(actor: SessionUser | null, sellerId: string, amountMinor: number) {
  assertCan(actor, "payouts.manage");
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new AdminActionError("Сумма выплаты должна быть больше нуля");
  const cfg = await getSettings();

  const prepared = await db.transaction(async (tx) => {
    const profile = await lockSeller(tx, sellerId);
    if (profile.verificationStatus !== "APPROVED") {
      throw new AdminActionError("Продавец не верифицирован: выплата невозможна");
    }
    if (!profile.encryptedPayoutDetails || !profile.encryptedFullName) {
      throw new AdminActionError("Нет реквизитов для выплаты на имя продавца");
    }
    const balance = await getBalance(sellerId, tx);
    if (amountMinor > balance) throw new AdminActionError(`Сумма больше баланса (${formatKgs(balance)})`);

    const sentSince = async (since: Date) => {
      const [r] = await tx
        .select({ sum: sql<number>`coalesce(sum(${payouts.amountMinor}), 0)::int` })
        .from(payouts)
        .where(and(eq(payouts.sellerId, sellerId), inArray(payouts.status, ["PENDING", "SENT"]), gte(payouts.createdAt, since)));
      return Number(r.sum);
    };
    const now = Date.now();
    const daily = profile.dailyLimitMinor ?? cfg.sellerDailyPayoutLimitSom * 100;
    const monthly = profile.monthlyLimitMinor ?? cfg.sellerMonthlyPayoutLimitSom * 100;
    if (daily > 0 && (await sentSince(new Date(now - 86_400_000))) + amountMinor > daily) {
      throw new AdminActionError(`Превышен суточный лимит выплат (${formatKgs(daily)})`);
    }
    if (monthly > 0 && (await sentSince(new Date(now - 30 * 86_400_000))) + amountMinor > monthly) {
      throw new AdminActionError(`Превышен месячный лимит выплат (${formatKgs(monthly)})`);
    }

    const [payout] = await tx
      .insert(payouts)
      .values({ sellerId, amountMinor, status: "PENDING", requestedBy: actorOf(actor) })
      .returning();
    await tx.insert(balanceEntries).values({
      sellerId,
      kind: "PAYOUT",
      amountMinor: -amountMinor,
      payoutId: payout.id,
      reason: "Выплата на реквизиты",
      actor: actorOf(actor),
    });
    await writeAudit(actorOf(actor), "payout.created", "user", sellerId, { payoutId: payout.id, amountMinor }, tx);
    return { payout, details: decrypt(profile.encryptedPayoutDetails), fullName: decrypt(profile.encryptedFullName) };
  });

  try {
    const res = await getPayoutProvider().send({
      payoutId: prepared.payout.id,
      amountMinor,
      details: prepared.details,
      fullName: prepared.fullName,
    });
    await db
      .update(payouts)
      .set({ status: "SENT", providerPayoutId: res.providerPayoutId, sentAt: new Date() })
      .where(eq(payouts.id, prepared.payout.id));
    await writeAudit(actorOf(actor), "payout.sent", "user", sellerId, { payoutId: prepared.payout.id });
    const [seller] = await db.select({ email: users.email }).from(users).where(eq(users.id, sellerId));
    if (seller?.email) {
      await queueEmail(seller.email, "payoutSent", { amountMinor, detailsMasked: maskDetails(prepared.details) });
    }
    return { payoutId: prepared.payout.id, status: "SENT" as const };
  } catch (e) {
    const error = (e as Error).message;
    await db.transaction(async (tx) => {
      await tx.update(payouts).set({ status: "FAILED", error }).where(eq(payouts.id, prepared.payout.id));
      await tx.insert(balanceEntries).values({
        sellerId,
        kind: "PAYOUT_REVERSAL",
        amountMinor,
        payoutId: prepared.payout.id,
        reason: `Выплата не прошла: ${error}`.slice(0, 500),
        actor: "system",
      });
      await writeAudit("system", "payout.failed", "user", sellerId, { payoutId: prepared.payout.id, error }, tx);
    });
    return { payoutId: prepared.payout.id, status: "FAILED" as const, error };
  }
}
