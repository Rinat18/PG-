import { NextResponse, type NextRequest } from "next/server";

/**
 * 1) Быстрый редирект на вход для кабинета и админки, если cookie сессии нет.
 *    Подпись и срок сессии проверяются на сервере в requireUser (middleware работает без базы).
 * 2) Метка устройства pg_did: по ней находим связанные аккаунты в P2P (ТЗ 5.1).
 */
const SESSION_COOKIE_NAME = "pg_session";
const DEVICE_COOKIE_NAME = "pg_did";
const PROTECTED = /^\/(account|admin|sell)(\/|$)/;

/** Демо-стенд: пароль на весь сайт (DEMO_PASSWORD). Webhook оплаты и крон сюда не попадают (matcher). */
function demoAuthOk(req: NextRequest) {
  const pass = process.env.DEMO_PASSWORD;
  if (!pass) return true;
  const h = req.headers.get("authorization") ?? "";
  if (!h.startsWith("Basic ")) return false;
  const decoded = atob(h.slice(6));
  return decoded.slice(decoded.indexOf(":") + 1) === pass;
}

export function middleware(req: NextRequest) {
  if (!demoAuthOk(req)) {
    return new NextResponse("Нужен пароль демо-стенда", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="PlayGround demo", charset="UTF-8"' },
    });
  }
  let res: NextResponse;
  if (PROTECTED.test(req.nextUrl.pathname) && !req.cookies.get(SESSION_COOKIE_NAME)?.value) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
    res = NextResponse.redirect(url);
  } else {
    res = NextResponse.next();
  }
  if (!req.cookies.get(DEVICE_COOKIE_NAME)?.value) {
    res.cookies.set(DEVICE_COOKIE_NAME, crypto.randomUUID(), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 2 * 365 * 24 * 3600,
    });
  }
  return res;
}

export const config = { matcher: ["/((?!_next/|favicon.ico|api/payments|api/cron).*)"] };
