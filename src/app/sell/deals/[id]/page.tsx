import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/current";
import { getDealForSeller } from "@/lib/p2p/deals";
import { env } from "@/lib/env";
import { formatKgs } from "@/lib/format";
import { Flash, fmtDate } from "@/components/admin/ui";
import { declineDealAction, mockTransferAction } from "../../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Сделка", robots: { index: false } };

export default async function SellerDeal({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser(`/sell/deals/${id}`);
  const v = await getDealForSeller(user, id);
  if (!v) notFound();
  const { deal, listing } = v;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Link href="/sell" className="text-sm text-muted hover:text-text">← Кабинет продавца</Link>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-bold">{listing.title}</h1>
        <span className="text-sm font-semibold text-accent">{v.stage}</span>
      </div>
      <Flash ok={sp.ok} error={sp.error} />

      <dl className="card divide-y divide-line text-sm">
        {[
          ["Заказ", v.orderNumber],
          ["Цена", formatKgs(deal.priceMinor)],
          ["Комиссия", formatKgs(deal.commissionMinor)],
          ["Вы получите", formatKgs(v.payoutMinor)],
          ["Срок передачи", deal.transferDeadline ? fmtDate(deal.transferDeadline) : "—"],
          ["Передан", fmtDate(deal.transferredAt)],
          ["Защита от отката до", fmtDate(deal.protectionUntil)],
        ].map(([k, val]) => (
          <div key={k} className="flex justify-between gap-4 px-4 py-2.5">
            <dt className="text-muted">{k}</dt>
            <dd className="text-right font-medium">{val}</dd>
          </div>
        ))}
      </dl>

      {deal.status === "AWAITING_TRANSFER" && v.buyerTradeUrl && (
        <div className="card space-y-3 p-4 text-sm">
          <div className="font-semibold">Передайте скин покупателю</div>
          <ol className="list-decimal space-y-1 pl-5 text-muted">
            <li>Откройте trade-ссылку покупателя и добавьте в обмен только «{listing.title}».</li>
            <li>Ничего не просите взамен и отправьте обмен, подтвердите его в Steam Guard.</li>
            <li>Сайт сам проверит через Steam, что предмет пришел покупателю. Писать покупателю не нужно.</li>
          </ol>
          <a href={v.buyerTradeUrl} target="_blank" rel="noopener noreferrer" className="btn-primary w-full">Открыть обмен в Steam</a>
          {env.STEAM_CHECKS === "mock" && (
            <form action={mockTransferAction} className="rounded-lg border border-dashed border-accent/50 p-3 text-xs text-muted">
              <input type="hidden" name="dealId" value={deal.id} />
              Режим разработки: Steam не настоящий. <button className="text-accent underline">Передать предмет (тест)</button>
            </form>
          )}
        </div>
      )}
      {deal.status === "REVIEW" && (
        <p className="card p-4 text-sm text-muted">Сделка на проверке у сотрудника. Пока проверка не закончится, скин не передавайте — мы напишем, когда можно.</p>
      )}
      {deal.status === "DISPUTE" && <p className="card p-4 text-sm text-accent">Покупатель открыл спор, его рассматривает поддержка.</p>}
      {deal.status === "PROTECTION" && !deal.earningCreditedAt && (
        <p className="card p-4 text-sm text-muted">Скин у покупателя. Деньги поступят после окончания срока, в который Steam может откатить обмен.</p>
      )}
      {deal.payoutError && deal.status === "PROTECTION" && (
        <p className="rounded-xl border border-bad/40 bg-bad/10 p-4 text-sm">
          Выплата не отправлена: {deal.payoutError}.{" "}
          {/верифи/.test(deal.payoutError) && <Link href="/sell/verify" className="text-accent underline">Пройти верификацию</Link>}
        </p>
      )}
      {deal.status === "CANCELLED" && <p className="card p-4 text-sm text-muted">Сделка отменена, покупателю вернули деньги.</p>}

      {["AWAITING_TRANSFER", "REVIEW"].includes(deal.status) && (
        <form action={declineDealAction} className="text-right">
          <input type="hidden" name="dealId" value={deal.id} />
          <button className="text-xs text-muted underline hover:text-bad">Отказаться от сделки (покупателю вернутся деньги, рейтинг снизится)</button>
        </form>
      )}
    </div>
  );
}
