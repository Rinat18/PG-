import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { randomToken } from "@/lib/crypto";
import { buildSteamLoginUrl, STEAM_STATE_COOKIE } from "@/lib/auth/steam-openid";
import { safeNextPath } from "@/lib/auth/email-login";
import { getClientIp } from "@/lib/auth/current";
import { allowFormByIp } from "@/lib/security/rate-limit";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Старт входа через Steam: state в httpOnly-cookie, затем редирект на Steam OpenID. */
export async function GET(req: Request) {
  if (!(await allowFormByIp("steamLogin", await getClientIp()))) {
    return NextResponse.redirect(`${env.APP_URL}/login?error=rate`, 303);
  }
  const next = safeNextPath(new URL(req.url).searchParams.get("next"));
  const state = randomToken(18);
  (await cookies()).set(STEAM_STATE_COOKIE, JSON.stringify({ state, next }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/auth/steam",
    maxAge: 10 * 60,
  });
  return NextResponse.redirect(buildSteamLoginUrl(state), 303);
}
