import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { botAccounts, products, type SkinAttributes } from "@/db/schema";
import { getSettings } from "@/lib/settings";

/**
 * Инвентарь бота → карточки SHOP_SKIN.
 * Кейсы, ключи от кейсов, капсулы и прочие контейнеры со случайным содержимым в каталог не попадают
 * (ТЗ, разделы 1, 2 и 6) — фильтр по тегам Steam, см. isContainer.
 */

export type SteamTag = { category: string; internal_name: string; localized_tag_name?: string; name?: string };
export type SteamItem = {
  assetid: string;
  classid?: string;
  instanceid?: string;
  appid: number;
  contextid?: string;
  market_hash_name: string;
  name?: string;
  type?: string;
  tradable: boolean | number;
  marketable?: boolean | number;
  icon_url?: string;
  tags?: SteamTag[];
  descriptions?: { type?: string; value: string; name?: string }[];
  actions?: { link: string; name: string }[];
};

export type SkinGame = "CS2" | "DOTA2";
export const APP_ID: Record<SkinGame, number> = { CS2: 730, DOTA2: 570 };

const tag = (item: SteamItem, category: string) => item.tags?.find((t) => t.category === category);
const tagName = (t: SteamTag | undefined) => t?.localized_tag_name ?? t?.name;

/** internal_name тега Type, означающие контейнер со случайным содержимым или ключ к нему. */
const CONTAINER_TYPES = new Set([
  // CS2
  "CSGO_Type_WeaponCase", // кейсы, капсулы с наклейками, сувенирные наборы, коробки граффити и т. п. («Container»)
  "CSGO_Tool_WeaponCase_KeyTag", // ключи от кейсов («Key»)
  "CSGO_Tool_StickerKit_Capsule",
  "CSGO_Type_Container",
  // Dota 2
  "treasure_chest", // сокровищницы («Treasure»)
  "retired_treasure_chest",
  "key", // ключи от сокровищниц
  "treasure_key",
]);
const CONTAINER_TYPE_NAMES = /^(container|case|key|treasure|treasure key|capsule|sticker capsule|souvenir package|graffiti box|gift package)$/i;
/** Для предметов без тега оружия/героя: названия контейнеров. «Case Hardened» не попадает — у скина есть тег Weapon. */
const CONTAINER_NAME = /(\bcase|\bcapsule|souvenir package|graffiti box|patch pack|pin capsule|music kit box|\btreasure|\bcache|case key|\bchest)$/i;

export function isContainer(item: SteamItem): boolean {
  const type = tag(item, "Type");
  if (type && CONTAINER_TYPES.has(type.internal_name)) return true;
  if (type && CONTAINER_TYPE_NAMES.test(tagName(type) ?? "")) return true;
  if (/\b(container|case key|treasure key)\b/i.test(item.type ?? "") && !tag(item, "Weapon")) return true;
  const hasItemTag = Boolean(tag(item, "Weapon") || tag(item, "Hero"));
  if (!hasItemTag && CONTAINER_NAME.test(item.market_hash_name.trim())) return true;
  return false;
}

/** Можно ли выставить предмет: передаваемый и не контейнер. */
export function isSellable(item: SteamItem): boolean {
  return Boolean(Number(item.tradable)) && !isContainer(item);
}

export function parseSkin(item: SteamItem): { title: string; imageUrl: string | null; skin: SkinAttributes; inspectLink: string | null } {
  const name = item.market_hash_name;
  const quality = tag(item, "Quality");
  const stickerHtml = item.descriptions?.find((d) => /sticker_info/.test(d.value))?.value ?? "";
  const stickerNames = /Sticker:\s*([^<]+)</.exec(stickerHtml)?.[1];
  const inspect = item.actions?.find((a) => /csgo_econ_action_preview/.test(a.link))?.link ?? null;
  return {
    title: name,
    imageUrl: item.icon_url ? `https://community.cloudflare.steamstatic.com/economy/image/${item.icon_url}/360fx360f` : null,
    inspectLink: inspect ? inspect.replace("%assetid%", item.assetid) : null,
    skin: {
      marketHashName: name,
      assetId: item.assetid,
      classId: item.classid,
      exterior: tagName(tag(item, "Exterior")),
      rarity: tagName(tag(item, "Rarity")),
      statTrak: name.startsWith("StatTrak™") || quality?.internal_name === "strange" ? true : undefined,
      stickers: stickerNames
        ? stickerNames
            .split(",")
            .map((s, slot) => ({ name: s.trim(), slot }))
            .filter((s) => s.name)
        : undefined,
      weaponOrHero: tagName(tag(item, "Weapon")) ?? tagName(tag(item, "Hero")),
    },
  };
}

