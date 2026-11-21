import { and, asc, desc, eq, gte, ilike, isNull, lte, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";
import { expireStaleOrders } from "@/lib/orders/service";

export type CatalogFilters = {
  game?: "CS2" | "DOTA2" | "OTHER";
  type?: string;
  q?: string;
  priceFrom?: number; // сомы
  priceTo?: number;
  exterior?: string;
  statTrak?: boolean;
  sort?: "price_asc" | "price_desc" | "new" | "popular";
};

/** Количество доступных ключей по товару — для «нет в наличии = нельзя купить». */
// Имена колонок пишем явно: внутри подзапроса drizzle не квалифицирует колонку таблицей,
// и "id" молча резолвится в product_keys.id.
const stockExpr = sql<number>`(
  select count(*)::int from "product_keys" pk
  where pk."product_id" = "products"."id" and pk."status" = 'AVAILABLE'
)`;

const visible = and(
  eq(products.isActive, true),
  isNull(products.soldAt),
  // резерв снимает отмена заказа (крон / ленивая проверка), с учетом окна поздней оплаты
  isNull(products.reservedByOrderId),
);

export async function listProducts(f: CatalogFilters, limit = 48) {
  await expireStaleOrders(); // лениво снимаем просроченные резервы, даже если крон не настроен
  const where: (SQL | undefined)[] = [visible];
  if (f.game) where.push(eq(products.game, f.game));
  if (f.type) where.push(eq(products.type, f.type as typeof products.$inferSelect.type));
  if (f.q) where.push(ilike(products.title, `%${f.q.replace(/[%_]/g, "")}%`));
  if (f.priceFrom !== undefined) where.push(gte(products.priceMinor, f.priceFrom * 100));
  if (f.priceTo !== undefined) where.push(lte(products.priceMinor, f.priceTo * 100));
  if (f.exterior) where.push(sql`${products.skin}->>'exterior' = ${f.exterior}`);
  if (f.statTrak) where.push(sql`(${products.skin}->>'statTrak')::boolean = true`);

  const order =
    f.sort === "price_asc"
      ? asc(products.priceMinor)
      : f.sort === "price_desc"
        ? desc(products.priceMinor)
        : f.sort === "new"
          ? desc(products.createdAt)
          : desc(products.popularity);

  const rows = await db
    .select({ product: products, stock: stockExpr })
    .from(products)
    .where(and(...where))
    .orderBy(order)
    .limit(limit);
  return rows.map(({ product, stock }) => ({ ...product, stock: inStock(product, stock) }));
}

export async function getProduct(slug: string) {
  await expireStaleOrders();
  const [row] = await db
    .select({ product: products, stock: stockExpr })
    .from(products)
    .where(and(eq(products.slug, slug), eq(products.isActive, true)));
  if (!row) return null;
  return { ...row.product, stock: inStock(row.product, row.stock), isReserved: Boolean(row.product.reservedByOrderId) };
}

/** null = товар без складского учета (выдача оператором / подарком). */
function inStock(p: typeof products.$inferSelect, keyStock: number): number | null {
  if (p.deliveryMethod === "KEY") return keyStock;
  if (p.type === "SHOP_SKIN") return p.soldAt ? 0 : 1;
  return null;
}
