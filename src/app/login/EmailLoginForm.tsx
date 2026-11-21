"use client";

import { useActionState } from "react";
import { Honeypot } from "@/components/Honeypot";
import { requestEmailLoginAction, type EmailLoginState } from "./actions";

export function EmailLoginForm({ next, link, defaultEmail }: { next: string; link?: boolean; defaultEmail?: string }) {
  const [state, action, pending] = useActionState<EmailLoginState, FormData>(requestEmailLoginAction, {});
  if (state.sent) {
    return (
      <div className="rounded-lg border border-ok/40 bg-ok/10 px-3 py-2 text-sm">
        Мы отправили ссылку на <b>{state.email}</b>. Она действует 15 минут.
      </div>
    );
  }
  return (
    <form action={action} className="relative space-y-3">
      <input type="hidden" name="next" value={next} />
      {link && <input type="hidden" name="link" value="1" />}
      <Honeypot />
      <input
        name="email"
        type="email"
        required
        autoComplete="email"
        defaultValue={state.email ?? defaultEmail}
        className="input"
        placeholder="you@example.com"
      />
      {state.error && <div className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{state.error}</div>}
      <button className="btn-ghost w-full" disabled={pending}>
        {pending ? "Отправляем…" : link ? "Подтвердить email" : "Получить ссылку для входа"}
      </button>
    </form>
  );
}
