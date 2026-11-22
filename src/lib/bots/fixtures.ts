import type { SteamItem, SteamTag } from "./inventory";

/**
 * Предметы в формате ответа инвентаря Steam (IEconItems / steamcommunity.com/inventory),
 * с тегами, как их отдает Steam. Используются в тестах фильтра контейнеров и в mock-боте.
 */

const t = (category: string, internal_name: string, localized_tag_name: string): SteamTag => ({ category, internal_name, localized_tag_name });
const icon = "-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot7HxfDhjxszJemkV09-5lpKKqPrxN7LEmyVQ7MEpiLuSrYmnjQO3-UdsZGHyd4_Bd1RvNQ7T_FDrw-_ng5Pu75iY1zI97bhLsvQz";

export const cs2Items = {
  akRedlineFT: {
    assetid: "35181112001",
    classid: "4141780591",
    instanceid: "188530139",
    appid: 730,
    contextid: "2",
    market_hash_name: "AK-47 | Redline (Field-Tested)",
    name: "AK-47 | Redline",
    type: "Classified Rifle",
    tradable: 1,
    marketable: 1,
    icon_url: icon,
    tags: [
      t("Type", "CSGO_Type_Rifle", "Rifle"),
      t("Weapon", "weapon_ak47", "AK-47"),
      t("ItemSet", "set_community_1", "The Phoenix Collection"),
      t("Quality", "normal", "Normal"),
      t("Rarity", "Rarity_Legendary_Weapon", "Classified"),
      t("Exterior", "WearCategory2", "Field-Tested"),
    ],
    descriptions: [
      { type: "html", value: "Exterior: Field-Tested" },
      {
        type: "html",
        value:
          '<br><div id="sticker_info" name="sticker_info" title="Sticker" style="border: 2px solid rgb(102, 102, 102)">' +
          '<img width=64 height=48 src="https://steamcdn-a.akamaihd.net/apps/730/icons/econ/stickers/kat2014/nip.png">' +
          "<br>Sticker: Ninjas in Pyjamas | Katowice 2014, Crown (Foil)</div>",
      },
    ],
    actions: [
      { link: "steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20S%owner_steamid%A%assetid%D7935523998312483177", name: "Inspect in Game..." },
    ],
  },
  akCaseHardenedST: {
    assetid: "35181112002",
    appid: 730,
    market_hash_name: "StatTrak™ AK-47 | Case Hardened (Minimal Wear)",
    type: "StatTrak™ Classified Rifle",
    tradable: 1,
    tags: [
      t("Type", "CSGO_Type_Rifle", "Rifle"),
      t("Weapon", "weapon_ak47", "AK-47"),
      t("Quality", "strange", "StatTrak™"),
      t("Rarity", "Rarity_Legendary_Weapon", "Classified"),
      t("Exterior", "WearCategory1", "Minimal Wear"),
    ],
  },
  karambitFade: {
    assetid: "35181112003",
    appid: 730,
    market_hash_name: "★ Karambit | Fade (Factory New)",
    type: "★ Covert Knife",
    tradable: 1,
    tags: [
      t("Type", "CSGO_Type_Knife", "Knife"),
      t("Weapon", "weapon_knife_karambit", "Karambit"),
      t("Quality", "unusual", "★"),
      t("Rarity", "Rarity_Ancient_Weapon", "Covert"),
      t("Exterior", "WearCategory0", "Factory New"),
    ],
  },
  agent: {
    assetid: "35181112004",
    appid: 730,
    market_hash_name: "Sir Bloody Miami Darryl | The Professionals",
    type: "Master Agent",
    tradable: 1,
    tags: [t("Type", "Type_CustomPlayer", "Agent"), t("Quality", "normal", "Normal"), t("Rarity", "Rarity_Ancient_Character", "Master")],
  },
  sticker: {
    assetid: "35181112005",
    appid: 730,
    market_hash_name: "Sticker | Natus Vincere (Holo) | Paris 2023",
    type: "Exotic Sticker",
    tradable: 1,
    tags: [t("Type", "CSGO_Tool_Sticker", "Sticker"), t("Quality", "normal", "Normal"), t("Rarity", "Rarity_Rare", "High Grade")],
  },
  // --- контейнеры: в каталог не попадают ---
  revolutionCase: {
    assetid: "35181112101",
    appid: 730,
    market_hash_name: "Revolution Case",
    type: "Base Grade Container",
    tradable: 1,
    tags: [
      t("Type", "CSGO_Type_WeaponCase", "Container"),
      t("ItemSet", "set_community_32", "The Revolution Collection"),
      t("Quality", "normal", "Normal"),
      t("Rarity", "Rarity_Common", "Base Grade"),
    ],
  },
  caseKey: {
    assetid: "35181112102",
    appid: 730,
    market_hash_name: "Kilowatt Case Key",
    type: "Base Grade Key",
    tradable: 0,
    tags: [t("Type", "CSGO_Tool_WeaponCase_KeyTag", "Key"), t("Quality", "normal", "Normal"), t("Rarity", "Rarity_Common", "Base Grade")],
  },
  stickerCapsule: {
    assetid: "35181112103",
    appid: 730,
    market_hash_name: "Copenhagen 2024 Legends Sticker Capsule",
    type: "Base Grade Container",
    tradable: 1,
    tags: [t("Type", "CSGO_Type_WeaponCase", "Container"), t("Quality", "normal", "Normal"), t("Rarity", "Rarity_Common", "Base Grade")],
  },
  souvenirPackage: {
    assetid: "35181112104",
    appid: 730,
    market_hash_name: "Paris 2023 Mirage Souvenir Package",
    type: "Base Grade Container",
    tradable: 1,
    tags: [t("Type", "CSGO_Type_WeaponCase", "Container"), t("Quality", "normal", "Normal")],
  },
  musicKitBox: {
    assetid: "35181112105",
    appid: 730,
    market_hash_name: "StatTrak™ Masterminds 2 Music Kit Box",
    type: "Base Grade Container",
    tradable: 1,
    tags: [t("Type", "CSGO_Type_WeaponCase", "Container"), t("Quality", "strange", "StatTrak™")],
  },
  graffitiBox: {
    // старые коробки без тега Type: ловятся по названию
    assetid: "35181112106",
    appid: 730,
    market_hash_name: "Community Graffiti Box",
    type: "Base Grade Container",
    tradable: 1,
    tags: [t("Quality", "normal", "Normal")],
  },
} satisfies Record<string, SteamItem>;

