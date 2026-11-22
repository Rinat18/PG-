"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getClientIp, getFingerprint, requireUser } from "@/lib/auth/current";
import { allowFormByIp, isHoneypotTripped } from "@/lib/security/rate-limit";
import { createListing, SellerError, submitVerification, withdrawListing } from "@/lib/p2p/seller";
import { declineDealBySeller, mockTransferForDeal } from "@/lib/p2p/deals";
import { AdminActionError } from "@/lib/admin/orders";
import { kickOutbox } from "@/lib/email/kick";

/** Действия кабинета продавца: результат — сообщение в ?ok= / ?error= на странице возврата. */
async function run(back: string, fn: () => Promise<string>): Promise<never> {
  let msg: string;
  let ok = true;
  try {
    msg = await fn();
  } catch (e) {
    if (e instanceof SellerError || e instanceof AdminActionError) {
      msg = e.message;
      ok = false;
    } else throw e;
  }
  kickOutbox();
  revalidatePath(back.split("?")[0]);
  redirect(`${back}${back.includes("?") ? "&" : "?"}${ok ? "ok" : "error"}=${encodeURIComponent(msg)}`);
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "");

export type VerificationState = { error?: string };

export async function submitVerificationAction(_prev: VerificationState, f: FormData): Promise<VerificationState> {
  const user = await requireUser("/sell/verify");
  if (isHoneypotTripped(f)) return { error: "Не получилось отправить заявку" };
  if (!(await allowFormByIp("verification", await getClientIp()))) return { error: "Слишком много попыток, попробуйте через час" };
  const file = async (k: string) => {
    const v = f.get(k);
    return v instanceof File && v.size > 0 ? Buffer.from(await v.arrayBuffer()) : null;
  };
  try {
    await submitVerification(
      user,
      {
        fullName: str(f, "fullName"),
        birthDate: str(f, "birthDate"),
        passport: str(f, "passport"),
        phone: str(f, "phone"),
        payoutDetails: str(f, "payoutDetails"),
        payoutHolder: str(f, "payoutHolder"),
        adult: f.get("adult") === "on",
        sellerOffer: f.get("sellerOffer") === "on",
      },
      { passport: await file("passportPhoto"), selfie: await file("selfie") },
    );
  } catch (e) {
    if (e instanceof SellerError) return { error: e.message };
    throw e;
  }
  revalidatePath("/sell");
  redirect(`/sell?ok=${encodeURIComponent("Заявка отправлена на проверку")}`);
}

export async function createListingAction(f: FormData) {
  const game = str(f, "game") === "DOTA2" ? "DOTA2" : "CS2";
  await run(`/sell/new?game=${game}`, async () => {
    const user = await requireUser("/sell/new");
    if (!(await allowFormByIp("sell", await getClientIp()))) throw new SellerError("Слишком много действий, подождите несколько минут");
    const r = await createListing(
      user,
      { game, assetId: str(f, "assetId"), priceSom: str(f, "price").replace(/\s/g, "") as unknown as number, sellerOffer: f.get("sellerOffer") === "on" },
      await getFingerprint(),
    );
    return r.warning ? `Лот выставлен. ${r.warning}` : "Лот выставлен";
  });
}

export async function withdrawListingAction(f: FormData) {
  await run("/sell", async () => {
    await withdrawListing(await requireUser("/sell"), str(f, "listingId"));
    return "Лот снят с продажи";
  });
}

export async function declineDealAction(f: FormData) {
  const id = str(f, "dealId");
  await run(`/sell/deals/${id}`, async () => {
    await declineDealBySeller(await requireUser("/sell"), id);
    return "Сделка отменена, покупателю возвращены деньги";
  });
}

export async function mockTransferAction(f: FormData) {
  const id = str(f, "dealId");
  await run(`/sell/deals/${id}`, async () => {
    await mockTransferForDeal(await requireUser("/sell"), id);
    return "Предмет передан (тестовый режим). Сайт проверит получение в течение пары минут";
  });
}
