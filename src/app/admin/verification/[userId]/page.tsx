import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/admin/page";
import { getVerification } from "@/lib/p2p/seller";
import { Flash, fmtDate, PageHead } from "@/components/admin/ui";
import { reviewVerificationAction } from "../../actions";

export default async function AdminVerificationItem({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { userId } = await params;
  const sp = await searchParams;
  const user = await requireAdminPage("verification.manage", `/admin/verification/${userId}`);
  const v = await getVerification(user, userId);
  if (!v) notFound();

  const rows: [string, React.ReactNode][] = [
    ["ФИО", v.fullName],
    ["Дата рождения", `${v.birthDate} (${v.age} лет)`],
    ["Паспорт", v.passport],
    ["Телефон", v.phone],
    ["Реквизиты для выплат", v.payoutDetails],
    ["Steam", v.user.steamId ? <a className="text-accent underline" href={`https://steamcommunity.com/profiles/${v.user.steamId}`} target="_blank" rel="noopener noreferrer">{v.user.steamId}</a> : "—"],
    ["Email", v.user.email ?? "—"],
    ["Подана", fmtDate(v.submittedAt)],
  ];

  return (
    <>
      <Link href="/admin/verification" className="text-sm text-muted hover:text-text">← Верификация</Link>
      <PageHead title={`Заявка: ${v.user.displayName ?? v.fullName}`}>
        <span className="font-semibold">{v.status === "PENDING" ? "На проверке" : v.status === "APPROVED" ? "Одобрена" : "Отклонена"}</span>
      </PageHead>
      <Flash ok={sp.ok} error={sp.error} />
      {v.samePayoutUsers.length > 0 && (
        <div className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm">
          Те же реквизиты указаны у других продавцов:{" "}
          {v.samePayoutUsers.map((id) => (
            <Link key={id} href={`/admin/verification/${id}`} className="mr-2 text-accent underline">{id.slice(0, 8)}</Link>
          ))}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <dl className="card divide-y divide-line text-sm">
          {rows.map(([k, val]) => (
            <div key={k} className="flex justify-between gap-4 px-4 py-2.5">
              <dt className="text-muted">{k}</dt>
              <dd className="text-right font-medium">{val}</dd>
            </div>
          ))}
        </dl>
        <div className="grid grid-cols-2 gap-3">
          {(["passport", "selfie"] as const).map((kind) => (
            <a key={kind} href={`/admin/verification/${userId}/file/${kind}`} target="_blank" className="card block space-y-1 p-2 text-xs text-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/admin/verification/${userId}/file/${kind}`} alt={kind === "passport" ? "Паспорт" : "Селфи"} className="aspect-[4/3] w-full rounded object-contain" />
              {kind === "passport" ? "Фото паспорта" : "Селфи с паспортом"}
            </a>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted">
        Проверьте: ФИО и дата рождения совпадают с паспортом, лицо на селфи — с фото в паспорте, возраст 18+, владелец реквизитов — сам продавец.
      </p>
      {v.status === "PENDING" ? (
        <div className="grid gap-4 md:grid-cols-2">
          <form action={reviewVerificationAction} className="card space-y-2 p-4">
            <input type="hidden" name="userId" value={userId} />
            <input type="hidden" name="decision" value="approve" />
            <button className="btn-primary w-full">Одобрить</button>
          </form>
          <form action={reviewVerificationAction} className="card space-y-2 p-4">
            <input type="hidden" name="userId" value={userId} />
            <input type="hidden" name="decision" value="reject" />
            <input name="reason" required minLength={5} className="input" placeholder="Причина отказа (увидит продавец)" />
            <button className="btn-ghost w-full">Отклонить</button>
          </form>
        </div>
      ) : (
        <p className="card p-4 text-sm text-muted">
          Решение принято {fmtDate(v.verifiedAt)} {v.reviewedBy}. {v.rejectionReason && `Причина: ${v.rejectionReason}`}
        </p>
      )}
    </>
  );
}
