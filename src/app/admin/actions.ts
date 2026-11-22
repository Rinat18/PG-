"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current";
import { AdminAccessError } from "@/lib/admin/rbac";
import { AdminActionError, markOrderDelivered, refundOrder, requeueTradeOffer, retryRefund } from "@/lib/admin/orders";
import { disableKey, importKeysCsv, saveProduct, setProductActive, setSkinPrices, type ProductInput } from "@/lib/admin/catalog";
import { adjustBalance, createPayout } from "@/lib/admin/balances";
import { setUserBlocked, setUserRole } from "@/lib/admin/clients";
import { saveSettings } from "@/lib/admin/settings";
import { parseSom } from "@/lib/admin/page";
import { formatKgs } from "@/lib/format";
import { kickOutbox } from "@/lib/email/kick";
import { requeueEmail } from "@/lib/email/outbox";
import { assertCan } from "@/lib/admin/rbac";
import { reviewVerification, SellerError } from "@/lib/p2p/seller";
import { approveDealReview, blockListing, rejectDealReview, resolveDispute } from "@/lib/p2p/deals";

/**
 * Все действия админки. Право проверяется внутри сервисов src/lib/admin/* по текущему пользователю,
 * поэтому прямой POST без нужной роли получит отказ.
 */
async function run(back: string, fn: () => Promise<string>): Promise<never> {
  let msg: string;
  let ok = true;
  try {
    msg = await fn();
  } catch (e) {
    if (e instanceof AdminActionError || e instanceof AdminAccessError || e instanceof SellerError) {
      msg = e.message;
      ok = false;
    } else throw e;
  }
  kickOutbox(); // письма покупателю (выдача, возврат) уходят сразу
  revalidatePath(back.split("?")[0]);
  const sep = back.includes("?") ? "&" : "?";
  redirect(`${back}${sep}${ok ? "ok" : "error"}=${encodeURIComponent(msg)}`);
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "");

// ---------- Заказы ----------

export async function deliverOrderAction(f: FormData) {
  const id = str(f, "orderId");
  await run(`/admin/orders/${id}`, async () => {
    await markOrderDelivered(await getCurrentUser(), id, str(f, "note"));
    return "Заказ отмечен выданным, покупателю отправлено письмо";
  });
}

export async function refundOrderAction(f: FormData) {
  const id = str(f, "orderId");
  await run(`/admin/orders/${id}`, async () => {
    const r = await refundOrder(await getCurrentUser(), id, str(f, "reason"));
    if (!r.created) return "Возврат по этому заказу уже создан — второй не делается";
    if (r.status === "DONE") return "Возврат выполнен";
    throw new AdminActionError(`Провайдер не провел возврат: ${r.error ?? r.status}. Можно повторить`);
  });
}

export async function retryRefundAction(f: FormData) {
  const back = str(f, "back") || "/admin/refunds";
  await run(back, async () => {
    const r = await retryRefund(await getCurrentUser(), str(f, "refundId"));
    if (r.status === "DONE") return "Возврат выполнен";
    throw new AdminActionError(`Снова не прошел: ${r.error ?? r.status}`);
  });
}

// ---------- Товары и ключи ----------

function productFromForm(f: FormData): ProductInput {
  return {
    slug: str(f, "slug"),
    type: str(f, "type") as ProductInput["type"],
    game: str(f, "game") as ProductInput["game"],
    title: str(f, "title"),
    description: str(f, "description"),
    activationInstructions: str(f, "activationInstructions"),
    region: str(f, "region"),
    durationMonths: str(f, "durationMonths") || undefined,
    deliveryMethod: str(f, "deliveryMethod") as ProductInput["deliveryMethod"],
    deliveryEta: str(f, "deliveryEta"),
    priceSom: str(f, "priceSom").replace(",", "."),
    imageUrl: str(f, "imageUrl"),
    isActive: f.get("isActive") === "on",
  };
}

export async function saveProductAction(f: FormData) {
  const id = str(f, "id") || null;
  let savedId = id;
  let error: string | null = null;
  try {
    savedId = await saveProduct(await getCurrentUser(), id, productFromForm(f));
  } catch (e) {
    if (e instanceof AdminActionError || e instanceof AdminAccessError) error = e.message;
    else throw e;
  }
  revalidatePath("/admin/products");
  if (error) redirect(`${id ? `/admin/products/${id}` : "/admin/products/new"}?error=${encodeURIComponent(error)}`);
  redirect(`/admin/products/${savedId}?ok=${encodeURIComponent("Сохранено")}`);
}

export async function toggleProductAction(f: FormData) {
  const id = str(f, "id");
  const show = f.get("show") === "1";
  await run(str(f, "back") || "/admin/products", async () => {
    await setProductActive(await getCurrentUser(), id, show);
    return show ? "Товар показан в каталоге" : "Товар скрыт";
  });
}

export async function importKeysAction(f: FormData) {
  const id = str(f, "productId");
  await run(`/admin/products/${id}`, async () => {
    const file = f.get("file");
    let text = str(f, "csv");
    if (file instanceof File && file.size > 0) {
      if (file.size > 5_000_000) throw new AdminActionError("Файл больше 5 МБ");
      text = await file.text();
    }
    if (!text.trim()) throw new AdminActionError("Загрузите CSV или вставьте ключи");
    const r = await importKeysCsv(await getCurrentUser(), id, text);
    return `Добавлено ${r.added} из ${r.total}; дублей ${r.duplicates}, некорректных ${r.invalid}`;
  });
}

