import Link from "next/link";
import { notFound } from "next/navigation";
import { getClient } from "@/lib/admin/clients";
import { getSellerLedger } from "@/lib/admin/balances";
import { requireAdminPage } from "@/lib/admin/page";
import { can, roleLabel } from "@/lib/admin/rbac";
import { formatKgs, orderStatusLabel } from "@/lib/format";
import { Flash, fmtDate, PageHead, Table, td } from "@/components/admin/ui";
import { adjustBalanceAction, payoutAction, setBlockedAction, setRoleAction } from "../../actions";

const kindLabel: Record<string, string> = {
  DEAL_EARNING: "Заработок по сделке",
  ADJUSTMENT: "Корректировка",
  PAYOUT: "Выплата",
  PAYOUT_REVERSAL: "Возврат неудачной выплаты",
};

export default async function AdminClient({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await requireAdminPage("clients.view", `/admin/clients/${id}`);
  const c = await getClient(actor, id);
  if (!c) notFound();
  const ledger = can(actor, "balances.view") ? await getSellerLedger(actor, id) : null;
  const u = c.user;

  return (
    <>
      <Link href="/admin/clients" className="text-sm text-muted hover:text-text">← Клиенты</Link>
      <PageHead title={u.displayName ?? u.email ?? "Клиент"}>
        <span className="text-sm text-muted">{roleLabel[u.role]}{u.isBlocked ? " · заблокирован" : ""}</span>
      </PageHead>
      <Flash ok={sp.ok} error={sp.error} />

      <div className="grid gap-4 md:grid-cols-2">
        <div className="card space-y-1 p-4 text-sm">
          <div><span className="text-muted">Email:</span> {u.email ?? "—"} {u.emailVerifiedAt ? "(подтвержден)" : ""}</div>
          <div><span className="text-muted">Steam ID:</span> {u.steamId ?? "—"}</div>
          <div className="break-all"><span className="text-muted">Trade-ссылка:</span> {u.tradeUrl ?? "—"}</div>
          <div><span className="text-muted">Регистрация:</span> {fmtDate(u.createdAt)}</div>
          {c.seller && <div><span className="text-muted">Продавец, верификация:</span> {c.seller.verificationStatus}</div>}
        </div>
        {can(actor, "users.roles") && actor.id !== u.id && (
          <div className="card space-y-3 p-4 text-sm">
            <form action={setRoleAction} className="flex gap-2">
              <input type="hidden" name="userId" value={u.id} />
              <select name="role" defaultValue={u.role} className="input">
                {(["BUYER", "SUPPORT", "COMPLIANCE", "ADMIN"] as const).map((r) => <option key={r} value={r}>{roleLabel[r]}</option>)}
              </select>
              <button className="btn-ghost">Сменить роль</button>
            </form>
            <form action={setBlockedAction}>
              <input type="hidden" name="userId" value={u.id} />
              <input type="hidden" name="blocked" value={u.isBlocked ? "0" : "1"} />
              <button className="btn-ghost">{u.isBlocked ? "Разблокировать" : "Заблокировать"}</button>
            </form>
          </div>
        )}
      </div>

      {c.pii && (
        <section className="card space-y-1 border-accent/40 p-4 text-sm">
          <div className="font-semibold">Данные верификации (видит только комплаенс)</div>
          <div>ФИО: {c.pii.fullName ?? "—"} · дата рождения: {c.pii.birthDate ?? "—"}</div>
          <div>Паспорт: {c.pii.passport ?? "—"} · телефон: {c.seller?.phone ?? "—"}</div>
          <div>Реквизиты выплат: {c.pii.payoutDetails ?? "—"}</div>
        </section>
      )}

      {ledger && (
        <section className="space-y-3">
          <h2 className="font-bold">Баланс продавца: {formatKgs(ledger.balance)}</h2>
          <p className="text-xs text-muted">
            Баланс копится из сделок P2P за вычетом комиссии и выплачивается на реквизиты продавца. Пополнить его деньгами нельзя;
            корректировка — только исправление учета с причиной, она попадает в журнал.
          </p>
          {can(actor, "balances.manage") && (
            <div className="grid gap-4 md:grid-cols-2">
              <form action={adjustBalanceAction} className="card space-y-2 p-4 text-sm">
                <div className="font-semibold">Корректировка</div>
                <input type="hidden" name="userId" value={u.id} />
                <div className="flex gap-2">
                  <select name="direction" className="input w-36"><option value="plus">Увеличить</option><option value="minus">Уменьшить</option></select>
                  <input name="amount" required inputMode="decimal" placeholder="Сумма, сом" className="input" />
                </div>
                <input name="reason" required minLength={5} placeholder="Причина (обязательно)" className="input" />
                <button className="btn-ghost">Применить</button>
              </form>
              {can(actor, "payouts.manage") && (
                <form action={payoutAction} className="card space-y-2 p-4 text-sm">
                  <div className="font-semibold">Выплата на реквизиты</div>
                  <input type="hidden" name="userId" value={u.id} />
                  <input name="amount" required inputMode="decimal" placeholder={`До ${formatKgs(ledger.balance)}`} className="input" />
                  <p className="text-xs text-muted">
                    {c.seller?.verificationStatus === "APPROVED" && c.seller.hasPayoutDetails
                      ? "Выплата уйдет на реквизиты, указанные при верификации."
                      : "Недоступно: продавец не верифицирован или нет реквизитов."}
                  </p>
                  <button className="btn-primary" disabled={!(c.seller?.verificationStatus === "APPROVED" && c.seller.hasPayoutDetails) || ledger.balance <= 0}>
                    Выплатить
                  </button>
                </form>
              )}
            </div>
          )}
          <Table head={["Когда", "Операция", "Сумма", "Причина", "Кто"]} empty={!ledger.entries.length}>
            {ledger.entries.map((e) => (
              <tr key={e.id}>
                <td className={`${td} whitespace-nowrap text-xs`}>{fmtDate(e.createdAt)}</td>
                <td className={td}>{kindLabel[e.kind]}</td>
                <td className={`${td} whitespace-nowrap font-semibold ${e.amountMinor < 0 ? "text-bad" : "text-ok"}`}>{e.amountMinor > 0 ? "+" : ""}{formatKgs(e.amountMinor)}</td>
                <td className={td}>{e.reason}</td>
                <td className={`${td} text-xs text-muted`}>{e.actor}</td>
              </tr>
            ))}
          </Table>
          {ledger.payouts.length > 0 && (
            <Table head={["Выплата", "Сумма", "Статус", "Отправлена", "Ошибка"]}>
              {ledger.payouts.map((p) => (
                <tr key={p.id}>
                  <td className={`${td} text-xs`}>{fmtDate(p.createdAt)}</td>
                  <td className={td}>{formatKgs(p.amountMinor)}</td>
                  <td className={td}>{p.status}</td>
                  <td className={`${td} text-xs`}>{fmtDate(p.sentAt)}</td>
                  <td className={`${td} text-xs text-bad`}>{p.error}</td>
                </tr>
              ))}
            </Table>
          )}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="font-bold">Заказы ({c.orders.length})</h2>
        <Table head={["Номер", "Создан", "Сумма", "Статус"]} empty={!c.orders.length}>
          {c.orders.map((o) => (
            <tr key={o.id}>
              <td className={td}><Link href={`/admin/orders/${o.id}`} className="font-mono text-xs text-accent underline">{o.number}</Link></td>
              <td className={`${td} text-xs`}>{fmtDate(o.createdAt)}</td>
              <td className={td}>{formatKgs(o.totalMinor)}</td>
              <td className={td}>{orderStatusLabel[o.status]}</td>
            </tr>
          ))}
        </Table>
      </section>
    </>
  );
}
