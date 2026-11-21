import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { randomToken, sha256 } from "@/lib/crypto";
import { env } from "@/lib/env";

/**
 * Сессии без привязки к Next: эти функции вызываются из route handlers, server actions и тестов.
 * Cookie: `<token>.<hmac(token)>`; в базе — sha256(token).
 */
export const SESSION_COOKIE = "pg_session";

function sign(token: string): string {
  return createHmac("sha256", env.SESSION_SECRET).update(token).digest("base64url");
}

export function signSessionToken(token: string): string {
  return `${token}.${sign(token)}`;
}

/** Возвращает token, если подпись верна; иначе null. */
export function verifySessionCookie(value: string | undefined | null): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const token = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(sign(token));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return token;
}

export function sessionMaxAgeSeconds(): number {
  return env.SESSION_TTL_DAYS * 24 * 60 * 60;
}

export async function createSession(userId: string, meta: { ip?: string; userAgent?: string } = {}) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + sessionMaxAgeSeconds() * 1000);
  await db.insert(sessions).values({
    id: sha256(token),
    userId,
    expiresAt,
    ip: meta.ip,
    userAgent: meta.userAgent?.slice(0, 300),
  });
  return { cookieValue: signSessionToken(token), expiresAt };
}

export type SessionUser = typeof users.$inferSelect;

/** Пользователь по значению cookie. Просроченная, поддельная или удаленная сессия и заблокированный пользователь — null. */
export async function getUserBySessionCookie(cookieValue: string | undefined | null): Promise<SessionUser | null> {
  const token = verifySessionCookie(cookieValue);
  if (!token) return null;
  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())));
  if (!row || row.user.isBlocked) return null;
  return row.user;
}

export async function deleteSessionByCookie(cookieValue: string | undefined | null) {
  const token = verifySessionCookie(cookieValue);
  if (token) await db.delete(sessions).where(eq(sessions.id, sha256(token)));
}

export async function purgeExpiredSessions() {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
