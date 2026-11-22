/**
 * Воркер Steam-ботов. Отдельный процесс (Railway / VPS, не Vercel): npm run worker
 * Общая база с сайтом (src/db). Запускать ОДИН экземпляр.
 *
 * env воркера (вдобавок к DATABASE_URL, DATA_ENCRYPTION_KEY и прочим из .env сайта):
 *   BOT_MODE=steam|mock
 *   STEAM_BOTS=[{"name":"bot1","username":"…","password":"…","sharedSecret":"…","identitySecret":"…"}]
 *   FLOAT_INSPECT_API=https://… (необязательно), FLOAT_INSPECT_KEY=…
 */
import "dotenv/config";
import { z } from "zod";
import { syncBotInventory, APP_ID, type SkinGame } from "@/lib/bots/inventory";
import { botHeartbeat, pollSentOffers, processTradeQueue, upsertBotAccount, type BotClient } from "@/lib/bots/trades";
import { MockBotClient } from "@/lib/bots/mock-client";
import { SteamBotClient } from "./steam-client";
import { httpFloatProvider } from "./float";
import { processDeals } from "@/lib/p2p/deals";

const env = z
  .object({
    BOT_MODE: z.enum(["steam", "mock"]).default("mock"),
    STEAM_BOTS: z.string().default("[]"),
    PAYMENT_PROVIDER: z.string().default("mock"),
    FLOAT_INSPECT_API: z.string().url().optional(),
    FLOAT_INSPECT_KEY: z.string().optional(),
    TRADE_TICK_SECONDS: z.coerce.number().int().min(5).default(15),
    SYNC_TICK_MINUTES: z.coerce.number().int().min(1).default(10),
    MOCK_ACCEPT_SECONDS: z.coerce.number().int().min(0).default(30),
  })
  .parse(process.env);

if (env.BOT_MODE === "mock" && env.PAYMENT_PROVIDER !== "mock") {
  throw new Error("BOT_MODE=mock допустим только с PAYMENT_PROVIDER=mock");
}

const botConfig = z.array(
  z.object({ name: z.string(), username: z.string(), password: z.string(), sharedSecret: z.string(), identitySecret: z.string() }),
);

const clients: Record<string, BotClient> = {};
const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[worker]", ...a);

async function start() {
  if (env.BOT_MODE === "mock") {
    const client = new MockBotClient("76561190000000001", env.MOCK_ACCEPT_SECONDS * 1000);
    const row = await upsertBotAccount("mock-bot", client.steamId);
    clients[row.id] = client;
    log("mock-бот запущен", row.id);
  } else {
    for (const cfg of botConfig.parse(JSON.parse(env.STEAM_BOTS))) {
      try {
        let rowId = "";
        const client = await SteamBotClient.login(cfg, (e) => {
          log(`бот ${cfg.name}: ошибка Steam`, e.message);
          if (rowId) void botHeartbeat(rowId, "ERROR", e.message);
        });
        const row = await upsertBotAccount(cfg.name, client.steamId);
        rowId = row.id;
        clients[row.id] = client;
        log(`бот ${cfg.name} в сети`, client.steamId);
      } catch (e) {
        // логин одного бота не валит остальных; пароль и секреты в лог не попадают
        log(`бот ${cfg.name}: вход не удался:`, (e as Error).message);
      }
    }
  }
  if (!Object.keys(clients).length) log("нет ботов в сети — очередь будет ждать");
}

let tradeBusy = false;
async function tradeTick() {
  if (tradeBusy) return;
  tradeBusy = true;
  try {
    const sent = await processTradeQueue(clients);
    const polled = await pollSentOffers(clients);
    if (sent.sent + sent.failed + sent.retry + polled.accepted + polled.declined + polled.timedOut) log("трейды", sent, polled);
  } catch (e) {
    log("ошибка очереди трейдов:", (e as Error).message);
  } finally {
    tradeBusy = false;
  }
}

let syncBusy = false;
async function syncTick() {
  if (syncBusy) return;
  syncBusy = true;
  const floats = env.FLOAT_INSPECT_API ? httpFloatProvider(env.FLOAT_INSPECT_API, env.FLOAT_INSPECT_KEY) : undefined;
  for (const [botId, client] of Object.entries(clients)) {
    for (const game of Object.keys(APP_ID) as SkinGame[]) {
      try {
        const items = await client.getInventory(APP_ID[game]);
        const r = await syncBotInventory(botId, game, items, floats, client.steamId);
        log(`синхронизация ${game}`, botId.slice(0, 8), r);
        await botHeartbeat(botId, "ONLINE");
      } catch (e) {
        log(`синхронизация ${game} не удалась:`, (e as Error).message);
        await botHeartbeat(botId, "ERROR", `sync ${game}: ${(e as Error).message}`);
      }
    }
  }
  syncBusy = false;
}

let dealsBusy = false;
async function dealsTick() {
  if (dealsBusy) return;
  dealsBusy = true;
  try {
    const r = await processDeals();
    if (Object.values(r).some(Boolean)) log("сделки P2P", r);
  } catch (e) {
    log("ошибка проверки сделок:", (e as Error).message);
  } finally {
    dealsBusy = false;
  }
}

async function heartbeat() {
  for (const botId of Object.keys(clients)) await botHeartbeat(botId, "ONLINE").catch(() => {});
}

async function main() {
  await start();
  await syncTick();
  await tradeTick();
  await dealsTick();
  const timers = [
    setInterval(tradeTick, env.TRADE_TICK_SECONDS * 1000),
    setInterval(syncTick, env.SYNC_TICK_MINUTES * 60_000),
    setInterval(heartbeat, 60_000),
    setInterval(dealsTick, 60_000), // проверка передачи в P2P-сделках
  ];
  const stop = async () => {
    log("остановка");
    timers.forEach(clearInterval);
    for (const botId of Object.keys(clients)) await botHeartbeat(botId, "OFFLINE").catch(() => {});
    for (const c of Object.values(clients)) if (c instanceof SteamBotClient) c.logOff();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((e) => {
  console.error("[worker] фатальная ошибка:", (e as Error).message);
  process.exit(1);
});
