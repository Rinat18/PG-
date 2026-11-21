import { listAudit } from "@/lib/admin/reports";
import { requireAdminPage } from "@/lib/admin/page";
import { fmtDate, PageHead, Table, td } from "@/components/admin/ui";

export default async function AdminAudit() {
  const user = await requireAdminPage("audit.view", "/admin/audit");
  const rows = await listAudit(user);
  return (
    <>
      <PageHead title="Журнал действий" />
      <Table head={["Когда", "Кто", "Действие", "Объект", "Данные"]} empty={!rows.length}>
        {rows.map((a) => (
          <tr key={a.id}>
            <td className={`${td} whitespace-nowrap text-xs`}>{fmtDate(a.createdAt)}</td>
            <td className={`${td} text-xs`}>{a.actor}</td>
            <td className={td}>{a.action}</td>
            <td className={`${td} text-xs`}>{a.entity} {a.entityId?.slice(0, 8)}</td>
            <td className={`${td} max-w-md break-all font-mono text-xs text-muted`}>{JSON.stringify(a.data)}</td>
          </tr>
        ))}
      </Table>
    </>
  );
}
