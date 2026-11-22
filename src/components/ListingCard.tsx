import Link from "next/link";
import { formatKgs, gameLabel } from "@/lib/format";
import type { SkinAttributes } from "@/db/schema";

export type ListingCardData = {
  id: string;
  title: string;
  game: string;
  priceMinor: number;
  imageUrl: string | null;
  skin: SkinAttributes;
  sellerName: string | null;
};

/** Карточка P2P-лота: видно, что продает пользователь, а не магазин. */
export function ListingCard({ l }: { l: ListingCardData }) {
  return (
    <Link href={`/lot/${l.id}`} className="card group flex flex-col gap-3 p-3 transition hover:border-accent/60">
      <div className="relative grid aspect-[16/10] place-items-center overflow-hidden rounded-lg bg-panel-2">
        {l.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={l.imageUrl} alt="" className="h-full w-full object-contain p-2" loading="lazy" />
        ) : (
          <span className="text-2xl font-black text-text/80">{gameLabel[l.game]}</span>
        )}
        <span className="absolute left-2 top-2 rounded bg-bg/70 px-2 py-0.5 text-[11px] text-muted">Лот продавца</span>
      </div>
      <div className="flex-1 space-y-1">
        <div className="line-clamp-2 text-sm font-semibold leading-snug group-hover:text-accent">{l.title}</div>
        <div className="text-xs text-muted">
          {[l.skin.exterior, l.skin.float !== undefined ? `float ${l.skin.float.toFixed(4)}` : null, l.skin.statTrak ? "StatTrak™" : null]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="whitespace-nowrap text-lg font-bold">{formatKgs(l.priceMinor)}</div>
        <div className="truncate text-right text-xs text-muted">{l.sellerName ?? "Продавец"}</div>
      </div>
    </Link>
  );
}

export function ListingGrid({ items, empty = "Лотов пока нет" }: { items: ListingCardData[]; empty?: string }) {
  if (!items.length) return <div className="card p-8 text-center text-sm text-muted">{empty}</div>;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
      {items.map((l) => (
        <ListingCard key={l.id} l={l} />
      ))}
    </div>
  );
}
