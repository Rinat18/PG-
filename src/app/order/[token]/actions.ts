"use server";

import { revalidatePath } from "next/cache";
import { cancelPendingOrderByBuyer } from "@/lib/orders/service";

export async function cancelOrderAction(form: FormData) {
  const token = String(form.get("token") ?? "");
  await cancelPendingOrderByBuyer(token);
  revalidatePath(`/order/${token}`);
}
