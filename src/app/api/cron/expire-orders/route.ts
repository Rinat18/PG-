import { env } from "@/lib/env";
import { expireStaleOrders } from "@/lib/orders/service";

export const dynamic = "force-dynamic";

/** Вызывать по крону раз в минуту: Authorization: Bearer $CRON_SECRET */
export async function POST(req: Request) {
  if (!env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const cancelled = await expireStaleOrders();
  return Response.json({ cancelled });
}
