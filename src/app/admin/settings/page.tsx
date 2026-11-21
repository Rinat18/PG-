import { getSettingsAdmin } from "@/lib/admin/settings";
import { requireAdminPage } from "@/lib/admin/page";
import { settingsLabels, type Settings } from "@/lib/settings";
import { Flash, PageHead } from "@/components/admin/ui";
import { saveSettingsAction } from "../actions";

export default async function AdminSettings({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const user = await requireAdminPage("settings.manage", "/admin/settings");
  const s = await getSettingsAdmin(user);
  return (
    <>
      <PageHead title="Настройки" />
      <p className="text-xs text-muted">Параметры из ТЗ, помеченные [__]. Применяются сразу, без деплоя; изменения пишутся в журнал.</p>
      <Flash ok={sp.ok} error={sp.error} />
      <form action={saveSettingsAction} className="card grid gap-4 p-6 md:grid-cols-2">
        {(Object.keys(settingsLabels) as (keyof Settings)[]).map((k) => (
          <label key={k} className="block space-y-1 text-sm">
            <span className="text-muted">{settingsLabels[k]}</span>
            <input name={k} required inputMode="decimal" defaultValue={String(s[k])} className="input" />
          </label>
        ))}
        <div className="md:col-span-2 md:text-right"><button className="btn-primary">Сохранить</button></div>
      </form>
    </>
  );
}
