import Link from "next/link";
import { listClients } from "@/lib/admin/clients";
import { requireAdminPage } from "@/lib/admin/page";
import { can, roleLabel } from "@/lib/admin/rbac";
import { formatKgs } from "@/lib/format";
import { fmtDate, PageHead, Table, td } from "@/components/admin/ui";

export default async function AdminClients({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const sp = await searchParams;
  const user = await requireAdminPage("clients.view", "/admin/clients");
  const rows = await listClients(user, sp.q);
  const showBalance = can(user, "balances.view");
  return (
    <>
      <PageHead title={`Клиенты (${rows.length}${rows.length === 300 ? "+" : ""})`} />
      <form className="flex gap-2"><input name="q" defaultValue={sp.q} placeholder="Email, имя или Steam ID" className="input w-72" /><button className="btn-ghost">Найти</button></form>
      <Table head={["Клиент", "Вход", "Роль", "Заказов", "Покупок на", ...(showBalance ? ["Баланс"] : []), "С нами с"]} empty={!rows.length}>
        {rows.map(({ user: u, ordersCount, paidSum, balance }) => (
          <tr key={u.id} className={u.isBlocked ? "opacity-50" : ""}>
            <td className={td}><Link href={`/admin/clients/${u.id}`} className="text-accent underline">{u.displayName ?? u.email ?? u.id.slice(0, 8)}</Link>{u.isBlocked && <span className="ml-1 text-xs text-bad">заблокирован</span>}</td>
            <td className={`${td} text-xs`}>{[u.steamId && "Steam", u.email && "email"].filter(Boolean).join(" + ")}</td>
            <td className={td}>{roleLabel[u.role]}</td>
            <td className={td}>{ordersCount}</td>
            <td className={`${td} whitespace-nowrap`}>{formatKgs(paidSum)}</td>
            {showBalance && <td className={`${td} whitespace-nowrap font-semibold`}>{balance ? formatKgs(balance) : "—"}</td>}
            <td className={`${td} text-xs`}>{fmtDate(u.createdAt)}</td>
          </tr>
        ))}
      </Table>
    </>
  );
}
