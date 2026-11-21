import Link from "next/link";

export function Flash({ ok, error }: { ok?: string; error?: string }) {
  if (!ok && !error) return null;
  return (
    <div className={`rounded-lg border px-3 py-2 text-sm ${error ? "border-bad/40 bg-bad/10 text-bad" : "border-ok/40 bg-ok/10 text-ok"}`}>
      {error ?? ok}
    </div>
  );
}

export function PageHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-bold">{title}</h1>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

export function Stat({ label, value, href, tone }: { label: string; value: React.ReactNode; href?: string; tone?: "bad" | "ok" }) {
  const body = (
    <div className="card h-full space-y-1 p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-2xl font-black ${tone === "bad" ? "text-bad" : tone === "ok" ? "text-ok" : ""}`}>{value}</div>
    </div>
  );
  return href ? <Link href={href} className="hover:brightness-110">{body}</Link> : body;
}

export function Table({ head, children, empty }: { head: string[]; children: React.ReactNode; empty?: boolean }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line text-xs text-muted">
          <tr>{head.map((h) => <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
      {empty && <div className="p-6 text-center text-sm text-muted">Ничего не найдено</div>}
    </div>
  );
}

export const td = "px-3 py-2 align-top";

export const fmtDate = (d: Date | null | undefined) =>
  d ? d.toLocaleString("ru-RU", { timeZone: "Asia/Bishkek", dateStyle: "short", timeStyle: "short" }) : "—";
