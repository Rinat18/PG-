import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/current";
import { can, roleLabel, type Permission } from "@/lib/admin/rbac";

export const dynamic = "force-dynamic";
export const metadata = { title: "Админка", robots: { index: false } };

const nav: { href: string; label: string; perm: Permission }[] = [
  { href: "/admin", label: "Сводка", perm: "dashboard.view" },
  { href: "/admin/orders", label: "Заказы", perm: "orders.view" },
  { href: "/admin/refunds", label: "Возвраты", perm: "refunds.manage" },
  { href: "/admin/products", label: "Товары и ключи", perm: "products.manage" },
  { href: "/admin/clients", label: "Клиенты", perm: "clients.view" },
  { href: "/admin/balances", label: "Балансы и выплаты", perm: "balances.view" },
  { href: "/admin/emails", label: "Письма", perm: "emails.view" },
  { href: "/admin/reports", label: "Отчеты", perm: "reports.view" },
  { href: "/admin/settings", label: "Настройки", perm: "settings.manage" },
  { href: "/admin/audit", label: "Журнал", perm: "audit.view" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser("/admin");
  if (!can(user, "admin.access")) notFound();
  return (
    <div className="grid gap-6 lg:grid-cols-[200px_1fr]">
      <aside className="space-y-3">
        <div className="text-xs text-muted">
          {user.displayName ?? user.email} · {roleLabel[user.role]}
        </div>
        <nav className="flex flex-wrap gap-1 lg:flex-col">
          {nav.filter((n) => can(user, n.perm)).map((n) => (
            <Link key={n.href} href={n.href} className="rounded-lg px-3 py-1.5 text-sm hover:bg-panel-2">
              {n.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 space-y-6">{children}</div>
    </div>
  );
}
