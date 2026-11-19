"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** Таймер QR и опрос статуса заказа. Как только статус меняется, страница перерисовывается с сервера. */
export function PaymentWaiter({ token, expiresAt }: { token: string; expiresAt: string }) {
  const router = useRouter();
  const [left, setLeft] = useState(() => Math.max(0, new Date(expiresAt).getTime() - Date.now()));

  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, new Date(expiresAt).getTime() - Date.now())), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/orders/${token}/status`, { cache: "no-store" });
        const data = await res.json();
        if (!stop && data.status && data.status !== "PENDING_PAYMENT") router.refresh();
      } catch {
        // сеть пропала — попробуем на следующем тике
      }
    };
    const t = setInterval(poll, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [token, router]);

  const mm = String(Math.floor(left / 60000)).padStart(2, "0");
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, "0");
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted">Ждем подтверждение оплаты от банка…</span>
      <span className={`font-mono text-lg font-bold ${left < 60000 ? "text-bad" : ""}`}>
        {left > 0 ? `${mm}:${ss}` : "QR истек"}
      </span>
    </div>
  );
}
