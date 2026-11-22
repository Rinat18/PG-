import { listProducts } from "@/lib/catalog";

/** id товаров, видимых в каталоге (всех игр). */
export async function getCatalogIds(): Promise<string[]> {
  const lists = await Promise.all((["CS2", "DOTA2", "OTHER"] as const).map((game) => listProducts({ game }, 500)));
  return lists.flat().map((p) => p.id);
}
