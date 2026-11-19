import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { getOrderForBuyer } from "@/lib/orders/service";
import { formatKgs, orderStatusLabel } from "@/lib/format";
import { PaymentWaiter } from "./PaymentWaiter";

export const dynamic = "force-dynamic";
export const metadata = { title: "Заказ", robots: { index: false } };

const statusTone: Record<string, string> = {
  PENDING_PAYMENT: "text-accent",
  PAID: "text-ok",
  TRADE_SENT: "text-ok",
  DELIVERED: "text-ok",
  PROBLEM: "text-bad",
  REFUNDED: "text-muted",
  CANCELLED: "text-muted",
};

export default async function OrderPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await getOrderForBuyer(token);
  if (!view) notFound();
  const { order, payment, items, keys } = view;

  const qrDataUrl =
    order.status === "PENDING_PAYMENT" && payment
      ? await QRCode.toDataURL(payment.qrPayload, { margin: 1, width: 280, errorCorrectionLevel: "M" })
      : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-bold">Заказ {order.number}</h1>
        <span className={`text-sm font-semibold ${statusTone[order.status]}`}>{orderStatusLabel[order.status]}</span>
      </div>

      <div className="card divide-y divide-line text-sm">
        {items.map((i) => (
          <div key={i.id} className="flex justify-between px-4 py-3">
            <span>{i.titleSnapshot}</span>
            <span className="font-semibold">{formatKgs(i.priceMinor)}</span>
          </div>
        ))}
        <div className="flex justify-between px-4 py-3 font-bold">
          <span>Итого</span>
          <span>{formatKgs(order.totalMinor)}</span>
        </div>
      </div>

      {order.status === "PENDING_PAYMENT" && payment && qrDataUrl && (
        <div className="card space-y-5 p-6">
          <div className="flex items-center justify-between">
            <h2 className="font-bold">Оплата по QR</h2>
            <span className="rounded-md border border-line px-2 py-0.5 text-xs font-semibold">ELQR</span>
          </div>
          <div className="grid gap-6 sm:grid-cols-[auto_1fr] sm:items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrDataUrl} alt={`QR для оплаты заказа ${order.number}`} width={220} height={220} className="mx-auto rounded-lg bg-white p-2" />
            <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
              <li>Откройте приложение своего банка.</li>
              <li>Выберите оплату по QR и отсканируйте код.</li>
              <li>Проверьте сумму: <b className="text-text">{formatKgs(payment.amountMinor)}</b>, и подтвердите.</li>
              <li>Не закрывайте страницу: товар появится здесь автоматически.</li>
            </ol>
          </div>
          <div className="flex flex-wrap gap-2 sm:hidden">
            {payment.deeplinks.map((d) => (
              <a key={d.url} href={d.url} className="btn-ghost flex-1">Открыть {d.bank}</a>
            ))}
            <a href={qrDataUrl} download={`qr-${order.number}.png`} className="btn-ghost flex-1">Сохранить QR</a>
          </div>
          {process.env.PAYMENT_PROVIDER === "mock" && (
            <div className="rounded-lg border border-dashed border-accent/50 p-3 text-xs text-muted">
              Режим разработки: оплатить можно на{" "}
              <a className="text-accent underline" href={payment.deeplinks[0]?.url} target="_blank">странице тестового банка</a>.
            </div>
          )}
          <PaymentWaiter token={token} expiresAt={payment.expiresAt.toISOString()} />
        </div>
      )}

      {keys.length > 0 && (
        <div className="card space-y-3 p-6">
          <h2 className="font-bold">Ваши ключи</h2>
          {keys.map((k, i) => (
            <div key={i} className="space-y-1">
              <div className="text-xs text-muted">{k.title}</div>
              <code className="block select-all rounded-lg border border-line bg-bg px-3 py-2 font-mono text-base">{k.code}</code>
            </div>
          ))}
          <p className="text-xs text-muted">Копия отправлена на {order.email}. Ссылка на эту страницу — ваш доступ к заказу, не передавайте ее.</p>
        </div>
      )}

      {order.status === "PAID" && keys.length === 0 && (
        <Notice tone="ok">Оплата получена. Товар выдаст оператор, статус обновится на этой странице и придет на почту.</Notice>
      )}
      {order.status === "CANCELLED" && (
        <Notice>
          Заказ отменен: оплата не поступила за 15 минут. <Link href="/" className="text-accent underline">Вернуться в магазин</Link>
        </Notice>
      )}
      {order.status === "REFUNDED" && <Notice>Деньги по заказу возвращены на счет, с которого была оплата.</Notice>}
      {order.status === "PROBLEM" && (
        <Notice tone="bad">Не удалось выдать товар автоматически. Мы уже разбираемся; если товар не будет выдан, деньги вернутся полностью.</Notice>
      )}
    </div>
  );
}

function Notice({ children, tone }: { children: React.ReactNode; tone?: "ok" | "bad" }) {
  const cls = tone === "ok" ? "border-ok/40 bg-ok/10" : tone === "bad" ? "border-bad/40 bg-bad/10" : "border-line bg-panel";
  return <div className={`rounded-xl border p-4 text-sm ${cls}`}>{children}</div>;
}
