import { desc } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { emailOutbox } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const metadata = { title: "Тестовая почта", robots: { index: false } };

/**
 * Почтовый ящик для разработки: письма без SMTP (EMAIL_TRANSPORT=dev).
 * Недоступен при реальном провайдере оплаты или реальной отправке писем.
 */
export default async function DevMail() {
  if (env.PAYMENT_PROVIDER !== "mock" || env.EMAIL_TRANSPORT !== "dev") notFound();
  const rows = await db.select().from(emailOutbox).orderBy(desc(emailOutbox.createdAt)).limit(30);
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Тестовая почта</h1>
      <p className="text-sm text-muted">Режим разработки: письма никуда не отправляются, здесь последние 30.</p>
      {rows.length === 0 && <div className="card p-6 text-sm text-muted">Писем пока нет</div>}
      {rows.map((m) => (
        <details key={m.id} className="card p-4" open={m === rows[0]}>
          <summary className="cursor-pointer text-sm">
            <b>{m.subject}</b> → {m.to} <span className="text-muted">· {m.createdAt.toLocaleString("ru-RU", { timeZone: "Asia/Bishkek" })}</span>
          </summary>
          {m.encryptedHtml ? (
            <iframe
              title={m.subject}
              sandbox="allow-popups allow-top-navigation-by-user-activation"
              srcDoc={decrypt(m.encryptedHtml).replace("<head>", '<head><base target="_top">').replace("<html>", '<html><head><base target="_top"></head>')}
              className="mt-3 h-[480px] w-full rounded-lg bg-white"
            />
          ) : (
            <pre className="mt-3 whitespace-pre-wrap text-sm">{decrypt(m.encryptedBody)}</pre>
          )}
        </details>
      ))}
    </div>
  );
}
