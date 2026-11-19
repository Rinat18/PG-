import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { mockProviderPayments } from "@/db/schema";
import { formatKgs } from "@/lib/format";
import { getMockProvider } from "@/lib/payments";

export const dynamic = "force-dynamic";
export const metadata = { title: "Тестовый банк", robots: { index: false } };

/** Имитация приложения банка. Доступна только при PAYMENT_PROVIDER=mock. */
export default async function MockBankPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string }> }) {
  if (process.env.PAYMENT_PROVIDER !== "mock") notFound();
  const { id } = await params;
  const { done } = await searchParams;
  const [p] = await db.select().from(mockProviderPayments).where(eq(mockProviderPayments.id, id));
  if (!p) notFound();

  async function pay(formData: FormData) {
    "use server";
    const outcome = formData.get("outcome") === "fail" ? "FAILED" : "SUCCEEDED";
    const res = await getMockProvider().simulateBankAction(id, outcome);
    redirect(`/dev/mock-bank/${id}?done=${encodeURIComponent(`${res.status} ${res.text}`)}`);
  }

  return (
    <div className="mx-auto max-w-sm space-y-4">
      <div className="card space-y-4 p-6">
        <div className="text-xs uppercase tracking-wide text-muted">Тестовый банк · ELQR</div>
        <div className="text-3xl font-black">{formatKgs(p.amountMinor)}</div>
        <div className="text-sm text-muted">Платеж {p.id}</div>
        <div className="text-sm">Статус: <b>{p.status}</b></div>
        {p.status === "PENDING" ? (
          <form action={pay} className="grid grid-cols-2 gap-2">
            <button name="outcome" value="ok" className="btn-primary">Оплатить</button>
            <button name="outcome" value="fail" className="btn-ghost">Отклонить</button>
          </form>
        ) : (
          <p className="text-sm text-muted">Вернитесь на страницу заказа — она обновится сама.</p>
        )}
        {done && <pre className="whitespace-pre-wrap rounded bg-bg p-2 text-xs text-muted">webhook → {done}</pre>}
      </div>
    </div>
  );
}
