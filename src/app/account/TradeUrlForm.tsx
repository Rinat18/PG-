"use client";

import { useActionState } from "react";
import { Honeypot } from "@/components/Honeypot";
import { saveTradeUrlAction, type TradeUrlState } from "./actions";

export function TradeUrlForm({ initial, disabled }: { initial: string; disabled: boolean }) {
  const [state, action, pending] = useActionState<TradeUrlState, FormData>(saveTradeUrlAction, {});
  return (
    <form action={action} className="relative space-y-2">
      <Honeypot />
      <input
        name="tradeUrl"
        defaultValue={state.value ?? initial}
        disabled={disabled}
        className="input"
        placeholder="https://steamcommunity.com/tradeoffer/new/?partner=...&token=..."
      />
      {state.error && <div className="text-sm text-bad">{state.error}</div>}
      {state.ok && !state.error && <div className="text-sm text-ok">Сохранено</div>}
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-ghost" disabled={pending || disabled}>
          {pending ? "Сохраняем…" : "Сохранить"}
        </button>
        <a
          href="https://steamcommunity.com/my/tradeoffers/privacy#trade_offer_access_url"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-accent underline"
        >
          Где взять trade-ссылку
        </a>
      </div>
    </form>
  );
}
