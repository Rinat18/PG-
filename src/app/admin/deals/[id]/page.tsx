import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/admin/page";
import { can } from "@/lib/admin/rbac";
import { getDealAdmin } from "@/lib/p2p/deals";
import { linkReasonLabel } from "@/lib/p2p/fingerprints";
import { formatKgs } from "@/lib/format";
import { Flash, fmtDate, PageHead } from "@/components/admin/ui";
import { dealReviewAction, resolveDisputeAction } from "../../actions";

const verification: Record<string, string> = { NOT_STARTED: "не начата", PENDING: "на проверке", APPROVED: "пройдена", REJECTED: "отклонена" };

export default async function AdminDeal({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireAdminPage("deals.view", `/admin/deals/${id}`);
  const v = await getDealAdmin(user, id);
  if (!v) notFound();
  const { deal: d, listing: l, order } = v;
  const manage = can(user, "deals.manage");

  const rows: [string, React.ReactNode][] = [
    ["Предмет", <Link key="l" href={`/lot/${l.id}`} className="text-accent underline">{l.title}</Link>],
    ["Заказ", <Link key="o" href={`/admin/orders/${order.id}`} className="font-mono text-accent underline">{order.number}</Link>],
    ["Цена / рынок", `${formatKgs(d.priceMinor)} / ${l.marketPriceMinor ? formatKgs(l.marketPriceMinor) : "нет данных"}`],
    ["Комиссия / продавцу", `${formatKgs(d.commissionMinor)} / ${formatKgs(v.sellerAmount)}`],
    ["Продавец", <Link key="s" href={`/admin/clients/${v.seller.id}`} className="text-accent underline">{v.seller.displayName ?? v.seller.steamId}</Link>],
    ["Верификация продавца", verification[v.sellerVerification]],
    ["Покупатель", v.buyer ? <Link key="b" href={`/admin/clients/${v.buyer.id}`} className="text-accent underline">{v.buyer.displayName ?? v.buyer.steamId}</Link> : "—"],
    ["Trade-ссылка покупателя", <span key="t" className="break-all text-xs">{order.tradeUrl}</span>],
    ["Связь аккаунтов", v.links.length ? <span key="k" className="text-bad">{v.links.map((x) => linkReasonLabel[x]).join(", ")}</span> : "не найдена"],
    ["Срок передачи", fmtDate(d.transferDeadline)],
    ["Передан / assetid у покупателя", `${fmtDate(d.transferredAt)} ${d.receivedAssetId ?? ""}`],
    ["Защита от отката до", fmtDate(d.protectionUntil)],
    ["Заработок начислен", fmtDate(d.earningCreditedAt)],
    ["Последняя проверка Steam", `${fmtDate(d.lastCheckAt)} ${d.lastCheckError ?? ""}`],
  ];

  return (
    <>
      <Link href="/admin/deals" className="text-sm text-muted hover:text-text">← Сделки</Link>
      <PageHead title={`Сделка по заказу ${order.number}`}>
        <span className="font-semibold">{v.stage}</span>
      </PageHead>
      <Flash ok={sp.ok} error={sp.error} />
      {(d.reviewReason || d.disputeReason || d.payoutError || d.cancelReason) && (
        <div className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm">
          {d.reviewReason && <div>Проверка: {d.reviewReason}</div>}
          {d.disputeReason && <div>Спор: {d.disputeReason}</div>}
          {d.payoutError && <div>Выплата: {d.payoutError}</div>}
          {d.cancelReason && <div>Отмена: {d.cancelReason}</div>}
        </div>
      )}
      <dl className="card divide-y divide-line text-sm">
        {rows.map(([k, val]) => (
          <div key={k} className="flex justify-between gap-4 px-4 py-2.5">
            <dt className="text-muted">{k}</dt>
            <dd className="text-right font-medium">{val}</dd>
          </div>
        ))}
      </dl>

      {manage && d.status === "REVIEW" && (
        <div className="grid gap-4 md:grid-cols-2">
          <form action={dealReviewAction} className="card space-y-2 p-4">
            <input type="hidden" name="dealId" value={d.id} />
            <input type="hidden" name="decision" value="approve" />
            <p className="text-xs text-muted">Продавцу откроется срок передачи и уйдет письмо.</p>
            <button className="btn-primary w-full">Разрешить сделку</button>
          </form>
          <form action={dealReviewAction} className="card space-y-2 p-4">
            <input type="hidden" name="dealId" value={d.id} />
            <input type="hidden" name="decision" value="reject" />
            <input name="reason" required minLength={5} className="input" placeholder="Причина" />
            <button className="btn-ghost w-full">Отменить и вернуть деньги</button>
          </form>
        </div>
      )}
      {manage && d.status === "DISPUTE" && (
        <form action={resolveDisputeAction} className="card space-y-3 p-4">
          <input type="hidden" name="dealId" value={d.id} />
          <textarea name="note" required minLength={5} rows={2} className="input" placeholder="Решение и его основание (в журнал)" />
          <div className="flex flex-wrap gap-2">
            <button name="outcome" value="buyer" className="btn-ghost">В пользу покупателя: возврат</button>
            <button name="outcome" value="seller" className="btn-primary">В пользу продавца: продолжить сделку</button>
          </div>
        </form>
      )}

      {v.payouts.length > 0 && (
        <div className="card divide-y divide-line text-sm">
          {v.payouts.map((p) => (
            <div key={p.id} className="flex gap-4 px-4 py-2">
              <span className="text-xs text-muted">{fmtDate(p.createdAt)}</span>
              <span className="flex-1">{p.status} {p.error ?? ""}</span>
              <span>{formatKgs(p.amountMinor)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
