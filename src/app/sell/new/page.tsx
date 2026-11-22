import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/current";
import { listSellableInventory, SellerError } from "@/lib/p2p/seller";
import { getSettings } from "@/lib/settings";
import { Flash } from "@/components/admin/ui";
import { createListingAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Выставить скин", robots: { index: false } };

export default async function NewListing({ searchParams }: { searchParams: Promise<{ game?: string; ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const user = await requireUser("/sell/new");
  if (!user.steamId) redirect("/sell");
  const game = sp.game === "DOTA2" ? "DOTA2" : "CS2";
  const cfg = await getSettings();

  let data: Awaited<ReturnType<typeof listSellableInventory>> | null = null;
  let loadError: string | null = null;
  try {
    data = await listSellableInventory(user, game);
  } catch (e) {
    if (e instanceof SellerError) loadError = e.message;
    else throw e;
  }

  return (
    <div className="space-y-6">
      <Link href="/sell" className="text-sm text-muted hover:text-text">← Кабинет продавца</Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Выставить скин {game === "CS2" ? "CS2" : "Dota 2"}</h1>
        <div className="flex gap-2 text-sm">
          <Link href="/sell/new?game=CS2" className={game === "CS2" ? "btn-primary" : "btn-ghost"}>CS2</Link>
          <Link href="/sell/new?game=DOTA2" className={game === "DOTA2" ? "btn-primary" : "btn-ghost"}>Dota 2</Link>
        </div>
      </div>
      <Flash ok={sp.ok} error={sp.error ?? loadError ?? undefined} />
      <p className="text-sm text-muted">
        Цена фиксированная, в сомах. Комиссия площадки {cfg.p2pCommissionPercent}%. Если цена отличается от рыночной больше чем на{" "}
        {cfg.p2pMaxPriceDeviationPercent}%, покупка пройдет ручную проверку. После оплаты у вас будет {cfg.p2pTransferHours} ч, чтобы
        передать скин трейд-оффером.
      </p>
      {data && (
        <>
          {(data.hidden.containers > 0 || data.hidden.untradable > 0) && (
            <p className="text-xs text-muted">
              Скрыто: {data.hidden.containers} кейсов, ключей и капсул (их продавать нельзя), {data.hidden.untradable} непередаваемых предметов.
            </p>
          )}
          {data.items.length === 0 ? (
            <div className="card p-8 text-center text-sm text-muted">В инвентаре нет предметов, которые можно выставить.</div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {data.items.map((i) => (
                <form key={i.assetId} action={createListingAction} className="card flex flex-col gap-3 p-3">
                  <input type="hidden" name="game" value={game} />
                  <input type="hidden" name="assetId" value={i.assetId} />
                  <div className="flex gap-3">
                    <div className="grid h-16 w-20 shrink-0 place-items-center overflow-hidden rounded bg-panel-2">
                      {i.imageUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={i.imageUrl} alt="" className="h-full w-full object-contain" loading="lazy" />
                      )}
                    </div>
                    <div className="min-w-0 text-sm">
                      <div className="font-semibold leading-snug">{i.title}</div>
                      <div className="text-xs text-muted">{[i.exterior, i.statTrak ? "StatTrak™" : null].filter(Boolean).join(" · ")}</div>
                    </div>
                  </div>
                  {i.listed ? (
                    <div className="text-xs text-ok">Уже на витрине</div>
                  ) : (
                    <>
                      <div className="flex gap-2">
                        <input name="price" inputMode="numeric" required placeholder="Цена, сом" className="input flex-1 py-1.5" />
                        <button className="btn-primary py-1.5">Выставить</button>
                      </div>
                      <label className="flex items-center gap-2 text-xs text-muted">
                        <input type="checkbox" name="sellerOffer" required /> Принимаю <Link href="/info/seller-rules" className="underline">оферту для продавцов</Link>
                      </label>
                    </>
                  )}
                </form>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
