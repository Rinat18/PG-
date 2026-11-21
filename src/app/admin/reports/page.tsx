import { parsePeriod, salesReport } from "@/lib/admin/reports";
import { requireAdminPage } from "@/lib/admin/page";
import { formatKgs, productTypeLabel } from "@/lib/format";
import { PageHead, Stat, Table, td } from "@/components/admin/ui";

const iso = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Bishkek" });

export default async function AdminReports({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const sp = await searchParams;
  const user = await requireAdminPage("reports.view", "/admin/reports");
  const period = parsePeriod(sp.from, sp.to);
  const r = await salesReport(user, period);
  const from = iso(period.from);
  const to = iso(new Date(period.to.getTime() - 1));
  return (
    <>
      <PageHead title="Отчеты">
        <a href={`/admin/reports/export?from=${from}&to=${to}`} className="btn-ghost">Выгрузить CSV</a>
      </PageHead>
      <form className="flex flex-wrap items-center gap-2 text-sm">
        <input type="date" name="from" defaultValue={from} className="input w-44" /> —
        <input type="date" name="to" defaultValue={to} className="input w-44" />
        <button className="btn-ghost">Показать</button>
      </form>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Оплаченных заказов" value={r.totals.orders} />
        <Stat label="Продажи" value={formatKgs(r.totals.revenue)} />
        <Stat label={`Возвраты (${r.totals.refunds})`} value={formatKgs(r.totals.refundedMinor)} tone={r.totals.refunds ? "bad" : undefined} />
        <Stat label="Итого за вычетом возвратов" value={formatKgs(r.totals.net)} tone="ok" />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Table head={["День", "Заказов", "Сумма"]} empty={!r.days.length}>
          {r.days.map((d) => <tr key={d.day}><td className={td}>{d.day}</td><td className={td}>{d.orders}</td><td className={td}>{formatKgs(d.revenue)}</td></tr>)}
        </Table>
        <Table head={["Тип товара", "Позиций", "Сумма"]} empty={!r.byType.length}>
          {r.byType.map((t) => <tr key={t.type}><td className={td}>{productTypeLabel[t.type] ?? t.type}</td><td className={td}>{t.items}</td><td className={td}>{formatKgs(t.revenue)}</td></tr>)}
        </Table>
      </div>
    </>
  );
}
