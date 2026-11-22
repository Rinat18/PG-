import { and, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { marketPrices } from "@/db/schema";
import { env } from "@/lib/env";
import { sha256 } from "@/lib/crypto";
import { APP_ID, type SkinGame } from "@/lib/bots/inventory";

/**
 * Рыночная цена предмета в тыйынах — для проверки отклонения цены лота (ТЗ 5.1, ±[30] %).
 * Источник — торговая площадка Steam (медианная цена в USD по курсу USD_KGS_RATE). Кешируется на 6 часов.
 */
export interface MarketPriceSource {
  readonly name: string;
  fetch(game: SkinGame, marketHashName: string): Promise<number | null | undefined>; // undefined — источник не ответил
}

const parseUsd = (s?: string) => (s ? Number(s.replace(/[^0-9.]/g, "")) : NaN);

export const steamMarketSource: MarketPriceSource = {
  name: "steam_market",
  async fetch(game, name) {
    try {
      const res = await fetch(
        `https://steamcommunity.com/market/priceoverview/?appid=${APP_ID[game]}&currency=1&market_hash_name=${encodeURIComponent(name)}`,
        { signal: AbortSignal.timeout(8_000) },
      );
      if (!res.ok) return undefined;
      const d = (await res.json()) as { success?: boolean; median_price?: string; lowest_price?: string };
      if (!d.success) return null;
      const usd = parseUsd(d.median_price) || parseUsd(d.lowest_price);
      return Number.isFinite(usd) && usd > 0 ? Math.round(usd * env.USD_KGS_RATE * 100) : null;
    } catch {
      return undefined;
    }
  },
};

/** Для разработки: фиксированные цены примеров, остальное — псевдослучайно от названия. */
export const MOCK_MARKET_PRICES_SOM: Record<string, number> = {
  "AK-47 | Redline (Field-Tested)": 2_400,
  "StatTrak™ AK-47 | Case Hardened (Minimal Wear)": 28_000,
  "★ Karambit | Fade (Factory New)": 160_000,
  "Sir Bloody Miami Darryl | The Professionals": 1_100,
  "Sticker | Natus Vincere (Holo) | Paris 2023": 300,
  "Manifold Paradox": 2_900,
  "Golden Baby Roshan": 45_000,
};
export const mockMarketSource: MarketPriceSource = {
  name: "mock",
  async fetch(_game, name) {
    const som = MOCK_MARKET_PRICES_SOM[name] ?? 100 + (parseInt(sha256(name).slice(0, 6), 16) % 5_000);
    return som * 100;
  },
};

let override: MarketPriceSource | null = null;
export function setMarketSourceForTests(s: MarketPriceSource | null) {
  override = s;
}
const source = () => override ?? (env.STEAM_CHECKS === "mock" ? mockMarketSource : steamMarketSource);

export async function getMarketPrice(game: SkinGame, marketHashName: string): Promise<number | null> {
  const fresh = new Date(Date.now() - 6 * 3_600_000);
  const [cached] = await db
    .select()
    .from(marketPrices)
    .where(and(eq(marketPrices.game, game), eq(marketPrices.marketHashName, marketHashName), gte(marketPrices.fetchedAt, fresh)));
  if (cached) return cached.priceMinor;
  const src = source();
  const price = await src.fetch(game, marketHashName);
  if (price === undefined) return null; // не кешируем сбой
  await db
    .insert(marketPrices)
    .values({ game, marketHashName, priceMinor: price, source: src.name })
    .onConflictDoUpdate({ target: [marketPrices.game, marketPrices.marketHashName], set: { priceMinor: price, source: src.name, fetchedAt: new Date() } });
  return price;
}

/** Отклонение цены от рыночной в процентах (по модулю); null — рыночной цены нет. */
export function priceDeviationPercent(priceMinor: number, marketMinor: number | null): number | null {
  if (!marketMinor) return null;
  return Math.round((Math.abs(priceMinor - marketMinor) / marketMinor) * 100);
}
