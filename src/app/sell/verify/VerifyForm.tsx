"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Honeypot } from "@/components/Honeypot";
import { submitVerificationAction, type VerificationState } from "../actions";

export function VerifyForm() {
  const [state, action, pending] = useActionState<VerificationState, FormData>(submitVerificationAction, {});
  return (
    <form action={action} className="relative space-y-4">
      <Honeypot />
      <Field label="ФИО полностью, как в паспорте">
        <input name="fullName" required className="input" autoComplete="name" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Дата рождения">
          <input name="birthDate" type="date" required className="input" />
        </Field>
        <Field label="Номер паспорта КР">
          <input name="passport" required className="input" placeholder="ID1234567" />
        </Field>
      </div>
      <Field label="Телефон">
        <input name="phone" type="tel" required className="input" placeholder="+996 555 123 456" autoComplete="tel" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Фото паспорта (разворот с фото)">
          <input name="passportPhoto" type="file" accept="image/jpeg,image/png,image/webp" required className="text-sm" />
        </Field>
        <Field label="Селфи с паспортом в руке">
          <input name="selfie" type="file" accept="image/jpeg,image/png,image/webp" required className="text-sm" />
        </Field>
      </div>
      <div className="space-y-3 rounded-lg border border-line p-4">
        <div className="text-sm font-semibold">Реквизиты для выплат</div>
        <p className="text-xs text-muted">Только счет, карта или кошелек на ваше имя: на чужие реквизиты выплаты не отправляются.</p>
        <Field label="Номер счета, карты или кошелька">
          <input name="payoutDetails" required className="input" />
        </Field>
        <Field label="Владелец реквизитов (ФИО)">
          <input name="payoutHolder" required className="input" />
        </Field>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="adult" required className="mt-1" />
        <span>Мне исполнилось 18 лет</span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="sellerOffer" required className="mt-1" />
        <span>
          Принимаю <Link href="/info/seller-rules" className="text-accent underline">оферту для продавцов</Link> и согласен на обработку
          персональных данных по <Link href="/info/privacy" className="text-accent underline">политике конфиденциальности</Link>
        </span>
      </label>
      {state.error && <div className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{state.error}</div>}
      <button className="btn-primary w-full" disabled={pending}>{pending ? "Отправляем…" : "Отправить на проверку"}</button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm">{label}</span>
      {children}
    </label>
  );
}
