import { isCronAuthorized } from "@/lib/cron";
import { runDemoTick } from "@/lib/demo/tick";

export const dynamic = "force-dynamic";

/** Демо-стенд: принудительный тик (боты, сделки, почта). Authorization: Bearer $CRON_SECRET */
async function handle(req: Request) {
  if (!isCronAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json((await runDemoTick(true)) ?? { skipped: true });
}
export const GET = handle;
export const POST = handle;
