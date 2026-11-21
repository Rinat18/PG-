import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, users } from "@/db/schema";
import { env } from "@/lib/env";
import { isSteamId64 } from "./steam-id";

/**
 * Вход через Steam OpenID 2.0.
 * Ответ Steam принимаем только после проверки:
 *  1) mode=id_res, op_endpoint — Steam, return_to — наш callback с тем же state (защита от login CSRF);
 *  2) claimed_id вида https://steamcommunity.com/openid/id/<SteamID64>;
 *  3) Steam подтвердил подпись запросом check_authentication (is_valid:true).
 */
export const STEAM_STATE_COOKIE = "pg_steam_state";
export const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";
const OPENID_NS = "http://specs.openid.net/auth/2.0";
const IDENTIFIER_SELECT = "http://specs.openid.net/auth/2.0/identifier_select";
const CLAIMED_ID_RE = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function steamCallbackUrl(state: string): string {
  return `${env.APP_URL}/api/auth/steam/callback?state=${encodeURIComponent(state)}`;
}

export function buildSteamLoginUrl(state: string): string {
  const params = new URLSearchParams({
    "openid.ns": OPENID_NS,
    "openid.mode": "checkid_setup",
    "openid.return_to": steamCallbackUrl(state),
    "openid.realm": env.APP_URL,
    "openid.identity": IDENTIFIER_SELECT,
    "openid.claimed_id": IDENTIFIER_SELECT,
  });
  return `${STEAM_OPENID_ENDPOINT}?${params}`;
}

export type SteamVerifyResult = { ok: true; steamId: string } | { ok: false; reason: string };

export async function verifySteamResponse(
  query: URLSearchParams,
  expectedState: string | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<SteamVerifyResult> {
  if (query.get("openid.mode") !== "id_res") return { ok: false, reason: "mode" };
  if (query.get("openid.ns") !== OPENID_NS) return { ok: false, reason: "ns" };
  if (query.get("openid.op_endpoint") !== STEAM_OPENID_ENDPOINT) return { ok: false, reason: "op_endpoint" };
  if (!expectedState || query.get("state") !== expectedState) return { ok: false, reason: "state" };
  if (query.get("openid.return_to") !== steamCallbackUrl(expectedState)) return { ok: false, reason: "return_to" };

  const claimed = query.get("openid.claimed_id") ?? "";
  const m = CLAIMED_ID_RE.exec(claimed);
  if (!m || query.get("openid.identity") !== claimed || !isSteamId64(m[1])) return { ok: false, reason: "claimed_id" };

  // signed должен покрывать ключевые поля, иначе их можно подменить при валидной подписи остальных
  const signed = (query.get("openid.signed") ?? "").split(",");
  for (const f of ["op_endpoint", "claimed_id", "identity", "return_to", "response_nonce", "assoc_handle"]) {
    if (!signed.includes(f)) return { ok: false, reason: `unsigned_${f}` };
  }

  const body = new URLSearchParams();
  for (const [k, v] of query) if (k.startsWith("openid.")) body.set(k, v);
  body.set("openid.mode", "check_authentication");

  let text: string;
  try {
    const res = await fetchImpl(STEAM_OPENID_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, reason: `check_http_${res.status}` };
    text = await res.text();
  } catch {
    return { ok: false, reason: "check_unreachable" };
  }
  if (!/^is_valid\s*:\s*true\s*$/m.test(text)) return { ok: false, reason: "check_invalid" };
  return { ok: true, steamId: m[1] };
}

export type SteamProfile = { personaName: string; avatarUrl: string | null };

export async function fetchSteamProfile(steamId: string, fetchImpl: FetchLike = fetch): Promise<SteamProfile | null> {
  if (!env.STEAM_API_KEY) return null;
  try {
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${env.STEAM_API_KEY}&steamids=${steamId}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { response?: { players?: { personaname?: string; avatarfull?: string }[] } };
    const p = data.response?.players?.[0];
    if (!p?.personaname) return null;
    return { personaName: p.personaname, avatarUrl: p.avatarfull ?? null };
  } catch {
    return null; // профиль не критичен для входа
  }
}

/** Находит или создает пользователя по SteamID, обновляет имя и аватар. */
export async function upsertSteamUser(steamId: string, profile: SteamProfile | null) {
  const [existing] = await db.select().from(users).where(eq(users.steamId, steamId));
  if (existing) {
    if (profile) {
      await db.update(users).set({ displayName: profile.personaName, avatarUrl: profile.avatarUrl }).where(eq(users.id, existing.id));
    }
    return existing;
  }
  const [created] = await db
    .insert(users)
    .values({ steamId, displayName: profile?.personaName ?? `Steam ${steamId.slice(-6)}`, avatarUrl: profile?.avatarUrl })
    .onConflictDoNothing()
    .returning();
  if (created) {
    await db.insert(auditLog).values({ actor: `user:${created.id}`, action: "user.created_steam", entity: "user", entityId: created.id, data: {} });
    return created;
  }
  // гонка двух одновременных входов
  const [again] = await db.select().from(users).where(eq(users.steamId, steamId));
  return again;
}
