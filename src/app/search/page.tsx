import { ProductGrid } from "@/components/ProductCard";
import { listProducts } from "@/lib/catalog";

export const dynamic = "force-dynamic";
export const metadata = { title: "Поиск" };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = (await searchParams).q?.trim().slice(0, 80) ?? "";
  const items = q ? await listProducts({ q }) : [];
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{q ? `Поиск: «${q}»` : "Поиск"}</h1>
      <ProductGrid items={items} />
    </div>
  );
}
