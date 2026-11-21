import { HONEYPOT_FIELD } from "@/lib/security/honeypot";

/** Скрытое поле-ловушка для ботов. Люди его не видят и не заполняют. */
export function Honeypot() {
  return (
    <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
      <label>
        Сайт
        <input type="text" name={HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" defaultValue="" />
      </label>
    </div>
  );
}
