import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, orderItems, orders, productKeys, users } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { parseTradeUrl } from "@/lib/auth/steam-id";

/** Личный кабинет покупателя. Каждая функция фильтрует по userId: чужие заказы и ключи недоступны. */

export async function listUserOrders(userId: string, limit = 100) {
  const rows = await db
    .select({
      id: orders.id,
      number: orders.number,
      status: orders.status,
      totalMinor: orders.totalMinor,
      createdAt: orders.createdAt,
      accessToken: orders.accessToken,
    })
    .from(orders)
    .where(eq(orders.userId, userId))
    .orderBy(desc(orders.createdAt))
    .limit(limit);
  if (!rows.length) return [];
  const items = await db
    .select({ orderId: orderItems.orderId, title: orderItems.titleSnapshot })
    .from(orderItems)
    .where(inArray(orderItems.orderId, rows.map((r) => r.id)));
  return rows.map((r) => ({ ...r, titles: items.filter((i) => i.orderId === r.id).map((i) => i.title) }));
}

/** Заказ владельца с расшифрованными ключами. Чужой заказ — null (как будто его нет). */
export async function getUserOrder(userId: string, orderId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return null;
  const [order] = await db.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.userId, userId)));
  if (!order) return null;
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  let keys: { title: string; code: string }[] = [];
  if (items.length && (order.status === "DELIVERED" || order.status === "PAID")) {
    const rows = await db
      .select({ code: productKeys.encryptedCode, itemId: productKeys.orderItemId })
      .from(productKeys)
      .where(and(inArray(productKeys.orderItemId, items.map((i) => i.id)), eq(productKeys.status, "ISSUED")));
    keys = rows.map((r) => ({ title: items.find((i) => i.id === r.itemId)?.titleSnapshot ?? "", code: decrypt(r.code) }));
  }
  return { order, items, keys };
}

export class TradeUrlError extends Error {}

/** Trade-ссылку сохраняет только пользователь, вошедший через Steam, и только свою. */
export async function saveTradeUrl(userId: string, rawUrl: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new TradeUrlError("Пользователь не найден");
  const url = rawUrl.trim();
  if (url === "") {
    await db.update(users).set({ tradeUrl: null }).where(eq(users.id, userId));
    return null;
  }
  if (!user.steamId) throw new TradeUrlError("Сначала войдите через Steam: trade-ссылка проверяется по вашему аккаунту");
  const parsed = parseTradeUrl(url);
  if (!parsed) {
    throw new TradeUrlError("Нужна ссылка вида https://steamcommunity.com/tradeoffer/new/?partner=...&token=...");
  }
  if (parsed.steamId !== user.steamId) throw new TradeUrlError("Эта trade-ссылка принадлежит другому аккаунту Steam");
  await db.update(users).set({ tradeUrl: url }).where(eq(users.id, userId));
  await db.insert(auditLog).values({ actor: `user:${userId}`, action: "user.trade_url_saved", entity: "user", entityId: userId, data: {} });
  return url;
}
