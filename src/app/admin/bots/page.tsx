import Link from "next/link";
import { listBotsAdmin } from "@/lib/admin/orders";
import { requireAdminPage } from "@/lib/admin/page";
import { can } from "@/lib/admin/rbac";
import { gameLabel } from "@/lib/format";
import { Flash, fmtDate, PageHead, Table, td } from "@/components/admin/ui";
import { requeueTradeAction, setSkinPricesAction } from "../actions";

const offerLabel: Record<string, string> = {
  QUEUED: "в очереди",
  SENT: "отправлен",
  ACCEPTED: "принят",
  DECLINED: "отклонен",
  FAILED: "ошибка",
  ROLLED_BACK: "откачен",
  IN_ESCROW: "trade hold",
};

export default async function AdminBots({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const user = await requireAdminPage("bots.view", "/admin/bots");
  const { bots, offers, unpriced } = await listBotsAdmin(user);
  const stale = (d: Date | null) => !d || Date.now() - d.getTime() > 5 * 60_000;

  return (
    <>
      <PageHead title="Боты и трейды" />
      <Flash ok={sp.ok} error={sp.error} />
      <Table head={["Бот", "Steam ID", "Статус", "Последний сигнал", "Предметов", "Синхронизация", "Ошибка"]} empty={!bots.length}>
        {bots.map((b) => {
          const down = b.status !== "ONLINE" || stale(b.lastHeartbeatAt);
          return (
            <tr key={b.id}>
              <td className={td}>{b.name}</td>
              <td className={`${td} font-mono text-xs`}>{b.steamId}</td>
              <td className={td}><span className={down ? "text-bad" : "text-ok"}>{down && b.status === "ONLINE" ? "нет сигнала" : b.status}</span></td>
              <td className={`${td} text-xs`}>{fmtDate(b.lastHeartbeatAt)}</td>
              <td className={td}>{b.inventoryCount ?? "—"}</td>
              <td className={`${td} text-xs`}>{fmtDate(b.lastSyncAt)}</td>
              <td className={`${td} text-xs text-bad`}>{b.lastError}</td>
            </tr>
          );
        })}
      </Table>
      {!bots.length && <p className="text-xs text-muted">Ботов нет: запустите воркер (npm run worker). Без Steam — BOT_MODE=mock.</p>}

      {can(user, "products.manage") && unpriced.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-bold">Новые скины без цены ({unpriced.length})</h2>
          <p className="text-xs text-muted">Пришли из инвентаря ботов скрытыми. Кейсы, ключи и капсулы сюда не попадают — их отсекает фильтр.</p>
          <form action={setSkinPricesAction} className="space-y-2">
            <Table head={["Предмет", "Игра", "Качество", "Float", "Цена, сом", "Показать"]}>
              {unpriced.map((p) => (
                <tr key={p.id}>
                  <td className={td}>
                    <input type="hidden" name="id" value={p.id} />
                    <Link href={`/admin/products/${p.id}`} className="text-accent underline">{p.title}</Link>
                    {p.skin?.statTrak && <span className="ml-1 text-xs text-accent">StatTrak™</span>}
                  </td>
                  <td className={td}>{gameLabel[p.game]}</td>
                  <td className={td}>{p.skin?.exterior ?? "—"}</td>
                  <td className={`${td} font-mono text-xs`}>{p.skin?.float?.toFixed(6) ?? "—"}</td>
                  <td className={td}><input name={`price_${p.id}`} inputMode="decimal" className="input w-28 py-1" /></td>
                  <td className={td}><input type="checkbox" name={`show_${p.id}`} defaultChecked /></td>
                </tr>
              ))}
            </Table>
            <button className="btn-primary">Сохранить цены</button>
          </form>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="font-bold">Очередь трейд-офферов</h2>
        <Table head={["Заказ", "Предмет", "Статус", "Попыток", "Отправлен", "Ошибка", ""]} empty={!offers.length}>
          {offers.map(({ offer: o, orderId, number, title }) => (
            <tr key={o.id}>
              <td className={td}><Link href={`/admin/orders/${orderId}`} className="font-mono text-xs text-accent underline">{number}</Link></td>
              <td className={td}>{title}</td>
              <td className={td}><span className={["FAILED", "DECLINED"].includes(o.status) ? "text-bad" : o.status === "ACCEPTED" ? "text-ok" : ""}>{offerLabel[o.status]}</span></td>
              <td className={td}>{o.attempts}</td>
              <td className={`${td} text-xs`}>{fmtDate(o.sentAt)}</td>
              <td className={`${td} text-xs text-bad`}>{o.lastError}</td>
              <td className={td}>
                {["FAILED", "DECLINED"].includes(o.status) && can(user, "orders.deliver") && (
                  <form action={requeueTradeAction}>
                    <input type="hidden" name="offerId" value={o.id} />
                    <button className="btn-ghost py-1">Повторить</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </Table>
      </section>
    </>
  );
}
