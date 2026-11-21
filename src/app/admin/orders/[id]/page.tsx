import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrderAdmin } from "@/lib/admin/orders";
import { requireAdminPage } from "@/lib/admin/page";
import { can } from "@/lib/admin/rbac";
import { formatKgs, orderStatusLabel } from "@/lib/format";
import { Flash, fmtDate, PageHead, Table, td } from "@/components/admin/ui";
import { deliverOrderAction, refundOrderAction, retryRefundAction } from "../../actions";

export default async function AdminOrder({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireAdminPage("orders.view", `/admin/orders/${id}`);
  const v = await getOrderAdmin(user, id);
  if (!v) notFound();
  const { order, items, payment, refunds, webhooks, audit, offers } = v;
  const manual = items.every((i) => i.deliveryMethod === "MANUAL" || i.deliveryMethod === "STEAM_GIFT");
  const canDeliver = can(user, "orders.deliver") && manual && (order.status === "PAID" || order.status === "PROBLEM") && payment?.status === "SUCCEEDED";
  const activeRefund = refunds.find((r) => r.status !== "FAILED");
  const canRefund =
    can(user, "refunds.manage") && payment?.status === "SUCCEEDED" && !refunds.length && ["PAID", "TRADE_SENT", "DELIVERED", "PROBLEM"].includes(order.status);

  return (
    <>
      <Link href="/admin/orders" className="text-sm text-muted hover:text-text">← Заказы</Link>
      <PageHead title={`Заказ ${order.number}`}>
        <span className="font-semibold">{orderStatusLabel[order.status]}</span>
      </PageHead>
      <Flash ok={sp.ok} error={sp.error} />

      <div className="grid gap-4 md:grid-cols-2">
        <div className="card space-y-1 p-4 text-sm">
          <div><span className="text-muted">Email:</span> {order.email}</div>
          <div><span className="text-muted">Покупатель:</span> {order.userId ? <Link className="text-accent underline" href={`/admin/clients/${order.userId}`}>аккаунт</Link> : "гость"}</div>
          <div><span className="text-muted">Создан:</span> {fmtDate(order.createdAt)} · <span className="text-muted">оплачен:</span> {fmtDate(order.paidAt)}</div>
          <div><span className="text-muted">IP:</span> {order.clientIp ?? "—"}</div>
          {order.tradeUrl && <div className="break-all"><span className="text-muted">Trade-ссылка:</span> {order.tradeUrl} {order.tradeHoldDays ? `(hold ${order.tradeHoldDays} дн.)` : ""}</div>}
          {order.needsReview && <div className="text-bad">На проверке{order.problemReason ? `: ${order.problemReason}` : ""}</div>}
          {!order.needsReview && order.problemReason && <div className="text-muted">Причина: {order.problemReason}</div>}
        </div>
        <div className="card divide-y divide-line text-sm">
          {items.map((i) => (
            <div key={i.id} className="flex justify-between gap-3 px-4 py-2">
              <span>{i.titleSnapshot} <span className="text-xs text-muted">({i.deliveryMethod})</span></span>
              <span>{formatKgs(i.priceMinor)}</span>
            </div>
          ))}
          <div className="flex justify-between px-4 py-2 font-bold"><span>Итого</span><span>{formatKgs(order.totalMinor)}</span></div>
          {payment && <div className="px-4 py-2 text-xs text-muted">Платеж {payment.provider}/{payment.providerPaymentId}: {payment.status}</div>}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {canDeliver && (
          <form action={deliverOrderAction} className="card space-y-2 p-4">
            <div className="font-semibold">Ручная выдача</div>
            <input type="hidden" name="orderId" value={order.id} />
            <textarea name="note" rows={2} className="input" placeholder="Комментарий для покупателя (необязательно)" />
            <button className="btn-primary">Отметить выданным и отправить письмо</button>
          </form>
        )}
        {canRefund && (
          <form action={refundOrderAction} className="card space-y-2 p-4">
            <div className="font-semibold">Полный возврат {formatKgs(order.totalMinor)}</div>
            <input type="hidden" name="orderId" value={order.id} />
            <input name="reason" required minLength={3} className="input" placeholder="Причина возврата" />
            <button className="btn-ghost border-bad/50 text-bad">Вернуть деньги</button>
          </form>
        )}
        {activeRefund && <div className="card p-4 text-sm">Возврат: <b>{activeRefund.status}</b> {fmtDate(activeRefund.doneAt ?? activeRefund.createdAt)}</div>}
        {refunds.filter((r) => r.status === "FAILED").map((r) => (
          <form key={r.id} action={retryRefundAction} className="card space-y-2 p-4 text-sm">
            <div className="text-bad">Возврат не прошел (попыток: {r.attempts}): {r.error}</div>
            <input type="hidden" name="refundId" value={r.id} />
            <input type="hidden" name="back" value={`/admin/orders/${order.id}`} />
            {can(user, "refunds.manage") && <button className="btn-ghost">Повторить возврат</button>}
          </form>
        ))}
      </div>

      {offers.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-bold">Трейд-офферы</h2>
          <Table head={["Статус", "Попыток", "Steam ID оффера", "Ошибка", "Обновлен"]}>
            {offers.map((o) => (
              <tr key={o.id}><td className={td}>{o.status}</td><td className={td}>{o.attempts}</td><td className={td}>{o.steamOfferId ?? "—"}</td><td className={td}>{o.lastError ?? ""}</td><td className={td}>{fmtDate(o.updatedAt)}</td></tr>
            ))}
          </Table>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="font-bold">Журнал webhook</h2>
        <Table head={["Получен", "Подпись", "Результат", "Тело"]} empty={!webhooks.length}>
          {webhooks.map((w) => (
            <tr key={w.id}>
              <td className={`${td} whitespace-nowrap text-xs`}>{fmtDate(w.receivedAt)}</td>
              <td className={td}>{w.signatureValid ? <span className="text-ok">верна</span> : <span className="text-bad">неверна</span>}</td>
              <td className={td}>{w.result}</td>
              <td className={`${td} max-w-md break-all font-mono text-xs text-muted`}>{w.rawBody.slice(0, 300)}</td>
            </tr>
          ))}
        </Table>
      </section>

      <section className="space-y-2">
        <h2 className="font-bold">Аудит</h2>
        <Table head={["Когда", "Кто", "Действие", "Данные"]} empty={!audit.length}>
          {audit.map((a) => (
            <tr key={a.id}>
              <td className={`${td} whitespace-nowrap text-xs`}>{fmtDate(a.createdAt)}</td>
              <td className={`${td} text-xs`}>{a.actor}</td>
              <td className={td}>{a.action}</td>
              <td className={`${td} break-all font-mono text-xs text-muted`}>{JSON.stringify(a.data)}</td>
            </tr>
          ))}
        </Table>
      </section>
    </>
  );
}
