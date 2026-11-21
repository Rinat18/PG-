import { env } from "@/lib/env";
import { parseTradeUrl } from "@/lib/auth/steam-id";

/**
 * Проверки покупателя скина до создания QR (ТЗ, раздел 4):
 * trade-ссылка своя и действующая, инвентарь открыт, нет трейд-бана.
 * Если Steam не ответил — заказ не создается: лучше попросить повторить, чем брать деньги за невыдаваемый скин.
 */

export const STEAM_APP_ID = { CS2: 730, DOTA2: 570 } as const;
export type SkinGame = keyof typeof STEAM_APP_ID;

export type CheckResult<T> = { ok: true; value: T } | { ok: false; unavailable: true };

/** Внешние вызовы Steam. В тестах подменяется заглушкой. */
export interface SteamApi {
  /** EconomyBan: "none" | "probation" | "banned" */
  getEconomyBan(steamId: string): Promise<CheckResult<string>>;
  /** null — Steam не принял trade-токен (ссылка устарела или чужая); число — дни trade hold */
  getTradeHoldDays(steamId: string, tradeToken: string): Promise<CheckResult<number | null>>;
  isInventoryPublic(steamId: string, appId: number): Promise<CheckResult<boolean>>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function httpSteamApi(apiKey: string, fetchImpl: FetchLike = fetch): SteamApi {
  const get = (url: string) => fetchImpl(url, { signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" } });
  return {
    async getEconomyBan(steamId) {
      try {
        const res = await get(`https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${apiKey}&steamids=${steamId}`);
        if (!res.ok) return { ok: false, unavailable: true };
        const data = (await res.json()) as { players?: { EconomyBan?: string }[] };
        const ban = data.players?.[0]?.EconomyBan;
        return ban ? { ok: true, value: ban } : { ok: false, unavailable: true };
      } catch {
        return { ok: false, unavailable: true };
      }
    },
    async getTradeHoldDays(steamId, tradeToken) {
      try {
        const res = await get(
          `https://api.steampowered.com/IEconService/GetTradeHoldDurations/v1/?key=${apiKey}` +
            `&steamid_target=${steamId}&trade_offer_access_token=${encodeURIComponent(tradeToken)}`,
        );
        if (!res.ok) return { ok: false, unavailable: true };
        const data = (await res.json()) as { response?: { their_escrow?: { escrow_end_duration_seconds?: number } } };
        const secs = data.response?.their_escrow?.escrow_end_duration_seconds;
        // Steam отвечает пустым response, если токен не подходит к аккаунту
        return { ok: true, value: typeof secs === "number" ? Math.ceil(secs / 86400) : null };
      } catch {
        return { ok: false, unavailable: true };
      }
    },
    async isInventoryPublic(steamId, appId) {
      try {
        const res = await get(`https://steamcommunity.com/inventory/${steamId}/${appId}/2?l=english&count=1`);
        if (res.status === 401 || res.status === 403) return { ok: true, value: false };
        if (!res.ok) return { ok: false, unavailable: true }; // 429 и сбои Steam
        return { ok: true, value: true };
      } catch {
        return { ok: false, unavailable: true };
      }
    },
  };
}

/** Для разработки без ключа Steam: все проверки проходят. На боевом сайте запрещено (см. env). */
export const permissiveSteamApi: SteamApi = {
  getEconomyBan: async () => ({ ok: true, value: "none" }),
  getTradeHoldDays: async () => ({ ok: true, value: 0 }),
  isInventoryPublic: async () => ({ ok: true, value: true }),
};

export function getSteamApi(): SteamApi | null {
  if (env.STEAM_CHECKS === "mock") return permissiveSteamApi;
  return env.STEAM_API_KEY ? httpSteamApi(env.STEAM_API_KEY) : null;
}

export class SkinBuyerError extends Error {
  constructor(
    public readonly code: "TRADE_URL" | "INVENTORY_PRIVATE" | "TRADE_BAN" | "STEAM_UNAVAILABLE",
    message: string,
  ) {
    super(message);
  }
}

const UNAVAILABLE = "Steam сейчас не отвечает, поэтому мы не можем проверить ваш аккаунт. Заказ не создан, попробуйте через несколько минут";

/** Возвращает дни trade hold (0 — без задержки). Бросает SkinBuyerError с понятным текстом. */
export async function checkSkinBuyer(
  params: { steamId: string; tradeUrl: string; game: SkinGame },
  api: SteamApi | null,
): Promise<{ tradeHoldDays: number }> {
  const parsed = parseTradeUrl(params.tradeUrl);
  if (!parsed) {
    throw new SkinBuyerError("TRADE_URL", "Нужна trade-ссылка вида https://steamcommunity.com/tradeoffer/new/?partner=...&token=...");
  }
  if (parsed.steamId !== params.steamId) {
    throw new SkinBuyerError("TRADE_URL", "Trade-ссылка принадлежит другому аккаунту Steam. Укажите ссылку аккаунта, с которого вы вошли");
  }
  if (!api) throw new SkinBuyerError("STEAM_UNAVAILABLE", UNAVAILABLE);

  const [ban, hold, inv] = await Promise.all([
    api.getEconomyBan(params.steamId),
    api.getTradeHoldDays(params.steamId, parsed.token),
    api.isInventoryPublic(params.steamId, STEAM_APP_ID[params.game]),
  ]);
  if (!ban.ok || !hold.ok || !inv.ok) throw new SkinBuyerError("STEAM_UNAVAILABLE", UNAVAILABLE);

  if (ban.value !== "none") {
    throw new SkinBuyerError("TRADE_BAN", "На аккаунте Steam ограничение на обмен (трейд-бан), бот не сможет передать скин");
  }
  if (hold.value === null) {
    throw new SkinBuyerError("TRADE_URL", "Steam не принял trade-ссылку: возможно, она устарела. Скопируйте актуальную в настройках Steam");
  }
  if (!inv.value) {
    throw new SkinBuyerError("INVENTORY_PRIVATE", "Инвентарь Steam закрыт. Откройте его в настройках приватности Steam и повторите");
  }
  return { tradeHoldDays: hold.value };
}
