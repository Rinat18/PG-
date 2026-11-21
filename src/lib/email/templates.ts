import { formatKgs } from "@/lib/format";
import { site } from "@/lib/site";

/**
 * Шаблоны писем. Каждый возвращает тему, текст и HTML. Данные в HTML экранируются.
 * Покупателю: оплата и ключ, выдача оператором, трейд отправлен, проблема с выдачей, возврат, вход по ссылке.
 * Продавцу: продажа лота, напоминание о передаче, выплата.
 */

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const fmtDate = (d: Date) => d.toLocaleString("ru-RU", { timeZone: "Asia/Bishkek", dateStyle: "long", timeStyle: "short" });

type Block =
  | { p: string }
  | { list: string[] }
  | { code: { label: string; value: string }[] }
  | { button: { label: string; url: string } }
  | { note: string };

type Rendered = { subject: string; text: string; html: string };

function layout(subject: string, blocks: Block[]): Rendered {
  const text: string[] = [];
  const html: string[] = [];
  for (const b of blocks) {
    if ("p" in b) {
      text.push(b.p);
      html.push(`<p style="margin:0 0 14px">${esc(b.p)}</p>`);
    } else if ("list" in b) {
      text.push(b.list.map((i) => `• ${i}`).join("\n"));
      html.push(`<ul style="margin:0 0 14px;padding-left:20px">${b.list.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`);
    } else if ("code" in b) {
      text.push(b.code.map((c) => `${c.label}: ${c.value}`).join("\n"));
      html.push(
        b.code
          .map(
            (c) =>
              `<div style="margin:0 0 6px;color:#666;font-size:13px">${esc(c.label)}</div>` +
              `<div style="margin:0 0 14px;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font:16px monospace;background:#f7f7f7">${esc(c.value)}</div>`,
          )
          .join(""),
      );
    } else if ("button" in b) {
      text.push(`${b.button.label}: ${b.button.url}`);
      html.push(
        `<p style="margin:0 0 14px"><a href="${esc(b.button.url)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#f5a524;color:#1a1203;text-decoration:none;font-weight:600">${esc(b.button.label)}</a></p>`,
      );
    } else {
      text.push(b.note);
      html.push(`<p style="margin:0 0 14px;color:#666;font-size:13px">${esc(b.note)}</p>`);
    }
  }
  const footer = `${site.name} · ${site.legalName} · ${site.email}`;
  text.push("", "—", footer);
  return {
    subject,
    text: text.join("\n\n"),
    html:
      `<!doctype html><html><body style="margin:0;padding:24px;background:#f2f2f2;font:15px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111">` +
      `<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:24px">` +
      `<div style="font-weight:800;font-size:18px;margin:0 0 18px">Play<span style="color:#f5a524">Ground</span></div>` +
      html.join("") +
      `<hr style="border:none;border-top:1px solid #eee;margin:20px 0"><div style="color:#888;font-size:12px">${esc(footer)}</div>` +
      `</div></body></html>`,
  };
}

export type TemplateData = {
  orderPaid: {
    number: string;
    totalMinor: number;
    items: { title: string; priceMinor: number }[];
    keys: { title: string; code: string }[];
    orderUrl: string;
    /** что будет дальше, если товар выдается не сразу */
    pendingNote?: string;
  };
  orderDelivered: { number: string; items: string[]; note?: string; orderUrl: string };
  tradeSent: { number: string; itemTitle: string; tradeHoldDays: number; orderUrl: string };
  deliveryProblem: { number: string; orderUrl: string; reviewDays: number };
  refund: { number: string; amountMinor: number; refundDays: number };
  loginLink: { link: string; purpose: "login" | "confirm" };
  lotSold: { title: string; priceMinor: number; payoutMinor: number; deadline: Date; dealUrl: string };
  transferReminder: { title: string; deadline: Date; hoursLeft: number; dealUrl: string };
  payoutSent: { amountMinor: number; detailsMasked: string };
};
export type TemplateName = keyof TemplateData;

