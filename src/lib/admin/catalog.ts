import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { productKeys, products } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { encrypt, sha256 } from "@/lib/crypto";
import { writeAudit } from "@/lib/audit";
import { AdminActionError } from "./orders";
import { actorOf, assertCan } from "./rbac";

const stock = (status: string) => sql<number>`(
  select count(*)::int from "product_keys" pk where pk."product_id" = "products"."id" and pk."status" = ${status}
)`;

export async function listProductsAdmin(actor: SessionUser | null) {
  assertCan(actor, "products.manage");
  return db
    .select({ product: products, available: stock("AVAILABLE"), issued: stock("ISSUED"), reserved: stock("RESERVED") })
    .from(products)
    .orderBy(products.game, products.type, desc(products.createdAt))
    .limit(500);
}

export async function getProductAdmin(actor: SessionUser | null, id: string) {
  assertCan(actor, "products.manage");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db
    .select({ product: products, available: stock("AVAILABLE"), issued: stock("ISSUED"), reserved: stock("RESERVED"), disabled: stock("DISABLED") })
    .from(products)
    .where(eq(products.id, id));
  return row ?? null;
}

const som = z.coerce
  .number({ message: "Цена — число в сомах" })
  .positive("Цена должна быть больше нуля")
  .max(10_000_000)
  .transform((v) => Math.round(v * 100));

export const productInput = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,80}$/, "Адрес: латиница, цифры и дефис"),
  type: z.enum(["GAME_KEY", "CS2_PRIME", "DOTA_PLUS", "SHOP_SKIN"]),
  game: z.enum(["CS2", "DOTA2", "OTHER"]),
  title: z.string().trim().min(2, "Название обязательно").max(200),
  description: z.string().trim().max(5000).default(""),
  activationInstructions: z.string().trim().max(5000).default(""),
  region: z.string().trim().max(100).optional().transform((v) => v || null),
  durationMonths: z.coerce.number().int().min(0).max(36).optional().transform((v) => v || null),
  deliveryMethod: z.enum(["KEY", "STEAM_GIFT", "TRADE_OFFER", "MANUAL"]),
  deliveryEta: z.string().trim().min(1, "Укажите срок выдачи").max(100),
  priceSom: som,
  imageUrl: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => v || null)
    .refine((v) => !v || /^https:\/\//.test(v), "Ссылка на фото должна начинаться с https://"),
  isActive: z.boolean(),
});
export type ProductInput = z.input<typeof productInput>;

/** Создание (id не задан) или редактирование товара. Скины создает синхронизация инвентаря ботов, здесь их только правят. */
export async function saveProduct(actor: SessionUser | null, id: string | null, input: ProductInput) {
  assertCan(actor, "products.manage");
  const parsed = productInput.safeParse(input);
  if (!parsed.success) throw new AdminActionError(parsed.error.issues[0]?.message ?? "Проверьте форму");
  const { priceSom, ...data } = parsed.data;
  if (data.type === "SHOP_SKIN" && data.deliveryMethod !== "TRADE_OFFER") throw new AdminActionError("Скин выдается только трейд-оффером");
  if (data.type !== "SHOP_SKIN" && data.deliveryMethod === "TRADE_OFFER") throw new AdminActionError("Трейд-оффер — только для скинов");

  const values = { ...data, priceMinor: priceSom };
  try {
    if (id) {
      const [before] = await db.select().from(products).where(eq(products.id, id));
      if (!before) throw new AdminActionError("Товар не найден");
      if (before.type !== data.type) throw new AdminActionError("Тип товара менять нельзя — создайте новый");
      await db.update(products).set(values).where(eq(products.id, id));
      await writeAudit(actorOf(actor), "product.updated", "product", id, {
        priceMinor: [before.priceMinor, values.priceMinor],
        isActive: [before.isActive, values.isActive],
      });
      return id;
    }
    if (data.type === "SHOP_SKIN") throw new AdminActionError("Скины добавляются синхронизацией инвентаря ботов");
    const [created] = await db.insert(products).values(values).returning({ id: products.id });
    await writeAudit(actorOf(actor), "product.created", "product", created.id, { slug: data.slug, priceMinor: values.priceMinor });
    return created.id;
  } catch (e) {
    const pgCode = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    if (pgCode === "23505") throw new AdminActionError("Такой адрес (slug) уже занят");
    throw e;
  }
}

