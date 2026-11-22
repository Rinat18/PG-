import { cookies } from "next/headers";
import { getUserBySessionCookie, SESSION_COOKIE } from "@/lib/auth/session";
import { exportDealsCsv, exportOrdersCsv, exportPayoutsCsv, parsePeriod } from "@/lib/admin/reports";
import { can } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getUserBySessionCookie((await cookies()).get(SESSION_COOKIE)?.value);
  const sp = new URL(req.url).searchParams;
  const kind = sp.get("kind") === "deals" ? "deals" : sp.get("kind") === "payouts" ? "payouts" : "orders";
  if (!can(user, kind === "orders" ? "reports.view" : "deals.manage")) return new Response("Not found", { status: 404 });
  const period = parsePeriod(sp.get("from") ?? undefined, sp.get("to") ?? undefined);
  const csv = kind === "deals" ? await exportDealsCsv(user, period) : kind === "payouts" ? await exportPayoutsCsv(user, period) : await exportOrdersCsv(user, period);
  await writeAudit(`admin:${user!.id}`, "report.exported", "report", null, { kind, from: sp.get("from"), to: sp.get("to") });
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${kind}_${sp.get("from") ?? "from"}_${sp.get("to") ?? "to"}.csv"`,
    },
  });
}
