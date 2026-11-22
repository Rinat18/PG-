import { isCronAuthorized } from "@/lib/cron";
import { processDeals } from "@/lib/p2p/deals";
import { processOutbox } from "@/lib/email/outbox";

export const dynamic = "force-dynamic";

/**
 * Раз в 2–5 минут: проверка передачи скинов в P2P-сделках через Steam, отмена с возвратом по сроку,
 * начисление и выплата после защиты от отката. Authorization: Bearer $CRON_SECRET.
 * Если запущен воркер ботов, он делает то же самое сам — двойной запуск безопасен.
 */
async function handle(req: Request) {
  if (!isCronAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const deals = await processDeals();
  await processOutbox();
  return Response.json(deals);
}
export const GET = handle;
export const POST = handle;