export async function disableKeyAction(f: FormData) {
  const id = str(f, "productId");
  await run(`/admin/products/${id}`, async () => {
    await disableKey(await getCurrentUser(), str(f, "keyId"));
    return "Ключ отключен";
  });
}

// ---------- Клиенты, балансы, выплаты ----------

export async function adjustBalanceAction(f: FormData) {
  const id = str(f, "userId");
  await run(`/admin/clients/${id}`, async () => {
    const sign = str(f, "direction") === "minus" ? -1 : 1;
    const amount = parseSom(f.get("amount"));
    if (!Number.isFinite(amount) || amount <= 0) throw new AdminActionError("Укажите сумму больше нуля");
    const after = await adjustBalance(await getCurrentUser(), id, sign * amount, str(f, "reason"));
    return `Баланс изменен: ${formatKgs(after)}`;
  });
}

export async function payoutAction(f: FormData) {
  const id = str(f, "userId");
  await run(`/admin/clients/${id}`, async () => {
    const amount = parseSom(f.get("amount"));
    if (!Number.isFinite(amount) || amount <= 0) throw new AdminActionError("Укажите сумму выплаты");
    const r = await createPayout(await getCurrentUser(), id, amount);
    if (r.status === "SENT") return `Выплата ${formatKgs(amount)} отправлена`;
    throw new AdminActionError(`Выплата не прошла, деньги возвращены на баланс: ${r.error}`);
  });
}

export async function setRoleAction(f: FormData) {
  const id = str(f, "userId");
  await run(`/admin/clients/${id}`, async () => {
    await setUserRole(await getCurrentUser(), id, str(f, "role") as "BUYER");
    return "Роль изменена";
  });
}

export async function setBlockedAction(f: FormData) {
  const id = str(f, "userId");
  const blocked = f.get("blocked") === "1";
  await run(`/admin/clients/${id}`, async () => {
    await setUserBlocked(await getCurrentUser(), id, blocked);
    return blocked ? "Пользователь заблокирован" : "Пользователь разблокирован";
  });
}

// ---------- Настройки ----------

export async function saveSettingsAction(f: FormData) {
  await run("/admin/settings", async () => {
    const input = Object.fromEntries([...f.entries()].filter(([k]) => !k.startsWith("$")).map(([k, v]) => [k, String(v).replace(",", ".")]));
    const changed = await saveSettings(await getCurrentUser(), input);
    return changed.length ? `Сохранено: ${changed.length} параметр(ов)` : "Изменений нет";
  });
}

// ---------- Письма ----------

export async function requeueEmailAction(f: FormData) {
  await run("/admin/emails", async () => {
    assertCan(await getCurrentUser(), "emails.view");
    if (!(await requeueEmail(str(f, "emailId")))) throw new AdminActionError("Письмо уже отправлено");
    return "Письмо поставлено в очередь повторно";
  });
}

// ---------- Боты ----------

export async function requeueTradeAction(f: FormData) {
  await run(str(f, "back") || "/admin/bots", async () => {
    await requeueTradeOffer(await getCurrentUser(), str(f, "offerId"));
    return "Трейд снова в очереди";
  });
}

export async function setSkinPricesAction(f: FormData) {
  await run("/admin/bots", async () => {
    const ids = f.getAll("id").map(String);
    const rows = ids
      .map((id) => ({ id, priceMinor: parseSom(f.get(`price_${id}`)), show: f.get(`show_${id}`) === "on" }))
      .filter((r) => Number.isFinite(r.priceMinor) && r.priceMinor > 0);
    if (!rows.length) throw new AdminActionError("Укажите хотя бы одну цену");
    const n = await setSkinPrices(await getCurrentUser(), rows);
    return `Цены установлены: ${n}`;
  });
}

// ---------- P2P ----------

export async function reviewVerificationAction(f: FormData) {
  const userId = str(f, "userId");
  const approve = str(f, "decision") === "approve";
  await run(`/admin/verification/${userId}`, async () => {
    await reviewVerification(await getCurrentUser(), userId, approve, str(f, "reason"));
    return approve ? "Продавец верифицирован" : "Заявка отклонена";
  });
}

export async function dealReviewAction(f: FormData) {
  const id = str(f, "dealId");
  await run(`/admin/deals/${id}`, async () => {
    const actor = await getCurrentUser();
    if (str(f, "decision") === "approve") {
      await approveDealReview(actor, id);
      return "Проверка пройдена: продавцу открыт срок передачи";
    }
    await rejectDealReview(actor, id, str(f, "reason"));
    return "Сделка отменена, покупателю оформлен возврат";
  });
}

export async function resolveDisputeAction(f: FormData) {
  const id = str(f, "dealId");
  const outcome = str(f, "outcome") === "buyer" ? "buyer" : "seller";
  await run(`/admin/deals/${id}`, async () => {
    await resolveDispute(await getCurrentUser(), id, outcome, str(f, "note"));
    return outcome === "buyer" ? "Спор решен в пользу покупателя: возврат" : "Спор решен в пользу продавца: сделка продолжается";
  });
}

export async function blockListingAction(f: FormData) {
  await run("/admin/deals?tab=lots", async () => {
    await blockListing(await getCurrentUser(), str(f, "listingId"), str(f, "reason"));
    return "Лот заблокирован";
  });
}
