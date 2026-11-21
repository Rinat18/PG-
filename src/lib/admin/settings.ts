import { db } from "@/db";
import { settings } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { getSettings, settingsSchema, type Settings } from "@/lib/settings";
import { writeAudit } from "@/lib/audit";
import { AdminActionError } from "./orders";
import { actorOf, assertCan } from "./rbac";

export async function getSettingsAdmin(actor: SessionUser | null) {
  assertCan(actor, "settings.manage");
  return getSettings();
}

export async function saveSettings(actor: SessionUser | null, input: Record<string, unknown>) {
  assertCan(actor, "settings.manage");
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw new AdminActionError(`Неверное значение «${String(i?.path[0])}»: ${i?.message}`);
  }
  const before = await getSettings();
  const changed = (Object.keys(parsed.data) as (keyof Settings)[]).filter((k) => parsed.data[k] !== before[k]);
  for (const key of changed) {
    await db
      .insert(settings)
      .values({ key, value: parsed.data[key], updatedBy: actorOf(actor) })
      .onConflictDoUpdate({ target: settings.key, set: { value: parsed.data[key], updatedBy: actorOf(actor), updatedAt: new Date() } });
  }
  if (changed.length) {
    await writeAudit(actorOf(actor), "settings.updated", "settings", null, Object.fromEntries(changed.map((k) => [k, [before[k], parsed.data[k]]])));
  }
  return changed;
}
