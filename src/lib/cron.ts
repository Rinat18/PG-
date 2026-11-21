import { env } from "@/lib/env";

/** Крон вызывает с заголовком Authorization: Bearer $CRON_SECRET (так же делает Vercel Cron). */
export function isCronAuthorized(req: Request): boolean {
  return Boolean(env.CRON_SECRET) && req.headers.get("authorization") === `Bearer ${env.CRON_SECRET}`;
}
