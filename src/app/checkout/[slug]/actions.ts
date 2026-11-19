"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createOrder, OrderError } from "@/lib/orders/service";

export type CheckoutState = { error?: string; values?: { email: string } };

export async function checkoutAction(_prev: CheckoutState, form: FormData): Promise<CheckoutState> {
  const email = String(form.get("email") ?? "");
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? undefined;

  let token: string;
  try {
    const order = await createOrder(
      {
        productSlug: String(form.get("slug") ?? ""),
        email,
        tradeUrl: String(form.get("tradeUrl") ?? ""),
        adultConfirmed: form.get("adult") === "on",
        offerAccepted: form.get("offer") === "on",
      },
      { ip },
    );
    token = order.accessToken;
  } catch (e) {
    if (e instanceof OrderError) return { error: e.message, values: { email } };
    console.error(e);
    return { error: "Не получилось создать заказ. Попробуйте еще раз", values: { email } };
  }
  redirect(`/order/${token}`);
}
