import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getUserBySessionCookie, SESSION_COOKIE, sessionMaxAgeSeconds, createSession, deleteSessionByCookie } from "./session";

/** Обертки над сессией для Server Components, server actions и route handlers. */

export const getCurrentUser = cache(async () => {
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  return getUserBySessionCookie(value);
});

/** Для страниц кабинета: без входа — редирект на /login с возвратом. */
export async function requireUser(nextPath: string) {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  return user;
}

export async function getClientIp(): Promise<string | undefined> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || undefined;
}

export const sessionCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: sessionMaxAgeSeconds(),
});

export async function startSession(userId: string) {
  const h = await headers();
  const { cookieValue } = await createSession(userId, {
    ip: await getClientIp(),
    userAgent: h.get("user-agent") ?? undefined,
  });
  (await cookies()).set(SESSION_COOKIE, cookieValue, sessionCookieOptions());
}

export async function endSession() {
  const jar = await cookies();
  await deleteSessionByCookie(jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
}
