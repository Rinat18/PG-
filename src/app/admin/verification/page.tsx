import Link from "next/link";
import { requireAdminPage } from "@/lib/admin/page";
import { listVerifications } from "@/lib/p2p/seller";
import { fmtDate, PageHead, Table, td } from "@/components/admin/ui";

const statusLabel: Record<string, string> = { PENDING: "На проверке", APPROVED: "Одобрена", REJECTED: "Отклонена", NOT_STARTED: "—" };

export default async function AdminVerification() {
  const user = await requireAdminPage("verification.manage", "/admin/verification");
  const rows = await listVerifications(user);
  return (
    <>
      <PageHead title="Верификация продавцов" />
      <p className="text-xs text-muted">Паспортные данные видит только комплаенс. Каждое открытие заявки записывается в журнал.</p>
      <Table head={["Продавец", "Steam ID", "Подана", "Статус", "Решение"]} empty={!rows.length}>
        {rows.map((r) => (
          <tr key={r.userId}>
            <td className={td}><Link href={`/admin/verification/${r.userId}`} className="text-accent underline">{r.displayName ?? r.email ?? r.userId.slice(0, 8)}</Link></td>
            <td className={`${td} font-mono text-xs`}>{r.steamId}</td>
            <td className={`${td} text-xs`}>{fmtDate(r.submittedAt)}</td>
            <td className={td}><span className={r.status === "PENDING" ? "text-accent" : r.status === "APPROVED" ? "text-ok" : "text-bad"}>{statusLabel[r.status]}</span></td>
            <td className={`${td} text-xs text-muted`}>{r.status === "REJECTED" ? r.rejectionReason : fmtDate(r.verifiedAt)}</td>
          </tr>
        ))}
      </Table>
    </>
  );
}