const templates: { [K in TemplateName]: (d: TemplateData[K]) => Rendered } = {
  orderPaid: (d) =>
    layout(`Заказ ${d.number}: оплата получена`, [
      { p: `Оплата по заказу ${d.number} получена: ${formatKgs(d.totalMinor)}.` },
      { list: d.items.map((i) => `${i.title} — ${formatKgs(i.priceMinor)}`) },
      ...(d.keys.length ? [{ p: d.keys.length > 1 ? "Ваши ключи:" : "Ваш ключ:" }, { code: d.keys.map((k) => ({ label: k.title, value: k.code })) }] : []),
      ...(d.pendingNote ? [{ p: d.pendingNote }] : []),
      { button: { label: "Открыть заказ", url: d.orderUrl } },
      { note: "Ссылка на заказ — ваш доступ к нему. Не пересылайте это письмо." },
    ]),
  orderDelivered: (d) =>
    layout(`Заказ ${d.number} выдан`, [
      { p: `Заказ ${d.number} выдан.` },
      { list: d.items },
      ...(d.note ? [{ p: `Комментарий оператора: ${d.note}` }] : []),
      { button: { label: "Открыть заказ", url: d.orderUrl } },
    ]),
  tradeSent: (d) =>
    layout(`Заказ ${d.number}: трейд-оффер отправлен`, [
      { p: `Бот магазина отправил трейд-оффер на «${d.itemTitle}». Откройте Steam → Инвентарь → Предложения обмена и примите его.` },
      ...(d.tradeHoldDays > 0
        ? [{ p: `На вашем аккаунте Steam задержка обмена (trade hold) ${d.tradeHoldDays} дн.: предмет придет после ее окончания.` }]
        : []),
      { button: { label: "Открыть заказ", url: d.orderUrl } },
      { note: "Магазин никогда не просит вернуть предмет и не пишет в чатах Steam от своего имени." },
    ]),
  deliveryProblem: (d) =>
    layout(`Заказ ${d.number}: проблема с выдачей`, [
      { p: `Не получилось автоматически выдать товар по заказу ${d.number}. Мы уже разбираемся.` },
      { p: `Если товар не удастся выдать, деньги вернутся полностью. Срок рассмотрения — до ${d.reviewDays} рабочих дней.` },
      { button: { label: "Открыть заказ", url: d.orderUrl } },
      { note: `Вопросы: ${site.email}, Telegram ${site.telegram}.` },
    ]),
  refund: (d) =>
    layout(`Возврат по заказу ${d.number}`, [
      { p: `Мы вернули ${formatKgs(d.amountMinor)} по заказу ${d.number}.` },
      { p: `Деньги поступят на счет, с которого была оплата, в течение ${d.refundDays} рабочих дней (срок зависит от банка).` },
    ]),
  loginLink: (d) =>
    layout(d.purpose === "confirm" ? "Подтверждение email" : "Вход на сайт", [
      { p: d.purpose === "confirm" ? "Чтобы подтвердить email в личном кабинете, нажмите кнопку." : "Чтобы войти на сайт, нажмите кнопку." },
      { button: { label: d.purpose === "confirm" ? "Подтвердить email" : "Войти", url: d.link } },
      { note: "Ссылка действует 15 минут и только один раз. Если вы не запрашивали письмо, просто проигнорируйте его." },
    ]),
  lotSold: (d) =>
    layout(`Ваш лот продан: ${d.title}`, [
      { p: `Покупатель оплатил «${d.title}» за ${formatKgs(d.priceMinor)}. После завершения сделки вы получите ${formatKgs(d.payoutMinor)}.` },
      { p: `Передайте предмет трейд-оффером до ${fmtDate(d.deadline)}. Если не передать вовремя, сделка отменится и покупатель получит возврат.` },
      { button: { label: "Открыть сделку", url: d.dealUrl } },
    ]),
  transferReminder: (d) =>
    layout(`Осталось ${d.hoursLeft} ч на передачу: ${d.title}`, [
      { p: `Напоминаем: «${d.title}» нужно передать покупателю до ${fmtDate(d.deadline)}.` },
      { button: { label: "Открыть сделку", url: d.dealUrl } },
    ]),
  payoutSent: (d) =>
    layout("Выплата отправлена", [
      { p: `Мы отправили ${formatKgs(d.amountMinor)} на ваши реквизиты ${d.detailsMasked}.` },
      { note: "Срок зачисления зависит от банка получателя." },
    ]),
};

export function renderEmail<K extends TemplateName>(name: K, data: TemplateData[K]): Rendered {
  return templates[name](data);
}

/** «KG12 3456 7890 1234» → «•••• 1234» */
export function maskDetails(details: string): string {
  const digits = details.replace(/\s/g, "");
  return `•••• ${digits.slice(-4)}`;
}
