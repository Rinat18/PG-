import { cookies } from "next/headers";
import { getUserBySessionCookie, SESSION_COOKIE } from "@/lib/auth/session";
import { exportOrdersCsv, parsePeriod } from "@/lib/admin/reports";
import { can } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getUserBySessionCookie((await cookies()).get(SESSION_COOKIE)?.value);
  if (!can(user, "reports.view")) return new Response("Not found", { status: 404 });
  const sp = new URL(req.url).searchParams;
  const period = parsePeriod(sp.get("from") ?? undefined, sp.get("to") ?? undefined);
  const csv = await exportOrdersCsv(user, period);
  await writeAudit(`admin:${user!.id}`, "report.exported", "report", null, { from: sp.get("from"), to: sp.get("to") });
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="orders_${sp.get("from") ?? "from"}_${sp.get("to") ?? "to"}.csv"`,
    },
  });
}
