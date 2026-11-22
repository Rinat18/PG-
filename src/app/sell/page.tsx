import Link from "next/link";
import { requireUser } from "@/lib/auth/current";
import { getSellerCabinet } from "@/lib/p2p/seller";
import { dealStage } from "@/lib/p2p/deals";
import { formatKgs } from "@/lib/format";
import { Flash, fmtDate } from "@/components/admin/ui";
import { withdrawListingAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Кабинет продавца", robots: { index: false } };

const verificationText: Record<string, string> = {
  NOT_STARTED: "Не пройдена",
  PENDING: "На проверке",
  APPROVED: "Пройдена",
  REJECTED: "Отклонена",
};
const listingStatus: Record<string, string> = { ACTIVE: "На витрине", RESERVED: "Оплачивается", SOLD: "Продан", WITHDRAWN: "Снят", BLOCKED: "Заблокирован" };

export default async function SellerCabinet({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const user = await requireUser("/sell");
  if (!user.steamId) {
    return (
      <div className="card mx-auto max-w-lg space-y-3 p-6 text-sm">
        <h1 className="text-xl font-bold">Продажа скинов</h1>
        <p className="text-muted">Продавать можно только со входом через Steam: лот выставляется из вашего инвентаря Steam.</p>
        <a href="/api/auth/steam?next=/sell" className="btn-primary">Войти через Steam</a>
      </div>
    );
  }
  const c = await getSellerCabinet(user);
  const status = c.profile?.status ?? "NOT_STARTED";
  const active = c.deals.filter((d) => ["AWAITING_TRANSFER", "REVIEW", "DISPUTE"].includes(d.deal.status));

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Кабинет продавца</h1>
        <div className="flex gap-2">
          <Link href="/sell/new?game=CS2" className="btn-primary">Выставить скин CS2</Link>
          <Link href="/sell/new?game=DOTA2" className="btn-ghost">Скин Dota 2</Link>
        </div>
      </div>
      <Flash ok={sp.ok} error={sp.error} />

      <div className="grid gap-4 md:grid-cols-3">
        <div className="card space-y-2 p-4 text-sm">
          <div className="text-xs text-muted">Верификация</div>
          <div className={`text-lg font-bold ${status === "APPROVED" ? "text-ok" : status === "REJECTED" ? "text-bad" : ""}`}>{verificationText[status]}</div>
          {status === "REJECTED" && <p className="text-xs text-bad">Причина: {c.profile?.rejectionReason}</p>}
          {(status === "NOT_STARTED" || status === "REJECTED") && (
            <>
              <p className="text-xs text-muted">Без верификации выплаты не отправляются: деньги за сделки ждут на балансе.</p>
              <Link href="/sell/verify" className="btn-primary w-full">{status === "REJECTED" ? "Подать заново" : "Пройти верификацию"}</Link>
            </>
          )}
          {c.profile?.payoutMasked && status === "APPROVED" && <p className="text-xs text-muted">Выплаты на {c.profile.payoutMasked}</p>}
        </div>
        <div className="card space-y-1 p-4">
          <div className="text-xs text-muted">Баланс к выплате</div>
          <div className="text-2xl font-black">{formatKgs(c.balance)}</div>
          <p className="text-xs text-muted">Пополнить баланс нельзя: сюда попадают только деньги за завершенные сделки.</p>
        </div>
        <div className="card space-y-1 p-4">
          <div className="text-xs text-muted">В сделках (до конца защиты)</div>
          <div className="text-2xl font-black">{formatKgs(c.pendingEarnings)}</div>
          <p className="text-xs text-muted">
            Комиссия {c.settings.commission}%. Передать скин — {c.settings.transferHours} ч, защита от отката — {c.settings.protectionDays} дн.
          </p>
        </div>
      </div>

      {active.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-bold">Нужно действие</h2>
          <div className="card divide-y divide-line text-sm">
            {active.map(({ deal, listing }) => (
              <Link key={deal.id} href={`/sell/deals/${deal.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-panel-2">
                <span className="min-w-0 flex-1 truncate font-semibold">{listing.title}</span>
                <span className="text-accent">{dealStage(deal)}</span>
                {deal.transferDeadline && deal.status === "AWAITING_TRANSFER" && <span className="text-xs text-muted">передать до {fmtDate(deal.transferDeadline)}</span>}
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="font-bold">Мои лоты</h2>
        {c.listings.length === 0 ? (
          <div className="card p-6 text-sm text-muted">Лотов пока нет.</div>
        ) : (
          <div className="card divide-y divide-line text-sm">
            {c.listings.map((l) => (
              <div key={l.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                <Link href={`/lot/${l.id}`} className="min-w-0 flex-1 truncate hover:text-accent">{l.title}</Link>
                <span className="text-xs text-muted">{listingStatus[l.status]}{l.blockedReason ? `: ${l.blockedReason}` : ""}</span>
                <span className="w-28 text-right font-semibold">{formatKgs(l.priceMinor)}</span>
                {l.status === "ACTIVE" && (
                  <form action={withdrawListingAction}>
                    <input type="hidden" name="listingId" value={l.id} />
                    <button className="text-xs text-muted underline hover:text-text">Снять</button>
                  </form>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-bold">Сделки</h2>
        {c.deals.length === 0 ? (
          <div className="card p-6 text-sm text-muted">Сделок пока нет.</div>
        ) : (
          <div className="card divide-y divide-line text-sm">
            {c.deals.map(({ deal, listing, orderNumber }) => (
              <Link key={deal.id} href={`/sell/deals/${deal.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-panel-2">
                <span className="font-mono text-xs text-muted">{orderNumber}</span>
                <span className="min-w-0 flex-1 truncate">{listing.title}</span>
                <span className={deal.status === "CANCELLED" ? "text-muted" : deal.status === "PAID_OUT" ? "text-ok" : "text-accent"}>{dealStage(deal)}</span>
                <span className="w-28 text-right font-semibold">{formatKgs(deal.priceMinor - deal.commissionMinor)}</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {c.payouts.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-bold">Выплаты</h2>
          <div className="card divide-y divide-line text-sm">
            {c.payouts.map((p) => (
              <div key={p.id} className="flex flex-wrap gap-x-4 px-4 py-3">
                <span className="text-xs text-muted">{fmtDate(p.createdAt)}</span>
                <span className="flex-1">{p.status === "SENT" ? "Отправлена" : p.status === "FAILED" ? `Не прошла: ${p.error ?? ""}` : "В обработке"}</span>
                <span className="font-semibold">{formatKgs(p.amountMinor)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="text-xs text-muted">
        Правила: <Link href="/info/seller-rules" className="text-accent underline">оферта для продавцов</Link>. Кейсы, ключи от кейсов и капсулы выставить нельзя.
      </p>
    </div>
  );
}
