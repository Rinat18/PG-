import Link from "next/link";
import { requireAdminPage } from "@/lib/admin/page";
import { can } from "@/lib/admin/rbac";
import { dealStage, dealStatusLabel, DEAL_STATUSES, listActiveListingsAdmin, listDealsAdmin } from "@/lib/p2p/deals";
import { formatKgs } from "@/lib/format";
import { Flash, fmtDate, PageHead, Table, td } from "@/components/admin/ui";
import { blockListingAction } from "../actions";

export default async function AdminDeals({ searchParams }: { searchParams: Promise<{ status?: string; q?: string; tab?: string; ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const user = await requireAdminPage("deals.view", "/admin/deals");
  const lotsTab = sp.tab === "lots";
  const rows = lotsTab ? [] : await listDealsAdmin(user, { status: sp.status, q: sp.q });
  const lots = lotsTab ? await listActiveListingsAdmin(user) : [];
  const month = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const today = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  return (
    <>
      <PageHead title="Сделки P2P">
        {can(user, "deals.manage") && (
          <>
            <a href={`/admin/reports/export?kind=deals&from=${month}&to=${today}`} className="btn-ghost">CSV сделок за 30 дней</a>
            <a href={`/admin/reports/export?kind=payouts&from=${month}&to=${today}`} className="btn-ghost">CSV выплат</a>
          </>
        )}
      </PageHead>
      <Flash ok={sp.ok} error={sp.error} />
      <div className="flex flex-wrap gap-2 text-sm">
        {[
          ["", "Все"],
          ["REVIEW", "На проверке"],
          ["DISPUTE", "Споры"],
          ["AWAITING_TRANSFER", "Ожидают передачи"],
          ["PROTECTION", "Защита / выплата"],
        ].map(([v, label]) => (
          <Link key={v} href={v ? `/admin/deals?status=${v}` : "/admin/deals"} className={!lotsTab && (sp.status ?? "") === v ? "btn-primary py-1" : "btn-ghost py-1"}>{label}</Link>
        ))}
        <Link href="/admin/deals?tab=lots" className={lotsTab ? "btn-primary py-1" : "btn-ghost py-1"}>Лоты на витрине</Link>
      </div>

      {!lotsTab && (
        <>
          <form className="flex gap-2">
            {sp.status && DEAL_STATUSES.includes(sp.status) && <input type="hidden" name="status" value={sp.status} />}
            <input name="q" defaultValue={sp.q} className="input max-w-xs" placeholder="Номер заказа или предмет" />
            <button className="btn-ghost">Найти</button>
          </form>
          <Table head={["Заказ", "Предмет", "Продавец", "Цена", "Статус", "Создана", "Причина"]} empty={!rows.length}>
            {rows.map(({ deal: d, title, orderNumber, sellerName }) => (
              <tr key={d.id}>
                <td className={td}><Link href={`/admin/deals/${d.id}`} className="font-mono text-xs text-accent underline">{orderNumber}</Link></td>
                <td className={td}>{title}</td>
                <td className={td}>{sellerName ?? "—"}</td>
                <td className={td}>{formatKgs(d.priceMinor)}</td>
                <td className={td}><span className={["REVIEW", "DISPUTE"].includes(d.status) ? "text-bad" : d.status === "PAID_OUT" ? "text-ok" : ""}>{dealStage(d)}</span></td>
                <td className={`${td} text-xs`}>{fmtDate(d.createdAt)}</td>
                <td className={`${td} text-xs text-muted`}>{d.reviewReason ?? d.disputeReason ?? d.payoutError ?? d.cancelReason ?? ""}</td>
              </tr>
            ))}
          </Table>
          <p className="text-xs text-muted">Статусы: {Object.values(dealStatusLabel).join(" · ")}</p>
        </>
      )}

      {lotsTab && (
        <Table head={["Лот", "Продавец", "Цена", "Рынок", "Статус", ""]} empty={!lots.length}>
          {lots.map(({ listing: l, sellerName, sellerBlocked }) => (
            <tr key={l.id}>
              <td className={td}><Link href={`/lot/${l.id}`} className="text-accent underline">{l.title}</Link></td>
              <td className={td}>{sellerName}{sellerBlocked && <span className="ml-1 text-xs text-bad">заблокирован</span>}</td>
              <td className={td}>{formatKgs(l.priceMinor)}</td>
              <td className={`${td} text-xs`}>{l.marketPriceMinor ? formatKgs(l.marketPriceMinor) : "нет данных"}</td>
              <td className={`${td} text-xs`}>{l.status}{l.blockedReason ? `: ${l.blockedReason}` : ""}</td>
              <td className={td}>
                {l.status === "ACTIVE" && can(user, "deals.manage") && (
                  <form action={blockListingAction} className="flex gap-1">
                    <input type="hidden" name="listingId" value={l.id} />
                    <input name="reason" required minLength={5} className="input w-40 py-1" placeholder="Причина" />
                    <button className="btn-ghost py-1">Блок</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
