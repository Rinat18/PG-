import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { navGames, site } from "@/lib/site";
import { getCurrentUser } from "@/lib/auth/current";

export const metadata: Metadata = {
  title: { default: `${site.name} — ключи, Prime, Dota Plus и скины`, template: `%s · ${site.name}` },
  description: "Ключи игр, CS2 Prime, Dota Plus и скины CS2 и Dota 2 с оплатой по QR ELQR в сомах.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await getCurrentUser();
  return (
    <html lang="ru">
      <body className="min-h-screen flex flex-col antialiased">
        <header className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
            <Link href="/" className="text-lg font-extrabold tracking-tight">
              Play<span className="text-accent">Ground</span>
            </Link>
            <nav className="flex gap-4 text-sm text-muted">
              {navGames.map((g) => (
                <Link key={g.href} href={g.href} className="hover:text-text">
                  {g.label}
                </Link>
              ))}
            </nav>
            <form action="/search" className="ml-auto hidden sm:block">
              <input name="q" placeholder="Поиск товара" className="input w-56 py-1.5" />
            </form>
            {user && user.role !== "BUYER" && (
              <Link href="/admin" className="ml-auto text-sm text-muted hover:text-text sm:ml-0">
                Админка
              </Link>
            )}
            <Link href={user ? "/account" : "/login"} className="ml-auto text-sm font-semibold hover:text-accent sm:ml-0">
              {user ? (user.displayName ?? "Кабинет") : "Войти"}
            </Link>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>

        <footer className="border-t border-line text-xs text-muted">
          <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 sm:grid-cols-3">
            <div className="space-y-1">
              <div className="font-semibold text-text">{site.legalName}</div>
              <div>ИНН: {site.inn}</div>
              <div>Адрес: {site.address}</div>
              <div>
                {site.phone} · {site.email}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Link href="/info/payment" className="hover:text-text">Оплата и выдача</Link>
              <Link href="/info/refund" className="hover:text-text">Возврат</Link>
              <Link href="/info/contacts" className="hover:text-text">Контакты и реквизиты</Link>
            </div>
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 rounded-md border border-line px-2 py-1 font-semibold text-text">
                ELQR · оплата по QR
              </div>
              <p>Цены в сомах (KGS). Продажа лицам старше 18 лет.</p>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
