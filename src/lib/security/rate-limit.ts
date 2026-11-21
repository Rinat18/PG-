import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Ограничение частоты с фиксированным окном в PostgreSQL (работает на нескольких инстансах).
 * Возвращает true, если действие разрешено.
 */
export async function hitRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const res = await db.execute<{ count: number }>(sql`
    insert into rate_limits (key, count, window_ends_at)
    values (${key}, 1, now() + make_interval(secs => ${windowSeconds}))
    on conflict (key) do update set
      count = case when rate_limits.window_ends_at < now() then 1 else rate_limits.count + 1 end,
      window_ends_at = case when rate_limits.window_ends_at < now()
        then now() + make_interval(secs => ${windowSeconds}) else rate_limits.window_ends_at end
    returning count
  `);
  return Number(res.rows[0].count) <= limit;
}

/** Лимиты форм по IP: [действие] = { limit, windowSeconds }. */
export const FORM_LIMITS = {
  checkout: { limit: 10, windowSeconds: 10 * 60 },
  emailLogin: { limit: 5, windowSeconds: 15 * 60 },
  steamLogin: { limit: 20, windowSeconds: 10 * 60 },
  profile: { limit: 20, windowSeconds: 10 * 60 },
} as const;

export async function allowFormByIp(action: keyof typeof FORM_LIMITS, ip: string | undefined): Promise<boolean> {
  const { limit, windowSeconds } = FORM_LIMITS[action];
  return hitRateLimit(`ip:${action}:${ip ?? "unknown"}`, limit, windowSeconds);
}

export { HONEYPOT_FIELD, isHoneypotTripped } from "./honeypot";
