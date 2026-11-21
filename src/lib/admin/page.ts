import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/current";
import { can, type Permission } from "./rbac";

/** Для страниц админки: без входа — на /login, без права — 404 (не раскрываем, что раздел существует). */
export async function requireAdminPage(perm: Permission, path: string) {
  const user = await requireUser(path);
  if (!can(user, "admin.access") || !can(user, perm)) notFound();
  return user;
}

/** "1 234,50" → 123450 тыйын */
export function parseSom(raw: FormDataEntryValue | null): number {
  const n = Number(String(raw ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}
