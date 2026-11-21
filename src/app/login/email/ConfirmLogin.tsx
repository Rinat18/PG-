"use client";

import { useActionState } from "react";
import { consumeEmailLoginAction, type ConsumeState } from "../actions";

export function ConfirmLogin({ token }: { token: string }) {
  const [state, action, pending] = useActionState<ConsumeState, FormData>(consumeEmailLoginAction, {});
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      {state.error && <div className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{state.error}</div>}
      <button className="btn-primary w-full" disabled={pending}>
        {pending ? "Входим…" : "Войти"}
      </button>
    </form>
  );
}
