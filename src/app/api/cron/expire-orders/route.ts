import { isCronAuthorized } from "@/lib/cron";
import { expireStaleOrders } from "@/lib/orders/service";

export const dynamic = "force-dynamic";

/** Раз в минуту: POST или GET с Authorization: Bearer $CRON_SECRET */
async function handle(req: Request) {
  if (!isCronAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({ cancelled: await expireStaleOrders() });
}
export const GET = handle;
export const POST = handle;
