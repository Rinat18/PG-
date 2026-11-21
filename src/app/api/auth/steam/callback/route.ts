import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { auditLog, users } from "@/db/schema";
import { fetchSteamProfile, STEAM_STATE_COOKIE, upsertSteamUser, verifySteamResponse } from "@/lib/auth/steam-openid";
import { safeNextPath } from "@/lib/auth/email-login";
import { getCurrentUser, startSession } from "@/lib/auth/current";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const jar = await cookies();
  let saved: { state?: string; next?: string } = {};
  try {
    saved = JSON.parse(jar.get(STEAM_STATE_COOKIE)?.value ?? "{}");
  } catch {
    // поврежденная cookie — проверка state ниже не пройдет
  }
  jar.delete({ name: STEAM_STATE_COOKIE, path: "/api/auth/steam" });

  const query = new URL(req.url).searchParams;
  const result = await verifySteamResponse(query, saved.state);
  if (!result.ok) {
    await db.insert(auditLog).values({ actor: "system", action: "auth.steam_rejected", entity: "auth", data: { reason: result.reason } });
    return NextResponse.redirect(`${env.APP_URL}/login?error=steam`, 303);
  }

  const profile = await fetchSteamProfile(result.steamId);
  const current = await getCurrentUser();
  let userId: string;

  const [steamOwner] = await db.select().from(users).where(eq(users.steamId, result.steamId));
  if (current && !current.steamId && !steamOwner) {
    // вошедший по email привязывает Steam к своему аккаунту
    await db
      .update(users)
      .set({ steamId: result.steamId, displayName: profile?.personaName ?? current.displayName, avatarUrl: profile?.avatarUrl ?? current.avatarUrl })
      .where(eq(users.id, current.id));
    await db.insert(auditLog).values({ actor: `user:${current.id}`, action: "user.steam_linked", entity: "user", entityId: current.id, data: {} });
    userId = current.id;
  } else {
    const user = await upsertSteamUser(result.steamId, profile);
    if (user.isBlocked) return NextResponse.redirect(`${env.APP_URL}/login?error=blocked`, 303);
    userId = user.id;
  }

  await startSession(userId);
  return NextResponse.redirect(`${env.APP_URL}${safeNextPath(saved.next)}`, 303);
}
