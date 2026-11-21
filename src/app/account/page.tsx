import Link from "next/link";
import { listUserOrders } from "@/lib/account";
import { requireUser } from "@/lib/auth/current";
import { formatKgs, orderStatusLabel } from "@/lib/format";
import { EmailLoginForm } from "../login/EmailLoginForm";
import { TradeUrlForm } from "./TradeUrlForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Личный кабинет", robots: { index: false } };

const tone: Record<string, string> = {
  PENDING_PAYMENT: "text-accent",
  PAID: "text-ok",
  TRADE_SENT: "text-ok",
  DELIVERED: "text-ok",
  PROBLEM: "text-bad",
  REFUNDED: "text-muted",
  CANCELLED: "text-muted",
};

export default async function AccountPage() {
  const user = await requireUser("/account");
  const orders = await listUserOrders(user.id);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-4">
        {user.avatarUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.avatarUrl} alt="" width={56} height={56} className="rounded-full border border-line" />
        )}
        <div className="flex-1">
          <h1 className="text-xl font-bold">{user.displayName ?? user.email ?? "Личный кабинет"}</h1>
          <div className="text-sm text-muted">
            {user.steamId ? `Steam ID ${user.steamId}` : "Steam не привязан"}
            {user.email && ` · ${user.email}${user.emailVerifiedAt ? "" : " (не подтвержден)"}`}
          </div>
        </div>
        <form action="/api/auth/logout" method="post">
          <button className="btn-ghost">Выйти</button>
        </form>
      </div>

      <section className="space-y-3">
        <h2 className="font-bold">Мои заказы</h2>
        {orders.length === 0 ? (
          <div className="card p-6 text-sm text-muted">
            Заказов пока нет. <Link href="/" className="text-accent underline">Перейти в магазин</Link>
          </div>
        ) : (
          <div className="card divide-y divide-line text-sm">
            {orders.map((o) => (
              <Link key={o.id} href={`/account/orders/${o.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-panel-2">
                <span className="font-mono text-xs text-muted">{o.number}</span>
                <span className="min-w-0 flex-1 truncate">{o.titles.join(", ")}</span>
                <span className={`font-semibold ${tone[o.status]}`}>{orderStatusLabel[o.status]}</span>
                <span className="w-24 text-right font-semibold">{formatKgs(o.totalMinor)}</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="card space-y-3 p-6">
          <h2 className="font-bold">Trade-ссылка Steam</h2>
          <p className="text-xs text-muted">На нее бот магазина отправит купленный скин. Ссылка должна принадлежать вашему аккаунту Steam.</p>
          {!user.steamId && (
            <a href="/api/auth/steam?next=/account" className="btn-primary">Привязать Steam</a>
          )}
          <TradeUrlForm initial={user.tradeUrl ?? ""} disabled={!user.steamId} />
        </section>

        <section className="card space-y-3 p-6">
          <h2 className="font-bold">Email</h2>
          {user.email && user.emailVerifiedAt ? (
            <p className="text-sm">
              {user.email} подтвержден. Заказы на этот email автоматически попадают в кабинет.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted">
                Подтвердите email: на него приходят чеки и ключи, а заказы, оформленные без входа, появятся здесь.
              </p>
              <EmailLoginForm next="/account" link defaultEmail={user.email ?? undefined} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
