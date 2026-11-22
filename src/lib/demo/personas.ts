import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";

/** Тестовые роли демо-стенда. SteamID ненастоящие: инвентари и проверки Steam — тестовые. */
const STEAM_BASE = BigInt("76561197960265728");
const tradeUrl = (steamId: string, token: string) =>
  `https://steamcommunity.com/tradeoffer/new/?partner=${BigInt(steamId) - STEAM_BASE}&token=${token}`;

export const DEMO_PERSONAS = {
  buyer: {
    label: "Покупатель",
    hint: "Steam-аккаунт с trade-ссылкой: ключи, Prime, скины магазина и лоты продавцов",
    steamId: "76561198000000101",
    email: "buyer@playground.demo",
    role: "BUYER",
    token: "DemoBuy1",
  },
  seller: {
    label: "Продавец P2P",
    hint: "Steam-аккаунт с тестовым инвентарем: верификация, выставление скинов, сделки",
    steamId: "76561198000000102",
    email: "seller@playground.demo",
    role: "BUYER",
    token: "DemoSel1",
  },
  admin: { label: "Администратор", hint: "Все разделы админки", email: "admin@playground.demo", role: "ADMIN" },
  support: { label: "Поддержка", hint: "Заказы и клиенты, без настроек и паспортных данных", email: "support@playground.demo", role: "SUPPORT" },
  compliance: { label: "Комплаенс", hint: "Верификация продавцов, проверка сделок и споры", email: "compliance@playground.demo", role: "COMPLIANCE" },
} as const satisfies Record<string, { label: string; hint: string; email: string; role: SessionUser["role"]; steamId?: string; token?: string }>;

export type DemoPersona = keyof typeof DEMO_PERSONAS;

export async function ensureDemoUser(key: DemoPersona) {
  const p = DEMO_PERSONAS[key];
  const [existing] = await db.select().from(users).where(eq(users.email, p.email));
  if (existing) return existing;
  const steam = "steamId" in p ? { steamId: p.steamId, tradeUrl: tradeUrl(p.steamId, p.token) } : {};
  const [row] = await db
    .insert(users)
    .values({ email: p.email, role: p.role, displayName: `Демо: ${p.label}`, emailVerifiedAt: new Date(), ...steam })
    .returning();
  return row;
}
