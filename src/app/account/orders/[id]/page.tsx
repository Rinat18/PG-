import Link from "next/link";
import { notFound } from "next/navigation";
import { getUserOrder } from "@/lib/account";
import { requireUser } from "@/lib/auth/current";
import { formatKgs, orderStatusLabel } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Заказ", robots: { index: false } };

export default async function AccountOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser(`/account/orders/${id}`);
  const view = await getUserOrder(user.id, id);
  if (!view) notFound();
  const { order, items, keys } = view;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Link href="/account" className="text-sm text-muted hover:text-text">← Все заказы</Link>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-bold">Заказ {order.number}</h1>
        <span className="text-sm font-semibold">{orderStatusLabel[order.status]}</span>
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
        <div className="px-4 py-3 text-xs text-muted">
          Создан {order.createdAt.toLocaleString("ru-RU", { timeZone: "Asia/Bishkek" })}
          {order.paidAt && ` · оплачен ${order.paidAt.toLocaleString("ru-RU", { timeZone: "Asia/Bishkek" })}`}
        </div>
      </div>
      {keys.length > 0 && (
        <div className="card space-y-3 p-6">
          <h2 className="font-bold">Ключи</h2>
          {keys.map((k, i) => (
            <div key={i} className="space-y-1">
              <div className="text-xs text-muted">{k.title}</div>
              <code className="block select-all rounded-lg border border-line bg-bg px-3 py-2 font-mono text-base">{k.code}</code>
            </div>
          ))}
        </div>
      )}
      {order.status === "PENDING_PAYMENT" && (
        <Link href={`/order/${order.accessToken}`} className="btn-primary">Перейти к оплате</Link>
      )}
    </div>
  );
}
