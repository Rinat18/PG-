import { NextResponse, type NextRequest } from "next/server";

/**
 * Быстрый редирект на вход для кабинета, если cookie сессии нет.
 * Подпись и срок сессии проверяются на сервере в requireUser (middleware работает на edge без базы).
 */
const SESSION_COOKIE_NAME = "pg_session";

export function middleware(req: NextRequest) {
  if (!req.cookies.get(SESSION_COOKIE_NAME)?.value) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/account", "/account/:path*"] };
