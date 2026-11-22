import { notFound, redirect } from "next/navigation";
import { getListingPublic } from "@/lib/p2p/seller";
import { getCurrentUser } from "@/lib/auth/current";
import { formatKgs } from "@/lib/format";
import { CheckoutForm } from "../../[slug]/CheckoutForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Оформление заказа" };

export default async function LotCheckout({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const v = await getListingPublic(id);
  if (!v) notFound();
  if (!v.available) redirect(`/lot/${id}`);
  const user = await getCurrentUser();
  if (!user?.steamId) redirect(`/api/auth/steam?next=${encodeURIComponent(`/checkout/lot/${id}`)}`);
  if (user.id === v.seller.id) redirect(`/lot/${id}`);

  return (
    <div className="mx-auto grid max-w-3xl gap-6 md:grid-cols-[1fr_280px]">
      <div className="card space-y-4 p-6">
        <h1 className="text-xl font-bold">Оформление заказа</h1>
        <CheckoutForm slug="" listingId={id} needsTradeUrl defaultEmail={user.email ?? undefined} defaultTradeUrl={user.tradeUrl ?? undefined} />
        <p className="text-xs text-muted">
          До оплаты проверим через Steam, что ссылка ваша, инвентарь открыт и нет трейд-бана. Держите инвентарь открытым до
          получения скина: по нему сайт проверяет передачу.
        </p>
      </div>
      <aside className="card h-fit space-y-3 p-4 text-sm">
        <div className="text-xs text-muted">Лот продавца</div>
        <div className="font-semibold">{v.listing.title}</div>
        <div className="text-muted">Передача: до {v.transferHours} ч после оплаты</div>
        <div className="flex justify-between border-t border-line pt-3 text-base">
          <span>Итого</span>
          <span className="font-bold">{formatKgs(v.listing.priceMinor)}</span>
        </div>
      </aside>
    </div>
  );
}