export const dotaItems = {
  arcanaPA: {
    assetid: "27001100001",
    appid: 570,
    contextid: "2",
    market_hash_name: "Manifold Paradox",
    type: "Arcana Wearable",
    tradable: 1,
    icon_url: icon,
    tags: [
      t("Quality", "unique", "Standard"),
      t("Rarity", "Rarity_Arcana", "Arcana"),
      t("Type", "wearable", "Wearable"),
      t("Slot", "weapon", "Weapon"),
      t("Hero", "npc_dota_hero_phantom_assassin", "Phantom Assassin"),
    ],
  },
  courier: {
    assetid: "27001100002",
    appid: 570,
    market_hash_name: "Golden Baby Roshan",
    type: "Immortal Courier",
    tradable: 1,
    tags: [t("Quality", "unique", "Standard"), t("Rarity", "Rarity_Immortal", "Immortal"), t("Type", "courier", "Courier")],
  },
  // --- контейнеры ---
  treasure: {
    assetid: "27001100101",
    appid: 570,
    market_hash_name: "Treasure of the Crimson Witness 2023",
    type: "Immortal Treasure",
    tradable: 1,
    tags: [t("Quality", "unique", "Standard"), t("Rarity", "Rarity_Immortal", "Immortal"), t("Type", "treasure_chest", "Treasure")],
  },
  treasureKey: {
    assetid: "27001100102",
    appid: 570,
    market_hash_name: "Treasure Key",
    type: "Common Key",
    tradable: 1,
    tags: [t("Quality", "unique", "Standard"), t("Rarity", "Rarity_Common", "Common"), t("Type", "key", "Treasure Key")],
  },
  cache: {
    assetid: "27001100103",
    appid: 570,
    market_hash_name: "Collector's Cache",
    type: "Mythical Treasure",
    tradable: 1,
    tags: [t("Quality", "unique", "Standard"), t("Rarity", "Rarity_Mythical", "Mythical"), t("Type", "retired_treasure_chest", "Treasure")],
  },
  untradable: {
    assetid: "27001100104",
    appid: 570,
    market_hash_name: "Inscribed Battle Fury",
    type: "Rare Wearable",
    tradable: 0,
    tags: [t("Quality", "strange", "Inscribed"), t("Type", "wearable", "Wearable"), t("Hero", "npc_dota_hero_antimage", "Anti-Mage")],
  },
} satisfies Record<string, SteamItem>;
