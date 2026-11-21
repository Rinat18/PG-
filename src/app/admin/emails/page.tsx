import { desc, isNotNull, isNull, and, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { emailOutbox } from "@/db/schema";
import { requireAdminPage } from "@/lib/admin/page";
import { Flash, fmtDate, PageHead, Table, td } from "@/components/admin/ui";
import Link from "next/link";
import { requeueEmailAction } from "../actions";

/** Очередь писем. Тело в админке не показывается: в нем бывают ключи активации. */
export default async function AdminEmails({ searchParams }: { searchParams: Promise<{ f?: string; ok?: string; error?: string }> }) {
  const sp = await searchParams;
  await requireAdminPage("emails.view", "/admin/emails");
  const where: Record<string, SQL | undefined> = {
    failed: isNotNull(emailOutbox.failedAt),
    pending: and(isNull(emailOutbox.sentAt), isNull(emailOutbox.failedAt)),
    sent: isNotNull(emailOutbox.sentAt),
  };
  const rows = await db
    .select({
      id: emailOutbox.id,
      to: emailOutbox.to,
      subject: emailOutbox.subject,
      template: emailOutbox.template,
      attempts: emailOutbox.attempts,
      lastError: emailOutbox.lastError,
      sentAt: emailOutbox.sentAt,
      failedAt: emailOutbox.failedAt,
      nextAttemptAt: emailOutbox.nextAttemptAt,
      createdAt: emailOutbox.createdAt,
    })
    .from(emailOutbox)
    .where(sp.f ? where[sp.f] : undefined)
    .orderBy(desc(emailOutbox.createdAt))
    .limit(200);
  return (
    <>
      <PageHead title="Письма">
        {[["", "Все"], ["pending", "В очереди"], ["failed", "Не отправлены"], ["sent", "Отправлены"]].map(([k, l]) => (
          <Link key={k} href={k ? `/admin/emails?f=${k}` : "/admin/emails"} className={`btn-ghost py-1 ${(sp.f ?? "") === k ? "border-accent" : ""}`}>{l}</Link>
        ))}
      </PageHead>
      <Flash ok={sp.ok} error={sp.error} />
      <Table head={["Создано", "Кому", "Тема", "Статус", "Попыток", ""]} empty={!rows.length}>
        {rows.map((m) => (
          <tr key={m.id}>
            <td className={`${td} whitespace-nowrap text-xs`}>{fmtDate(m.createdAt)}</td>
            <td className={td}>{m.to}</td>
            <td className={td}>{m.subject}<div className="text-xs text-muted">{m.template}</div></td>
            <td className={td}>
              {m.sentAt ? <span className="text-ok">отправлено {fmtDate(m.sentAt)}</span> : m.failedAt ? <span className="text-bad">не отправлено</span> : <span>в очереди{m.nextAttemptAt ? `, повтор ${fmtDate(m.nextAttemptAt)}` : ""}</span>}
              {m.lastError && !m.sentAt && <div className="text-xs text-bad">{m.lastError}</div>}
            </td>
            <td className={td}>{m.attempts}</td>
            <td className={td}>
              {m.failedAt && !m.sentAt && (
                <form action={requeueEmailAction}>
                  <input type="hidden" name="emailId" value={m.id} />
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
