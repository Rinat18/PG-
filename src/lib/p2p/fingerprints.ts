import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { sellerProfiles, userFingerprints } from "@/db/schema";
import { sha256 } from "@/lib/crypto";

/**
 * Связанные аккаунты (ТЗ 5.1): общий IP, общее устройство (cookie pg_did) или одинаковые реквизиты выплаты.
 * Храним только хеши значений.
 */
export const DEVICE_COOKIE = "pg_did";

const h = (kind: string, value: string) => sha256(`${kind}:${value.trim().toLowerCase()}`);

export async function recordFingerprint(userId: string, fp: { ip?: string; deviceId?: string }, tx: Tx | typeof db = db) {
  const rows = [
    fp.ip ? { kind: "ip", valueHash: h("ip", fp.ip) } : null,
    fp.deviceId && /^[\w-]{16,64}$/.test(fp.deviceId) ? { kind: "device", valueHash: h("device", fp.deviceId) } : null,
  ].filter((r): r is { kind: string; valueHash: string } => r !== null);
  for (const r of rows) {
    await tx
      .insert(userFingerprints)
      .values({ userId, ...r })
      .onConflictDoUpdate({
        target: [userFingerprints.userId, userFingerprints.kind, userFingerprints.valueHash],
        set: { lastSeenAt: new Date() },
      });
  }
}

export const payoutDetailsHash = (details: string) => sha256(`payout:${details.replace(/[\s-]/g, "").toLowerCase()}`);

export type LinkReason = "same_ip" | "same_device" | "same_payout_details";
export const linkReasonLabel: Record<LinkReason, string> = {
  same_ip: "общий IP-адрес",
  same_device: "общее устройство",
  same_payout_details: "одинаковые реквизиты выплаты",
};

/** Причины, по которым покупатель и продавец считаются связанными. Пусто — не связаны. */
export async function findLinks(buyerId: string, sellerId: string, tx: Tx | typeof db = db): Promise<LinkReason[]> {
  const reasons: LinkReason[] = [];
  const shared = await tx.execute<{ kind: string }>(sql`
    select distinct a.kind from user_fingerprints a
    join user_fingerprints b on a.kind = b.kind and a.value_hash = b.value_hash
    where a.user_id = ${buyerId} and b.user_id = ${sellerId}`);
  for (const r of shared.rows) reasons.push(r.kind === "ip" ? "same_ip" : "same_device");

  const [seller] = await tx.select({ hash: sellerProfiles.payoutDetailsHash }).from(sellerProfiles).where(eq(sellerProfiles.userId, sellerId));
  if (seller?.hash) {
    const same = await tx
      .select({ id: sellerProfiles.userId })
      .from(sellerProfiles)
      .where(and(eq(sellerProfiles.userId, buyerId), eq(sellerProfiles.payoutDetailsHash, seller.hash)));
    if (same.length) reasons.push("same_payout_details");
  }
  return reasons;
}

/** Другие продавцы с теми же реквизитами (для экрана верификации). */
export async function usersWithSamePayout(userId: string, hash: string) {
  const rows = await db
    .select({ id: sellerProfiles.userId })
    .from(sellerProfiles)
    .where(and(eq(sellerProfiles.payoutDetailsHash, hash), ne(sellerProfiles.userId, userId)));
  return rows.map((r) => r.id);
}

export async function fingerprintCount(userIds: string[]) {
  if (!userIds.length) return 0;
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(userFingerprints).where(inArray(userFingerprints.userId, userIds));
  return Number(rows[0].n);
}
