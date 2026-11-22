"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Honeypot } from "@/components/Honeypot";
import { checkoutAction, type CheckoutState } from "./actions";

export function CheckoutForm({
  slug,
  listingId,
  needsTradeUrl,
  defaultEmail,
  defaultTradeUrl,
}: {
  slug: string;
  listingId?: string;
  needsTradeUrl: boolean;
  defaultEmail?: string;
  defaultTradeUrl?: string;
}) {
  const [state, action, pending] = useActionState<CheckoutState, FormData>(checkoutAction, {});
  return (
    <form action={action} className="relative space-y-4">
      <input type="hidden" name="slug" value={slug} />
      {listingId && <input type="hidden" name="listingId" value={listingId} />}
      <Honeypot />
      <label className="block space-y-1.5">
        <span className="text-sm">Email для чека{needsTradeUrl ? "" : " и ключа"}</span>
        <input name="email" type="email" required defaultValue={state.values?.email ?? defaultEmail} className="input" placeholder="you@example.com" />
      </label>
      {needsTradeUrl && (
        <label className="block space-y-1.5">
          <span className="text-sm">
            Trade-ссылка Steam{" "}
            <a
              href="https://steamcommunity.com/my/tradeoffers/privacy#trade_offer_access_url"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-accent underline"
            >
              где взять
            </a>
          </span>
          <input name="tradeUrl" required defaultValue={state.values?.tradeUrl ?? defaultTradeUrl} className="input" placeholder="https://steamcommunity.com/tradeoffer/new/?partner=...&token=..." />
        </label>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="adult" required className="mt-1" />
        <span>Мне исполнилось 18 лет</span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="offer" required className="mt-1" />
        <span>
          Принимаю условия <Link href="/info/offer" className="text-accent underline">публичной оферты</Link> и{" "}
          <Link href="/info/refund" className="text-accent underline">правила возврата</Link>
        </span>
      </label>
      {state.error && <div className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{state.error}</div>}
      <button className="btn-primary w-full" disabled={pending}>
        {pending ? "Создаем QR…" : "Перейти к оплате по QR"}
      </button>
    </form>
  );
}