/** float и паттерн CS2 берутся по inspect-ссылке у внешнего сервиса; без него поля просто пустые. */
export interface FloatProvider {
  inspect(link: string): Promise<{ float: number; pattern: number } | null>;
}

export type SyncResult = { seen: number; added: number; updated: number; skippedContainers: number; skippedUntradable: number; removed: number };

/**
 * Синхронизирует инвентарь одного бота по одной игре:
 * новые предметы — скрытые карточки без цены (цену ставит админ), пропавшие из инвентаря — скрываются.
 * Проданные и зарезервированные карточки не трогаются.
 */
export async function syncBotInventory(
  botId: string,
  game: SkinGame,
  items: SteamItem[],
  floats?: FloatProvider,
  ownerSteamId?: string,
): Promise<SyncResult> {
  const cfg = await getSettings();
  const res: SyncResult = { seen: items.length, added: 0, updated: 0, skippedContainers: 0, skippedUntradable: 0, removed: 0 };
  const keep: string[] = [];

  for (const item of items) {
    if (isContainer(item)) {
      res.skippedContainers++;
      continue;
    }
    if (!Number(item.tradable)) {
      res.skippedUntradable++;
      continue;
    }
    const parsed = parseSkin(item);
    const slug = `${game.toLowerCase()}-${item.assetid}`;
    keep.push(slug);
    const [existing] = await db.select().from(products).where(eq(products.slug, slug));

    let { skin } = parsed;
    if (existing?.skin?.float !== undefined) {
      skin = { ...skin, float: existing.skin.float, pattern: existing.skin.pattern };
    } else if (floats && parsed.inspectLink && game === "CS2") {
      const link = ownerSteamId ? parsed.inspectLink.replace("%owner_steamid%", ownerSteamId) : parsed.inspectLink;
      const f = await floats.inspect(link).catch(() => null);
      if (f) skin = { ...skin, float: f.float, pattern: f.pattern };
    }

    if (existing) {
      await db.update(products).set({ skin, imageUrl: parsed.imageUrl ?? existing.imageUrl, botAccountId: botId }).where(eq(products.id, existing.id));
      res.updated++;
    } else {
      await db.insert(products).values({
        slug,
        type: "SHOP_SKIN",
        game,
        title: parsed.title,
        description: "",
        deliveryMethod: "TRADE_OFFER",
        deliveryEta: `До ${cfg.skinEtaMinutes} минут после оплаты (без учета trade hold Steam)`,
        priceMinor: 0, // без цены карточку показать нельзя
        imageUrl: parsed.imageUrl,
        skin,
        botAccountId: botId,
        isActive: false,
      });
      res.added++;
    }
  }

  // Предметы, ушедшие из инвентаря (не через наш заказ), скрываем
  const gone = await db
    .update(products)
    .set({ isActive: false })
    .where(
      and(
        eq(products.botAccountId, botId),
        eq(products.game, game),
        eq(products.type, "SHOP_SKIN"),
        eq(products.isActive, true),
        isNull(products.soldAt),
        isNull(products.reservedByOrderId),
        keep.length ? notInArray(products.slug, keep) : sql`true`,
      ),
    )
    .returning({ id: products.id });
  res.removed = gone.length;

  await db
    .update(botAccounts)
    .set({ lastSyncAt: new Date(), inventoryCount: keep.length })
    .where(eq(botAccounts.id, botId));
  return res;
}

export async function hiddenUnpricedCount(botIds: string[]) {
  if (!botIds.length) return 0;
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(products)
    .where(and(inArray(products.botAccountId, botIds), eq(products.priceMinor, 0), isNull(products.soldAt)));
  return Number(r.n);
}
