/**
 * Назначение роли из консоли — нужно, чтобы завести первого администратора:
 *   npm run admin:grant -- you@example.com            (ADMIN)
 *   npm run admin:grant -- 7656119... SUPPORT
 * Пользователь должен хоть раз войти на сайт (по email или через Steam).
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { auditLog, users } from "./schema";

async function main() {
  const [who, roleArg = "ADMIN"] = process.argv.slice(2);
  const role = roleArg.toUpperCase() as "ADMIN" | "SUPPORT" | "COMPLIANCE" | "BUYER";
  if (!who || !["ADMIN", "SUPPORT", "COMPLIANCE", "BUYER"].includes(role)) {
    console.error("Использование: npm run admin:grant -- <email|steamId> [ADMIN|SUPPORT|COMPLIANCE|BUYER]");
    process.exit(1);
  }
  const field = /^\d{17}$/.test(who) ? users.steamId : users.email;
  const [user] = await db.update(users).set({ role }).where(eq(field, who.toLowerCase())).returning();
  if (!user) {
    console.error("Пользователь не найден: сначала войдите на сайт этим email или Steam-аккаунтом");
    process.exit(1);
  }
  await db.insert(auditLog).values({ actor: "cli", action: "user.role_changed", entity: "user", entityId: user.id, data: { to: role } });
  console.log(`${user.email ?? user.steamId}: роль ${role}`);
  process.exit(0);
}
main();
