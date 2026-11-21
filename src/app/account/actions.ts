"use server";

import { revalidatePath } from "next/cache";
import { saveTradeUrl, TradeUrlError } from "@/lib/account";
import { getClientIp, requireUser } from "@/lib/auth/current";
import { allowFormByIp, isHoneypotTripped } from "@/lib/security/rate-limit";

export type TradeUrlState = { ok?: boolean; error?: string; value?: string };

export async function saveTradeUrlAction(_prev: TradeUrlState, form: FormData): Promise<TradeUrlState> {
  const user = await requireUser("/account");
  const value = String(form.get("tradeUrl") ?? "");
  if (isHoneypotTripped(form)) return { ok: true, value };
  if (!(await allowFormByIp("profile", await getClientIp()))) return { error: "Слишком много попыток, подождите", value };
  try {
    await saveTradeUrl(user.id, value);
  } catch (e) {
    if (e instanceof TradeUrlError) return { error: e.message, value };
    throw e;
  }
  revalidatePath("/account");
  return { ok: true, value };
}
