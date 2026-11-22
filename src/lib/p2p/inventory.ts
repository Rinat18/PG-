import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { mockSteamItems, mockSteamSeeded } from "@/db/schema";
import { env } from "@/lib/env";
import { cs2Items, dotaItems } from "@/lib/bots/fixtures";
import type { SteamItem } from "@/lib/bots/inventory";

/**
 * Публичный инвентарь Steam пользователя: выбор предмета для лота и проверка, что предмет дошел до покупателя.
 * null — инвентарь закрыт или Steam не ответил (тогда решение не принимаем, проверим позже).
 */
export interface InventoryApi {
  getInventory(steamId: string, appId: number): Promise<SteamItem[] | null>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type CommunityInventory = {
  assets?: { assetid: string; classid: string; instanceid: string; appid: number; contextid: string }[];
  descriptions?: (Omit<SteamItem, "assetid" | "tradable"> & { classid: string; instanceid: string; tradable: number })[];
};

export function httpInventoryApi(fetchImpl: FetchLike = fetch): InventoryApi {
  return {
    async getInventory(steamId, appId) {
      try {
        const res = await fetchImpl(`https://steamcommunity.com/inventory/${steamId}/${appId}/2?l=english&count=2000`, {
          signal: AbortSignal.timeout(10_000),
          headers: { accept: "application/json" },
        });
        if (!res.ok) return null;
        const data = (await res.json()) as CommunityInventory;
        const desc = new Map((data.descriptions ?? []).map((d) => [`${d.classid}_${d.instanceid}`, d]));
        return (data.assets ?? []).flatMap((a) => {
          const d = desc.get(`${a.classid}_${a.instanceid}`);
          return d ? [{ ...d, assetid: a.assetid, appid: a.appid, contextid: a.contextid, tradable: d.tradable }] : [];
        });
      } catch {
        return null;
      }
    },
  };
}

/**
 * mock-режим (STEAM_CHECKS=mock): инвентари в таблице mock_steam_items.
 * При первом обращении аккаунт получает набор примеров (в том числе кейсы — их должен отсечь фильтр).
 */
export const mockInventoryApi: InventoryApi = {
  async getInventory(steamId, appId) {
    await seedMockInventory(steamId, appId);
    const rows = await db
      .select()
      .from(mockSteamItems)
      .where(and(eq(mockSteamItems.steamId, steamId), eq(mockSteamItems.appId, appId)))
      .orderBy(mockSteamItems.createdAt);
    return rows.map((r) => ({ ...(r.item as SteamItem), assetid: r.assetId }));
  },
};

async function seedMockInventory(steamId: string, appId: number) {
  const seeded = await db.insert(mockSteamSeeded).values({ key: `${steamId}:${appId}` }).onConflictDoNothing().returning();
  if (!seeded.length) return;
  const base = appId === 730 ? Object.values(cs2Items) : Object.values(dotaItems);
  const prefix = steamId.slice(-6);
  for (const [i, item] of base.entries()) {
    const assetId = `${appId}${prefix}${String(i).padStart(3, "0")}`;
    await db.insert(mockSteamItems).values({ assetId, steamId, appId, item: { ...item, assetid: assetId } }).onConflictDoNothing();
  }
}

/** mock: продавец «передает» предмет покупателю — у получателя он появляется с новым assetid, как в Steam. */
export async function mockTransferItem(fromSteamId: string, toSteamId: string, assetId: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .delete(mockSteamItems)
      .where(and(eq(mockSteamItems.assetId, assetId), eq(mockSteamItems.steamId, fromSteamId)))
      .returning();
    if (!row) return null;
    const [{ next }] = (
      await tx.execute<{ next: string }>(sql`select (coalesce(max(asset_id::numeric), 0) + 1 + floor(random() * 1000))::text as next
        from mock_steam_items where asset_id ~ '^[0-9]+$'`)
    ).rows;
    const newId = (BigInt(next) + BigInt(90_000_000_000)).toString();
    await tx.insert(mockSteamItems).values({ assetId: newId, steamId: toSteamId, appId: row.appId, item: { ...(row.item as object), assetid: newId } });
    return newId;
  });
}

let override: InventoryApi | null = null;
export function setInventoryApiForTests(api: InventoryApi | null) {
  override = api;
}
export function getInventoryApi(): InventoryApi {
  if (override) return override;
  return env.STEAM_CHECKS === "mock" ? mockInventoryApi : httpInventoryApi();
}