export async function setProductActive(actor: SessionUser | null, id: string, isActive: boolean) {
  assertCan(actor, "products.manage");
  if (isActive) {
    const [p] = await db.select({ price: products.priceMinor }).from(products).where(eq(products.id, id));
    if (!p) throw new AdminActionError("Товар не найден");
    if (p.price <= 0) throw new AdminActionError("Сначала укажите цену");
  }
  await db.update(products).set({ isActive }).where(eq(products.id, id));
  await writeAudit(actorOf(actor), isActive ? "product.shown" : "product.hidden", "product", id);
}

// ---------- Ключи ----------

/** Разбор CSV: первая колонка — ключ. Заголовок key/code/ключ пропускается. */
export function parseKeysCsv(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const first = line.split(/[;,\t]/)[0]?.trim().replace(/^"(.*)"$/, "$1").trim();
    if (!first) continue;
    if (/^(key|code|ключ|код)$/i.test(first)) continue;
    out.push(first);
  }
  return out;
}

export async function importKeysCsv(actor: SessionUser | null, productId: string, csv: string) {
  assertCan(actor, "keys.manage");
  const [product] = await db.select().from(products).where(eq(products.id, productId));
  if (!product) throw new AdminActionError("Товар не найден");
  if (product.deliveryMethod !== "KEY") throw new AdminActionError("Этот товар выдается не ключом");

  const codes = parseKeysCsv(csv);
  const invalid = codes.filter((c) => c.length < 5 || c.length > 200 || /\s/.test(c));
  const valid = [...new Set(codes.filter((c) => !invalid.includes(c)))];
  let added = 0;
  // уникальный индекс по хэшу: дубль из прошлых загрузок (в том числе другого товара) не добавится
  for (let i = 0; i < valid.length; i += 500) {
    const chunk = valid.slice(i, i + 500);
    const res = await db
      .insert(productKeys)
      .values(chunk.map((c) => ({ productId, encryptedCode: encrypt(c), codeHash: sha256(c) })))
      .onConflictDoNothing()
      .returning({ id: productKeys.id });
    added += res.length;
  }
  const result = { total: codes.length, added, duplicates: codes.length - invalid.length - added, invalid: invalid.length };
  await writeAudit(actorOf(actor), "keys.imported", "product", productId, result);
  return result;
}

export async function listKeys(actor: SessionUser | null, productId: string) {
  assertCan(actor, "keys.manage");
  // сами ключи в админке не расшифровываются
  return db
    .select({
      id: productKeys.id,
      status: productKeys.status,
      hashPrefix: sql<string>`left(${productKeys.codeHash}, 10)`,
      createdAt: productKeys.createdAt,
      issuedAt: productKeys.issuedAt,
    })
    .from(productKeys)
    .where(eq(productKeys.productId, productId))
    .orderBy(desc(productKeys.createdAt))
    .limit(300);
}

export async function disableKey(actor: SessionUser | null, keyId: string) {
  assertCan(actor, "keys.manage");
  const res = await db
    .update(productKeys)
    .set({ status: "DISABLED" })
    .where(and(eq(productKeys.id, keyId), eq(productKeys.status, "AVAILABLE")))
    .returning({ productId: productKeys.productId });
  if (!res.length) throw new AdminActionError("Отключить можно только свободный ключ");
  await writeAudit(actorOf(actor), "key.disabled", "product", res[0].productId, { keyId });
}

/** Массовая установка цен скинов (после синхронизации инвентаря ботов они приходят без цены и скрытыми). */
export async function setSkinPrices(actor: SessionUser | null, rows: { id: string; priceMinor: number; show: boolean }[]) {
  assertCan(actor, "products.manage");
  let updated = 0;
  for (const r of rows) {
    if (!Number.isInteger(r.priceMinor) || r.priceMinor <= 0 || r.priceMinor > 1_000_000_000) continue;
    const res = await db
      .update(products)
      .set({ priceMinor: r.priceMinor, isActive: r.show })
      .where(and(eq(products.id, r.id), eq(products.type, "SHOP_SKIN"), sql`${products.soldAt} is null`))
      .returning({ id: products.id });
    updated += res.length;
  }
  if (updated) await writeAudit(actorOf(actor), "skins.priced", "product", null, { count: updated });
  return updated;
}
