/** Honeypot: скрытое поле, которое заполняют только боты. Без серверных зависимостей — импортируется и в клиентские формы. */
export const HONEYPOT_FIELD = "website";

export function isHoneypotTripped(form: FormData): boolean {
  const v = form.get(HONEYPOT_FIELD);
  return typeof v === "string" && v.trim() !== "";
}
