/**
 * Тестовые данные для разработки. На боевом сайте тестовых товаров быть не должно (ТЗ, раздел 6).
 * Запуск: npm run db:seed
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "./index";
import { botAccounts, productKeys, products } from "./schema";
import { encrypt, sha256 } from "@/lib/crypto";

type NewProduct = typeof products.$inferInsert;

const catalog: NewProduct[] = [
  {
    slug: "cs2-prime-status",
    type: "CS2_PRIME",
    game: "CS2",
    title: "CS2 Prime Status",
    description: "Prime Status Upgrade для Counter-Strike 2: матчмейкинг с Prime-игроками, дропы и сувениры.",
    activationInstructions: "Откройте Steam → Игры → Активировать в Steam, введите ключ. Статус привяжется к аккаунту.",
    deliveryMethod: "KEY",
    deliveryEta: "Сразу после оплаты",
    priceMinor: 1_350_00,
    popularity: 100,
  },
  {
    slug: "dota-plus-1m",
    type: "DOTA_PLUS",
    game: "DOTA2",
    title: "Dota Plus — 1 месяц",
    description: "Подписка Dota Plus на 1 месяц.",
    activationInstructions: "Способ активации уточняется [__].",
    durationMonths: 1,
    deliveryMethod: "MANUAL",
    deliveryEta: "До [__] часов",
    priceMinor: 450_00,
    popularity: 80,
  },
  {
    slug: "dota-plus-6m",
    type: "DOTA_PLUS",
    game: "DOTA2",
    title: "Dota Plus — 6 месяцев",
    description: "Подписка Dota Plus на 6 месяцев.",
    activationInstructions: "Способ активации уточняется [__].",
    durationMonths: 6,
    deliveryMethod: "MANUAL",
    deliveryEta: "До [__] часов",
    priceMinor: 2_400_00,
    popularity: 60,
  },
  {
    slug: "dota-plus-12m",
    type: "DOTA_PLUS",
    game: "DOTA2",
    title: "Dota Plus — 12 месяцев",
    description: "Подписка Dota Plus на 12 месяцев.",
    activationInstructions: "Способ активации уточняется [__].",
    durationMonths: 12,
    deliveryMethod: "MANUAL",
    deliveryEta: "До [__] часов",
    priceMinor: 4_500_00,
    popularity: 50,
  },
  {
    slug: "test-game-key",
    type: "GAME_KEY",
    game: "OTHER",
    title: "Тестовая игра (ключ Steam)",
    description: "Тестовый товар для проверки выдачи ключей.",
    activationInstructions: "Steam → Игры → Активировать в Steam → введите ключ.",
    region: "СНГ",
    deliveryMethod: "KEY",
    deliveryEta: "Сразу после оплаты",
    priceMinor: 990_00,
    popularity: 40,
  },
  {
    slug: "ak-47-redline-ft-st",
    type: "SHOP_SKIN",
    game: "CS2",
    title: "StatTrak™ AK-47 | Redline (Field-Tested)",
    description: "Скин из инвентаря магазина. Цена фиксирована.",
    deliveryMethod: "TRADE_OFFER",
    deliveryEta: "До [__] минут, учитывайте trade hold Steam",
    priceMinor: 3_200_00,
    popularity: 70,
    skin: {
      marketHashName: "StatTrak™ AK-47 | Redline (Field-Tested)",
      exterior: "Field-Tested",
      rarity: "Classified",
      float: 0.2481,
      pattern: 311,
      statTrak: true,
      weaponOrHero: "AK-47",
      stickers: [],
    },
  },
  {
    slug: "awp-asiimov-ft",
    type: "SHOP_SKIN",
    game: "CS2",
    title: "AWP | Asiimov (Field-Tested)",
    description: "Скин из инвентаря магазина. Цена фиксирована.",
    deliveryMethod: "TRADE_OFFER",
    deliveryEta: "До [__] минут, учитывайте trade hold Steam",
    priceMinor: 9_800_00,
    popularity: 90,
    skin: {
      marketHashName: "AWP | Asiimov (Field-Tested)",
      exterior: "Field-Tested",
      rarity: "Covert",
      float: 0.2712,
      pattern: 45,
      statTrak: false,
      weaponOrHero: "AWP",
    },
  },
  {
    slug: "dota-inscribed-manifold-paradox",
    type: "SHOP_SKIN",
    game: "DOTA2",
    title: "Inscribed Manifold Paradox (Phantom Assassin)",
    description: "Предмет Dota 2 из инвентаря магазина.",
    deliveryMethod: "TRADE_OFFER",
    deliveryEta: "До [__] минут, учитывайте trade hold Steam",
    priceMinor: 2_150_00,
    popularity: 65,
    skin: {
      marketHashName: "Inscribed Manifold Paradox",
      rarity: "Arcana",
      weaponOrHero: "Phantom Assassin",
    },
  },
];

async function main() {
  await db.execute(sql`truncate table product_keys, products, bot_accounts restart identity cascade`);
  const [bot] = await db.insert(botAccounts).values({ name: "bot-dev-1", steamId: "76561190000000001" }).returning();
  const inserted = await db
    .insert(products)
    .values(catalog.map((p) => (p.type === "SHOP_SKIN" ? { ...p, botAccountId: bot.id } : p)))
    .returning();

  const keyed = inserted.filter((p) => p.deliveryMethod === "KEY");
  for (const p of keyed) {
    const codes = Array.from({ length: 5 }, (_, i) => `TEST-${p.slug.slice(0, 4).toUpperCase()}-${i}${Date.now() % 10000}`);
    await db.insert(productKeys).values(codes.map((c) => ({ productId: p.id, encryptedCode: encrypt(c), codeHash: sha256(c) })));
  }
  console.log(`seeded ${inserted.length} products, ${keyed.length * 5} keys`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
