/** SteamID64 = 76561197960265728 + accountId (partner в trade-ссылке). */
const STEAM_ID64_BASE = BigInt("76561197960265728");

export const STEAM_TRADE_URL_RE = /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=(\d+)&token=([\w-]{6,})$/;

export function parseTradeUrl(url: string): { accountId: string; steamId: string; token: string } | null {
  const m = STEAM_TRADE_URL_RE.exec(url.trim());
  if (!m) return null;
  const accountId = m[1];
  return { accountId, steamId: (STEAM_ID64_BASE + BigInt(accountId)).toString(), token: m[2] };
}

export function isSteamId64(value: string): boolean {
  return /^7656\d{13}$/.test(value);
}
