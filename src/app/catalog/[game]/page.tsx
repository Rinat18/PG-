import { notFound } from "next/navigation";
import { ProductGrid } from "@/components/ProductCard";
import { listProducts, type CatalogFilters } from "@/lib/catalog";

export const dynamic = "force-dynamic";

const games = {
  cs2: { code: "CS2", title: "CS2", types: ["GAME_KEY", "CS2_PRIME", "SHOP_SKIN"] },
  dota2: { code: "DOTA2", title: "Dota 2", types: ["DOTA_PLUS", "SHOP_SKIN"] },
  other: { code: "OTHER", title: "Ключи игр и DLC", types: ["GAME_KEY"] },
} as const;

const typeNames: Record<string, string> = {
  GAME_KEY: "Ключи",
  CS2_PRIME: "Prime",
  DOTA_PLUS: "Dota Plus",
  SHOP_SKIN: "Скины",
};

const exteriors = ["Factory New", "Minimal Wear", "Field-Tested", "Well-Worn", "Battle-Scarred"];

type SP = Record<string, string | undefined>;

export async function generateMetadata({ params }: { params: Promise<{ game: string }> }) {
  const g = games[(await params).game as keyof typeof games];
  return { title: g ? `Каталог ${g.title}` : "Каталог" };
}

export default async function CatalogPage({ params, searchParams }: { params: Promise<{ game: string }>; searchParams: Promise<SP> }) {
  const { game } = await params;
  const sp = await searchParams;
  const g = games[game as keyof typeof games];
  if (!g) notFound();

  const num = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  const filters: CatalogFilters = {
    game: g.code,
    type: g.types.includes(sp.type as never) ? sp.type : undefined,
    q: sp.q?.slice(0, 80) || undefined,
    priceFrom: num(sp.from),
    priceTo: num(sp.to),
    exterior: exteriors.includes(sp.exterior ?? "") ? sp.exterior : undefined,
    statTrak: sp.st === "1" || undefined,
    sort: (["price_asc", "price_desc", "new", "popular"] as const).find((s) => s === sp.sort) ?? "popular",
  };
  const items = await listProducts(filters);
  const showSkinFilters = g.code === "CS2" && (!filters.type || filters.type === "SHOP_SKIN");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{g.title}</h1>
      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        <form className="card h-fit space-y-4 p-4 text-sm">
          <Field label="Тип товара">
            <select name="type" defaultValue={filters.type ?? ""} className="input">
              <option value="">Все</option>
              {g.types.map((t) => (
                <option key={t} value={t}>{typeNames[t]}</option>
              ))}
            </select>
          </Field>
          <Field label="Название">
            <input name="q" defaultValue={filters.q} className="input" placeholder="Например, AK-47" />
          </Field>
          <Field label="Цена, сом">
            <div className="flex gap-2">
              <input name="from" inputMode="numeric" defaultValue={sp.from} placeholder="от" className="input" />
              <input name="to" inputMode="numeric" defaultValue={sp.to} placeholder="до" className="input" />
            </div>
          </Field>
          {showSkinFilters && (
            <>
              <Field label="Качество">
                <select name="exterior" defaultValue={filters.exterior ?? ""} className="input">
                  <option value="">Любое</option>
                  {exteriors.map((e) => (
                    <option key={e}>{e}</option>
                  ))}
                </select>
              </Field>
              <label className="flex items-center gap-2">
                <input type="checkbox" name="st" value="1" defaultChecked={filters.statTrak} /> Только StatTrak™
              </label>
            </>
          )}
          <Field label="Сортировка">
            <select name="sort" defaultValue={filters.sort} className="input">
              <option value="popular">Популярные</option>
              <option value="new">Новые</option>
              <option value="price_asc">Сначала дешевле</option>
              <option value="price_desc">Сначала дороже</option>
            </select>
          </Field>
          <button className="btn-primary w-full">Показать</button>
        </form>
        <ProductGrid items={items} />
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}
