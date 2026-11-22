import type { SessionUser } from "@/lib/auth/session";

/**
 * Права ролей админки. Проверяются на сервере в каждой функции src/lib/admin/*,
 * а не только в меню: прямой вызов server action без права не пройдет.
 */
export type Permission =
  | "admin.access"
  | "dashboard.view"
  | "products.manage"
  | "keys.manage"
  | "orders.view"
  | "orders.deliver"
  | "refunds.manage"
  | "reports.view"
  | "settings.manage"
  | "clients.view"
  | "users.roles"
  | "balances.view"
  | "balances.manage"
  | "payouts.manage"
  | "pii.view"
  | "audit.view"
  | "emails.view"
  | "bots.view"
  | "deals.view"
  | "deals.manage"
  | "verification.manage";

type Role = SessionUser["role"];

const matrix: Record<Role, readonly Permission[]> = {
  ADMIN: [
    "admin.access",
    "dashboard.view",
    "products.manage",
    "keys.manage",
    "orders.view",
    "orders.deliver",
    "refunds.manage",
    "reports.view",
    "settings.manage",
    "clients.view",
    "users.roles",
    "balances.view",
    "balances.manage",
    "payouts.manage",
    "audit.view",
    "emails.view",
    "bots.view",
    "deals.view",
    "deals.manage",
  ],
  // поддержка: заказы, выдача, возвраты, клиенты; без настроек, денег продавцов и паспортных данных
  SUPPORT: ["admin.access", "dashboard.view", "orders.view", "orders.deliver", "refunds.manage", "clients.view", "emails.view", "bots.view", "deals.view"],
  // комплаенс: верификация и паспортные данные (только эта роль), просмотр балансов и сделок
  COMPLIANCE: [
    "admin.access",
    "dashboard.view",
    "orders.view",
    "clients.view",
    "balances.view",
    "pii.view",
    "audit.view",
    "deals.view",
    "deals.manage",
    "verification.manage",
  ],
  BUYER: [],
};

export function can(user: Pick<SessionUser, "role" | "isBlocked"> | null | undefined, perm: Permission): boolean {
  if (!user || user.isBlocked) return false;
  return matrix[user.role].includes(perm);
}

export class AdminAccessError extends Error {
  constructor(public readonly permission: Permission) {
    super(`Нет доступа: ${permission}`);
  }
}

export function assertCan(user: SessionUser | null | undefined, perm: Permission): asserts user is SessionUser {
  if (!can(user, perm)) throw new AdminAccessError(perm);
}

export const actorOf = (user: Pick<SessionUser, "id">) => `admin:${user.id}`;

export const roleLabel: Record<Role, string> = {
  ADMIN: "Администратор",
  SUPPORT: "Поддержка",
  COMPLIANCE: "Комплаенс",
  BUYER: "Покупатель",
};
