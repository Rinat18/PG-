import Link from "next/link";
import { listRefunds } from "@/lib/admin/orders";
import { requireAdminPage } from "@/lib/admin/page";
import { formatKgs } from "@/lib/format";
import { Flash, fmtDate, PageHead, Table, td } from "@/components/admin/ui";
import { retryRefundAction } from "../actions";

export default async function AdminRefunds({ searchParams }: { searchParams: Promise<{ status?: string; ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const user = await requireAdminPage("refunds.manage", "/admin/refunds");
  const rows = await listRefunds(user, sp.status);
  return (
    <>
      <PageHead title="Возвраты">
        {["", "FAILED", "DONE", "PENDING"].map((s) => (
          <Link key={s} href={s ? `/admin/refunds?status=${s}` : "/admin/refunds"} className={`btn-ghost py-1 ${sp.status === s || (!sp.status && !s) ? "border-accent" : ""}`}>
            {s || "Все"}
          </Link>
        ))}
      </PageHead>
      <Flash ok={sp.ok} error={sp.error} />
      <Table head={["Заказ", "Создан", "Сумма", "Причина", "Статус", ""]} empty={!rows.length}>
        {rows.map(({ refund: r, orderId, number }) => (
          <tr key={r.id}>
            <td className={td}><Link href={`/admin/orders/${orderId}`} className="font-mono text-xs text-accent underline">{number}</Link></td>
            <td className={`${td} text-xs`}>{fmtDate(r.createdAt)}</td>
            <td className={td}>{formatKgs(r.amountMinor)}</td>
            <td className={td}>{r.reason}</td>
            <td className={td}>{r.status}{r.error && <div className="text-xs text-bad">{r.error}</div>}</td>
            <td className={td}>
              {r.status === "FAILED" && (
                <form action={retryRefundAction}>
                  <input type="hidden" name="refundId" value={r.id} />
                  <input type="hidden" name="back" value={`/admin/refunds${sp.status ? `?status=${sp.status}` : ""}`} />
                  <button className="btn-ghost py-1">Повторить</button>
                </form>
              )}
            </td>
          </tr>
        ))}
      </Table>
    </>
  );
}
