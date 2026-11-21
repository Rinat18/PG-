import { dashboardStats } from "@/lib/admin/reports";
import { requireAdminPage } from "@/lib/admin/page";
import { can } from "@/lib/admin/rbac";
import { formatKgs } from "@/lib/format";
import { PageHead, Stat } from "@/components/admin/ui";

export default async function AdminDashboard() {
  const user = await requireAdminPage("dashboard.view", "/admin");
  const s = await dashboardStats(user);
  return (
    <>
      <PageHead title="Сводка" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Клиентов (аккаунтов)" value={s.clients} href={can(user, "clients.view") ? "/admin/clients" : undefined} />
        <Stat label="Новых за 30 дней" value={s.new_clients} />
        <Stat label="Гостевых email без аккаунта" value={s.guest_emails} />
        <Stat label="Оплат за сутки" value={s.orders_day} />
        <Stat label="Выручка за сутки" value={formatKgs(s.revenue_day)} />
        <Stat label="Выручка за 30 дней" value={formatKgs(s.revenue_30d)} href={can(user, "reports.view") ? "/admin/reports" : undefined} />
        {can(user, "balances.view") && <Stat label="Балансы продавцов (к выплате)" value={formatKgs(s.sellers_balance)} href="/admin/balances" />}
        <Stat label="Ждут ручной выдачи" value={s.manual_queue} href="/admin/orders?manual=1" tone={s.manual_queue ? "bad" : undefined} />
        <Stat label="На проверке" value={s.needs_review} href="/admin/orders?review=1" tone={s.needs_review ? "bad" : undefined} />
        <Stat label="Проблемных заказов" value={s.problems} href="/admin/orders?status=PROBLEM" tone={s.problems ? "bad" : undefined} />
        <Stat label="Неудавшихся возвратов" value={s.failed_refunds} href="/admin/refunds?status=FAILED" tone={s.failed_refunds ? "bad" : undefined} />
        <Stat label="Заявок на верификацию" value={s.verification_queue} />
      </div>
    </>
  );
}
