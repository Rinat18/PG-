"use server";

import { redirect } from "next/navigation";
import { createOrder, OrderError } from "@/lib/orders/service";
import { getClientIp, getCurrentUser } from "@/lib/auth/current";
import { allowFormByIp, isHoneypotTripped } from "@/lib/security/rate-limit";

export type CheckoutState = { error?: string; values?: { email: string; tradeUrl?: string } };

export async function checkoutAction(_prev: CheckoutState, form: FormData): Promise<CheckoutState> {
  const email = String(form.get("email") ?? "");
  const tradeUrl = String(form.get("tradeUrl") ?? "");
  if (isHoneypotTripped(form)) return { error: "Не получилось создать заказ. Попробуйте еще раз", values: { email, tradeUrl } };
  const ip = await getClientIp();
  if (!(await allowFormByIp("checkout", ip))) {
    return { error: "Слишком много попыток. Подождите несколько минут", values: { email, tradeUrl } };
  }
  const user = await getCurrentUser();

  let token: string;
  try {
    const order = await createOrder(
      {
        productSlug: String(form.get("slug") ?? ""),
        email,
        tradeUrl,
        adultConfirmed: form.get("adult") === "on",
        offerAccepted: form.get("offer") === "on",
      },
      { ip, userId: user?.id },
    );
    token = order.accessToken;
  } catch (e) {
    if (e instanceof OrderError) return { error: e.message, values: { email, tradeUrl } };
    console.error(e);
    return { error: "Не получилось создать заказ. Попробуйте еще раз", values: { email, tradeUrl } };
  }
  redirect(`/order/${token}`);
}
