import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_ID, syncBotInventory, type SkinGame } from "@/lib/bots/inventory";
import { MockBotClient } from "@/lib/bots/mock-client";
import { botHeartbeat, pollSentOffers, processTradeQueue, upsertBotAccount } from "@/lib/bots/trades";
import { processOutbox } from "@/lib/email/outbox";
import { env } from "@/lib/env";
import { expireStaleOrders } from "@/lib/orders/service";
import { processDeals } from "@/lib/p2p/deals";

/**
 * Демо-стенд (DEMO_MODE=true) работает без отдельного воркера: то, что воркер делает по таймеру,
 * выполняется после ответа на запросы страниц — не чаще раза в MIN_INTERVAL_MS.
 * Тестовый бот принимает оффер через MOCK_ACCEPT_MS. Одновременно тик идет только в одном запросе
 * (advisory lock в Postgres).
 */
export const DEMO_BOT_STEAM_ID = "76561190000000001";
const MOCK_ACCEPT_MS = 20_000;
const MIN_INTERVAL_MS = 10_000;
const SYNC_INTERVAL_MS = 10 * 60_000;
let lastRun = 0;

export async function runDemoTick(force = false) {
  if (!env.DEMO_MODE) return null;
  if (!force && Date.now() - lastRun < MIN_INTERVAL_MS) return null;
  lastRun = Date.now();
  return db.transaction(async (tx) => {
    const r = await tx.execute(sql`select pg_try_advisory_xact_lock(4242) as ok`);
    if (!(r.rows[0] as { ok: boolean }).ok) return null;
    const client = new MockBotClient(DEMO_BOT_STEAM_ID, MOCK_ACCEPT_MS);
    const bot = await upsertBotAccount("demo-bot", client.steamId);
    const clients = { [bot.id]: client };
    if (!bot.lastSyncAt || Date.now() - bot.lastSyncAt.getTime() > SYNC_INTERVAL_MS) {
      for (const game of Object.keys(APP_ID) as SkinGame[]) {
        await syncBotInventory(bot.id, game, await client.getInventory(APP_ID[game]), undefined, client.steamId);
      }
    }
    await botHeartbeat(bot.id, "ONLINE");
    const expired = await expireStaleOrders();
    const sent = await processTradeQueue(clients);
    const polled = await pollSentOffers(clients);
    const deals = await processDeals({ minIntervalMs: 0 });
    await processOutbox({ limit: 20 });
    return { expired, sent, polled, deals };
  });
}
