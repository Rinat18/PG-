import { notFound, redirect } from "next/navigation";
import { getProduct } from "@/lib/catalog";
import { formatKgs, productTypeLabel } from "@/lib/format";
import { CheckoutForm } from "./CheckoutForm";
import { getCurrentUser } from "@/lib/auth/current";

export const dynamic = "force-dynamic";
export const metadata = { title: "Оформление заказа" };

export default async function CheckoutPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const p = await getProduct(slug);
  if (!p) notFound();
  if (p.stock === 0 || p.isReserved) redirect(`/product/${slug}`);
  const user = await getCurrentUser();
  const isSkin = p.type === "SHOP_SKIN";
  // Скины — только со входом через Steam
  if (isSkin && !user?.steamId) redirect(`/api/auth/steam?next=${encodeURIComponent(`/checkout/${slug}`)}`);

  return (
    <div className="mx-auto grid max-w-3xl gap-6 md:grid-cols-[1fr_280px]">
      <div className="card space-y-4 p-6">
        <h1 className="text-xl font-bold">Оформление заказа</h1>
        <CheckoutForm
          slug={p.slug}
          needsTradeUrl={isSkin}
          defaultEmail={user?.email ?? undefined}
          defaultTradeUrl={user?.tradeUrl ?? undefined}
        />
        {isSkin && (
          <p className="text-xs text-muted">
            До оплаты проверим через Steam, что ссылка ваша, инвентарь открыт и нет трейд-бана. Если Steam задерживает обмены
            (trade hold), скин придет после окончания задержки.
          </p>
        )}
      </div>
      <aside className="card h-fit space-y-3 p-4 text-sm">
        <div className="text-xs text-muted">{productTypeLabel[p.type]}</div>
        <div className="font-semibold">{p.title}</div>
        <div className="text-muted">Выдача: {p.deliveryEta}</div>
        <div className="flex justify-between border-t border-line pt-3 text-base">
          <span>Итого</span>
          <span className="font-bold">{formatKgs(p.priceMinor)}</span>
        </div>
      </aside>
    </div>
  );
}
