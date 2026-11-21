import Link from "next/link";
import { listSellerBalances } from "@/lib/admin/balances";
import { requireAdminPage } from "@/lib/admin/page";
import { formatKgs } from "@/lib/format";
import { PageHead, Stat, Table, td } from "@/components/admin/ui";

export default async function AdminBalances() {
  const user = await requireAdminPage("balances.view", "/admin/balances");
  const rows = await listSellerBalances(user);
  const total = rows.reduce((s, r) => s + r.balance, 0);
  const paid = rows.reduce((s, r) => s + r.paid_out, 0);
  return (
    <>
      <PageHead title="Балансы продавцов и выплаты" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Продавцов" value={rows.length} />
        <Stat label="Всего к выплате" value={formatKgs(total)} />
        <Stat label="Выплачено всего" value={formatKgs(paid)} tone="ok" />
      </div>
      <p className="text-xs text-muted">
        Чтобы изменить баланс или сделать выплату, откройте продавца. Пополнения баланса покупателями нет — это требование
        платежного провайдера (ТЗ, разделы 1 и 6).
      </p>
      <Table head={["Продавец", "Верификация", "Баланс", "Выплачено"]} empty={!rows.length}>
        {rows.map((r) => (
          <tr key={r.id}>
            <td className={td}><Link href={`/admin/clients/${r.id}`} className="text-accent underline">{r.display_name ?? r.email ?? r.id.slice(0, 8)}</Link></td>
            <td className={td}>{r.verification_status ?? "—"}</td>
            <td className={`${td} font-semibold`}>{formatKgs(r.balance)}</td>
            <td className={td}>{formatKgs(r.paid_out)}</td>
          </tr>
        ))}
      </Table>
    </>
  );
}
