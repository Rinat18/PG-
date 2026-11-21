import Link from "next/link";
import { ORDER_STATUSES, searchOrders } from "@/lib/admin/orders";
import { requireAdminPage } from "@/lib/admin/page";
import { formatKgs, orderStatusLabel } from "@/lib/format";
import { fmtDate, PageHead, Table, td } from "@/components/admin/ui";

type SP = { q?: string; status?: string; review?: string; manual?: string };

export default async function AdminOrders({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await requireAdminPage("orders.view", "/admin/orders");
  const rows = await searchOrders(user, { q: sp.q, status: sp.status, review: sp.review === "1", manual: sp.manual === "1" });
  return (
    <>
      <PageHead title="Заказы" />
      <form className="flex flex-wrap items-center gap-2 text-sm">
        <input name="q" defaultValue={sp.q} placeholder="Номер или email" className="input w-56" />
        <select name="status" defaultValue={sp.status ?? ""} className="input w-44">
          <option value="">Все статусы</option>
          {ORDER_STATUSES.map((s) => <option key={s} value={s}>{orderStatusLabel[s]}</option>)}
        </select>
        <label className="flex items-center gap-1.5"><input type="checkbox" name="review" value="1" defaultChecked={sp.review === "1"} /> На проверке</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" name="manual" value="1" defaultChecked={sp.manual === "1"} /> Ждут ручной выдачи</label>
        <button className="btn-ghost">Найти</button>
      </form>
      <Table head={["Номер", "Создан", "Email", "Товары", "Сумма", "Статус"]} empty={!rows.length}>
        {rows.map((o) => (
          <tr key={o.id} className="hover:bg-panel-2">
            <td className={td}><Link href={`/admin/orders/${o.id}`} className="font-mono text-xs text-accent underline">{o.number}</Link></td>
            <td className={`${td} whitespace-nowrap text-xs text-muted`}>{fmtDate(o.createdAt)}</td>
            <td className={td}>{o.email}</td>
            <td className={td}>{o.titles.join(", ")}</td>
            <td className={`${td} whitespace-nowrap`}>{formatKgs(o.totalMinor)}</td>
            <td className={`${td} whitespace-nowrap`}>
              {orderStatusLabel[o.status]}
              {o.needsReview && <span className="ml-1 rounded bg-bad/20 px-1 text-xs text-bad">проверка</span>}
            </td>
          </tr>
        ))}
      </Table>
    </>
  );
}
