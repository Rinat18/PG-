import Link from "next/link";
import { formatKgs, gameLabel, productTypeLabel } from "@/lib/format";
import type { SkinAttributes } from "@/db/schema";

export type ProductCardData = {
  slug: string;
  title: string;
  type: string;
  game: string;
  priceMinor: number;
  deliveryEta: string;
  stock: number | null;
  skin: SkinAttributes | null;
};

const tone: Record<string, string> = {
  CS2: "from-amber-500/30 via-orange-600/10",
  DOTA2: "from-red-600/30 via-rose-700/10",
  OTHER: "from-sky-500/30 via-indigo-600/10",
};

export function ProductArt({ game, type, big = false }: { game: string; type: string; big?: boolean }) {
  return (
    <div
      className={`relative grid place-items-center overflow-hidden rounded-lg bg-gradient-to-br ${tone[game] ?? tone.OTHER} to-panel-2 ${big ? "aspect-[4/3]" : "aspect-[16/10]"}`}
    >
      <span className={`font-black tracking-tight text-text/80 ${big ? "text-5xl" : "text-2xl"}`}>{gameLabel[game]}</span>
      <span className="absolute left-2 top-2 rounded bg-bg/70 px-2 py-0.5 text-[11px] text-muted">{productTypeLabel[type]}</span>
    </div>
  );
}

export function ProductCard({ p }: { p: ProductCardData }) {
  const out = p.stock === 0;
  return (
    <Link href={`/product/${p.slug}`} className="card group flex flex-col gap-3 p-3 transition hover:border-accent/60">
      <ProductArt game={p.game} type={p.type} />
      <div className="flex-1 space-y-1">
        <div className="line-clamp-2 text-sm font-semibold leading-snug group-hover:text-accent">{p.title}</div>
        {p.skin && (
          <div className="text-xs text-muted">
            {[p.skin.exterior, p.skin.float !== undefined ? `float ${p.skin.float.toFixed(4)}` : null, p.skin.statTrak ? "StatTrak™" : null]
              .filter(Boolean)
              .join(" · ")}
          </div>
        )}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="whitespace-nowrap text-lg font-bold">{formatKgs(p.priceMinor)}</div>
        <div className={`text-right text-xs ${out ? "text-bad" : "text-muted"}`}>{out ? "Нет в наличии" : p.deliveryEta}</div>
      </div>
    </Link>
  );
}

export function ProductGrid({ items }: { items: ProductCardData[] }) {
  if (!items.length) return <div className="card p-8 text-center text-muted">Ничего не найдено</div>;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
      {items.map((p) => (
        <ProductCard key={p.slug} p={p} />
      ))}
    </div>
  );
}
