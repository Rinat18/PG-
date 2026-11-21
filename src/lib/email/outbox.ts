import nodemailer from "nodemailer";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { emailOutbox } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";
import { renderEmail, type TemplateData, type TemplateName } from "./templates";

/**
 * Очередь писем. Правило: тело письма (в нем бывает ключ) не попадает ни в логи, ни в ошибки,
 * в базе лежит только зашифрованным. В логи пишем id письма и текст ошибки SMTP.
 */

export async function queueEmail<K extends TemplateName>(to: string, template: K, data: TemplateData[K], tx: Tx | typeof db = db) {
  const r = renderEmail(template, data);
  const [row] = await tx
    .insert(emailOutbox)
    .values({ to, subject: r.subject, template, encryptedBody: encrypt(r.text), encryptedHtml: encrypt(r.html) })
    .returning({ id: emailOutbox.id });
  return row.id;
}

export type OutgoingMail = { to: string; subject: string; text: string; html?: string };
export interface Mailer {
  send(mail: OutgoingMail): Promise<void>;
}

/** dev: ничего не отправляет, письмо остается читаемым на /dev/mail. */
const devMailer: Mailer = { send: async () => {} };

let smtp: Mailer | null = null;
function smtpMailer(): Mailer {
  if (smtp) return smtp;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    logger: false, // логгер nodemailer печатает тело письма — выключен
    debug: false,
  });
  smtp = {
    async send(m) {
      await transport.sendMail({ from: env.EMAIL_FROM, to: m.to, subject: m.subject, text: m.text, html: m.html });
    },
  };
  return smtp;
}

export function getMailer(): Mailer {
  return env.EMAIL_TRANSPORT === "smtp" ? smtpMailer() : devMailer;
}

/** Повторы: через 1, 5, 15, 60 минут, затем раз в 4 часа; после MAX_ATTEMPTS письмо помечается неотправленным. */
export const MAX_ATTEMPTS = 8;
export function backoffMinutes(attempt: number): number {
  return [1, 5, 15, 60][attempt - 1] ?? 240;
}

/** Текст ошибки без фрагментов письма (на случай, если сервер вернул часть содержимого). */
export function sanitizeError(message: string, body: string): string {
  let out = message.slice(0, 500);
  for (const piece of body.split(/\s+/)) {
    if (piece.length >= 8 && out.includes(piece)) out = out.split(piece).join("[скрыто]");
  }
  return out;
}

/**
 * Отправляет письма из очереди. Захват строк — UPDATE … FOR UPDATE SKIP LOCKED с блокировкой на 5 минут:
 * два параллельных крона не отправят одно письмо дважды.
 */
export async function processOutbox(opts: { limit?: number; mailer?: Mailer } = {}) {
  const mailer = opts.mailer ?? getMailer();
  const claimed = await db.execute<{ id: string }>(sql`
    update email_outbox set locked_until = now() + interval '5 minutes', attempts = attempts + 1
    where id in (
      select id from email_outbox
      where sent_at is null and failed_at is null
        and (next_attempt_at is null or next_attempt_at <= now())
        and (locked_until is null or locked_until < now())
      order by created_at
      limit ${opts.limit ?? 50}
      for update skip locked
    )
    returning id`);

  let sent = 0;
  let failed = 0;
  for (const { id } of claimed.rows) {
    const [row] = await db.select().from(emailOutbox).where(eq(emailOutbox.id, id));
    const text = decrypt(row.encryptedBody);
    try {
      await mailer.send({ to: row.to, subject: row.subject, text, html: row.encryptedHtml ? decrypt(row.encryptedHtml) : undefined });
      await db.update(emailOutbox).set({ sentAt: new Date(), lockedUntil: null, lastError: null }).where(eq(emailOutbox.id, id));
      sent++;
    } catch (e) {
      failed++;
      const error = sanitizeError((e as Error)?.message ?? String(e), text);
      const giveUp = row.attempts >= MAX_ATTEMPTS;
      await db
        .update(emailOutbox)
        .set({
          lastError: error,
          lockedUntil: null,
          nextAttemptAt: new Date(Date.now() + backoffMinutes(row.attempts) * 60_000),
          failedAt: giveUp ? new Date() : null,
        })
        .where(eq(emailOutbox.id, id));
      console.error(`[email] не отправлено ${id} (попытка ${row.attempts}): ${error}`);
    }
  }
  return { claimed: claimed.rows.length, sent, failed };
}

/** Повтор письма, у которого кончились попытки (из админки). */
export async function requeueEmail(id: string) {
  const res = await db
    .update(emailOutbox)
    .set({ failedAt: null, attempts: 0, nextAttemptAt: null, lockedUntil: null })
    .where(and(eq(emailOutbox.id, id), isNull(emailOutbox.sentAt)))
    .returning({ id: emailOutbox.id });
  return res.length > 0;
}
