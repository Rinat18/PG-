import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, emailOutbox, loginTokens, orders, users } from "@/db/schema";
import { encrypt, randomToken, sha256 } from "@/lib/crypto";
import { env } from "@/lib/env";

/** Вход по одноразовой ссылке: токен живет 15 минут, используется один раз, в базе — только хэш. */
export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_LINKS_PER_EMAIL_15_MIN = 3;

export class EmailLoginError extends Error {
  constructor(
    public readonly code: "VALIDATION" | "RATE_LIMIT" | "INVALID_TOKEN" | "EMAIL_TAKEN" | "BLOCKED",
    message: string,
  ) {
    super(message);
  }
}

const emailSchema = z.string().trim().toLowerCase().email("Укажите корректный email").max(254);

/** Разрешаем только внутренние пути: защита от open redirect. */
export function safeNextPath(next: unknown, fallback = "/account"): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  return next;
}

/**
 * Создает ссылку и кладет письмо в email_outbox.
 * linkToUserId: вошедший (например, через Steam) пользователь подтверждает свой email.
 */
export async function requestEmailLogin(
  rawEmail: string,
  opts: { ip?: string; next?: string; linkToUserId?: string } = {},
): Promise<void> {
  const parsed = emailSchema.safeParse(rawEmail);
  if (!parsed.success) throw new EmailLoginError("VALIDATION", parsed.error.issues[0]?.message ?? "Проверьте email");
  const email = parsed.data;

  const since = new Date(Date.now() - LOGIN_TOKEN_TTL_MS);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(loginTokens)
    .where(and(eq(loginTokens.email, email), gt(loginTokens.createdAt, since)));
  if (count >= MAX_LINKS_PER_EMAIL_15_MIN) {
    throw new EmailLoginError("RATE_LIMIT", "Ссылка уже отправлена. Проверьте почту или попробуйте через 15 минут");
  }

  const token = randomToken(32);
  await db.insert(loginTokens).values({
    tokenHash: sha256(token),
    email,
    userId: opts.linkToUserId,
    nextPath: safeNextPath(opts.next),
    expiresAt: new Date(Date.now() + LOGIN_TOKEN_TTL_MS),
    ip: opts.ip,
  });

  const link = `${env.APP_URL}/login/email?token=${token}`;
  const purpose = opts.linkToUserId ? "подтвердить email в личном кабинете" : "войти на сайт";
  await db.insert(emailOutbox).values({
    to: email,
    subject: opts.linkToUserId ? "Подтверждение email" : "Вход на сайт",
    encryptedBody: encrypt(
      [
        `Чтобы ${purpose}, откройте ссылку (действует 15 минут, один раз):`,
        link,
        "",
        "Если вы не запрашивали письмо, просто проигнорируйте его.",
      ].join("\n"),
    ),
  });
}

/**
 * Использует токен и возвращает пользователя. Email подтвержден: гостевые заказы с этим email
 * привязываются к аккаунту.
 */
export async function consumeEmailLogin(token: string): Promise<{ userId: string; next: string; attachedOrders: number }> {
  if (!token || token.length > 200) throw new EmailLoginError("INVALID_TOKEN", "Ссылка недействительна");

  return db.transaction(async (tx) => {
    // Условный UPDATE: один и тот же токен не сработает дважды даже при гонке
    const [row] = await tx
      .update(loginTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(loginTokens.tokenHash, sha256(token)), isNull(loginTokens.usedAt), gt(loginTokens.expiresAt, new Date())))
      .returning();
    if (!row) throw new EmailLoginError("INVALID_TOKEN", "Ссылка недействительна или устарела. Запросите новую");

    const [owner] = await tx.select().from(users).where(eq(users.email, row.email));
    let userId: string;

    if (row.userId) {
      // привязка email к уже вошедшему аккаунту
      if (owner && owner.id !== row.userId) {
        throw new EmailLoginError("EMAIL_TAKEN", "Этот email уже привязан к другому аккаунту");
      }
      await tx.update(users).set({ email: row.email, emailVerifiedAt: new Date() }).where(eq(users.id, row.userId));
      userId = row.userId;
    } else if (owner) {
      if (owner.isBlocked) throw new EmailLoginError("BLOCKED", "Аккаунт заблокирован. Напишите в поддержку");
      if (!owner.emailVerifiedAt) await tx.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, owner.id));
      userId = owner.id;
    } else {
      const [created] = await tx.insert(users).values({ email: row.email, emailVerifiedAt: new Date() }).returning({ id: users.id });
      userId = created.id;
      await tx.insert(auditLog).values({ actor: `user:${userId}`, action: "user.created_email", entity: "user", entityId: userId, data: {} });
    }

    const attached = await tx
      .update(orders)
      .set({ userId })
      .where(and(eq(orders.email, row.email), isNull(orders.userId)))
      .returning({ id: orders.id });
    if (attached.length) {
      await tx.insert(auditLog).values({
        actor: `user:${userId}`,
        action: "orders.attached_by_email",
        entity: "user",
        entityId: userId,
        data: { count: attached.length },
      });
    }

    return { userId, next: row.nextPath ?? "/account", attachedOrders: attached.length };
  });
}
