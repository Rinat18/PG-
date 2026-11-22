"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cancelPendingOrderByBuyer } from "@/lib/orders/service";
import { openDisputeByBuyer } from "@/lib/p2p/deals";
import { AdminActionError } from "@/lib/admin/orders";

export async function cancelOrderAction(form: FormData) {
  const token = String(form.get("token") ?? "");
  await cancelPendingOrderByBuyer(token);
  revalidatePath(`/order/${token}`);
}

export async function openDisputeAction(form: FormData) {
  const token = String(form.get("token") ?? "");
  let msg = "Спор открыт. Поддержка разберется и напишет вам на почту";
  let ok = true;
  try {
    await openDisputeByBuyer(token, String(form.get("reason") ?? ""));
  } catch (e) {
    if (!(e instanceof AdminActionError)) throw e;
    msg = e.message;
    ok = false;
  }
  revalidatePath(`/order/${token}`);
  redirect(`/order/${token}?${ok ? "ok" : "error"}=${encodeURIComponent(msg)}`);
}
