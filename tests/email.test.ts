import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { emailOutbox, mockProviderPayments, payments, productKeys, products } from "@/db/schema";
import { decrypt, encrypt, sha256 } from "@/lib/crypto";
import { MAX_ATTEMPTS, processOutbox, queueEmail, requeueEmail, sanitizeError, type Mailer, type OutgoingMail } from "@/lib/email/outbox";
import { renderEmail, type TemplateData, type TemplateName } from "@/lib/email/templates";
import { createOrder, handlePaymentWebhook } from "@/lib/orders/service";
import { requestEmailLogin } from "@/lib/auth/email-login";
import { signMockWebhook, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "@/lib/payments/mock-elqr";
import { GET as cronGet, POST as cronPost } from "@/app/api/cron/send-emails/route";

beforeEach(async () => {
  await db.execute(sql`truncate table settings, sessions, login_tokens, rate_limits, users, webhook_events, email_outbox, refunds,
    trade_offers, payments, product_keys, order_items, orders, products, mock_provider_payments, audit_log cascade`);
});
afterEach(() => vi.restoreAllMocks());

function recordingMailer(fail?: (m: OutgoingMail) => Error | null) {
  const sent: OutgoingMail[] = [];
  const mailer: Mailer = {
    async send(m) {
      const err = fail?.(m);
      if (err) throw err;
      sent.push(m);
    },
  };
  return { mailer, sent };
}

/** Перехватывает всё, что пишется в консоль и stdout/stderr. */
function captureLogs() {
  const out: string[] = [];
  const grab = (...a: unknown[]) => void out.push(a.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(" "));
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation(grab);
  const w = (chunk: unknown) => (out.push(String(chunk)), true);
  vi.spyOn(process.stdout, "write").mockImplementation(w as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(w as typeof process.stderr.write);
  return out;
}

async function buyKey(code: string, email = "buyer@test.kg") {
  const [p] = await db
    .insert(products)
    .values({ slug: `k-${randomUUID().slice(0, 6)}`, type: "GAME_KEY", game: "OTHER", title: "Игра", deliveryMethod: "KEY", deliveryEta: "x", priceMinor: 300_00 })
    .returning();
  await db.insert(productKeys).values({ productId: p.id, encryptedCode: encrypt(code), codeHash: sha256(code) });
  const order = await createOrder({ productSlug: p.slug, email, adultConfirmed: true, offerAccepted: true });
  const [payment] = await db.select().from(payments).where(eq(payments.orderId, order.id));
  await db.update(mockProviderPayments).set({ status: "SUCCEEDED" }).where(eq(mockProviderPayments.id, payment.providerPaymentId));
  const body = JSON.stringify({
    eventId: `evt_${randomUUID()}`,
    paymentId: payment.providerPaymentId,
    status: "SUCCEEDED",
    amount: payment.amountMinor,
    currency: "KGS",
    occurredAt: new Date().toISOString(),
  });
  const ts = Math.floor(Date.now() / 1000);
  const headers = new Headers({ [SIGNATURE_HEADER]: signMockWebhook(process.env.MOCK_ELQR_WEBHOOK_SECRET!, body, ts), [TIMESTAMP_HEADER]: String(ts) });
  await handlePaymentWebhook("mock", body, headers);
  return order;
}

describe("приемка: ключ не попадает в логи и хранится зашифрованным", () => {
  it("покупка, ошибка SMTP и повторная отправка письма с ключом", async () => {
    const KEY = `SECRET-${randomUUID()}`;
    const logs = captureLogs();

    await buyKey(KEY);

    // в базе ни тело, ни HTML не содержат ключ в открытом виде
    const raw = await db.execute<{ hits: number }>(
      sql`select count(*)::int as hits from email_outbox where encrypted_body like ${"%" + KEY + "%"} or encrypted_html like ${"%" + KEY + "%"}`,
    );
    expect(raw.rows[0].hits).toBe(0);
    const [row] = await db.select().from(emailOutbox);
    expect(decrypt(row.encryptedBody)).toContain(KEY);
    expect(decrypt(row.encryptedHtml!)).toContain(KEY);

    // SMTP падает, и в тексте ошибки сервер даже вернул кусок письма
    const failing = recordingMailer((m) => new Error(`550 rejected: ${m.text.slice(0, 400)}`));
    expect(await processOutbox({ mailer: failing.mailer })).toMatchObject({ sent: 0, failed: 1 });
    const [afterFail] = await db.select().from(emailOutbox);
    expect(afterFail.lastError).toContain("550 rejected");
    expect(afterFail.lastError).not.toContain(KEY);

    // повтор после паузы — успешно
    await db.update(emailOutbox).set({ nextAttemptAt: new Date(Date.now() - 1000) });
    const ok = recordingMailer();
    expect(await processOutbox({ mailer: ok.mailer })).toMatchObject({ sent: 1, failed: 0 });
    expect(ok.sent[0].text).toContain(KEY);
    expect(ok.sent[0].html).toContain(KEY);

    expect(logs.length).toBeGreaterThan(0); // ошибка SMTP залогирована…
    expect(logs.join("\n")).not.toContain(KEY); // …но без ключа
  });
});

describe("очередь писем", () => {
  it("отправляет, ставит sent_at и не отправляет повторно", async () => {
    await queueEmail("a@test.kg", "refund", { number: "PG-1", amountMinor: 100_00, refundDays: 5 });
    const { mailer, sent } = recordingMailer();
    expect(await processOutbox({ mailer })).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(await processOutbox({ mailer })).toEqual({ claimed: 0, sent: 0, failed: 0 });
    expect(sent).toHaveLength(1);
    const [row] = await db.select().from(emailOutbox);
    expect(row.sentAt).not.toBeNull();
    expect(row.attempts).toBe(1);
  });

  it("повторяет с паузой и сдается после MAX_ATTEMPTS; из админки можно повторить", async () => {
    await queueEmail("b@test.kg", "refund", { number: "PG-2", amountMinor: 100_00, refundDays: 5 });
    const failing = recordingMailer(() => new Error("connect ETIMEDOUT"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await processOutbox({ mailer: failing.mailer });
    // до следующей попытки письмо не берется
    expect((await processOutbox({ mailer: failing.mailer })).claimed).toBe(0);

    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await db.update(emailOutbox).set({ nextAttemptAt: new Date(Date.now() - 1000) });
      await processOutbox({ mailer: failing.mailer });
    }
    const [dead] = await db.select().from(emailOutbox);
    expect(dead.attempts).toBe(MAX_ATTEMPTS);
    expect(dead.failedAt).not.toBeNull();
    await db.update(emailOutbox).set({ nextAttemptAt: new Date(Date.now() - 1000) });
    expect((await processOutbox({ mailer: failing.mailer })).claimed).toBe(0);

    expect(await requeueEmail(dead.id)).toBe(true);
    const ok = recordingMailer();
    expect((await processOutbox({ mailer: ok.mailer })).sent).toBe(1);
  });

  it("параллельные кроны не отправляют письмо дважды", async () => {
    for (let i = 0; i < 20; i++) await queueEmail(`c${i}@test.kg`, "refund", { number: `PG-${i}`, amountMinor: 1, refundDays: 5 });
    const { mailer, sent } = recordingMailer();
    const slow: Mailer = { send: async (m) => (await new Promise((r) => setTimeout(r, 5)), mailer.send(m)) };
    await Promise.all([processOutbox({ mailer: slow, limit: 15 }), processOutbox({ mailer: slow, limit: 15 }), processOutbox({ mailer: slow })]);
    expect(sent).toHaveLength(20);
    expect(new Set(sent.map((s) => s.to)).size).toBe(20);
  });

  it("sanitizeError вырезает фрагменты письма", () => {
    expect(sanitizeError("bad: ABCDEFGH-1234 rest", "Ваш ключ ABCDEFGH-1234")).toBe("bad: [скрыто] rest");
  });
});

describe("крон /api/cron/send-emails", () => {
  it("без CRON_SECRET — 401, с ним — отправляет", async () => {
    expect((await cronPost(new Request("http://x/api/cron/send-emails", { method: "POST" }))).status).toBe(401);
    expect((await cronGet(new Request("http://x", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
    await queueEmail("d@test.kg", "refund", { number: "PG-3", amountMinor: 1, refundDays: 5 });
    const res = await cronPost(
      new Request("http://x/api/cron/send-emails", { method: "POST", headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: 1 }); // dev-транспорт в тестах
  });
});

describe("шаблоны", () => {
  const samples: { [K in TemplateName]: TemplateData[K] } = {
    orderPaid: { number: "PG-1", totalMinor: 100_00, items: [{ title: "Игра", priceMinor: 100_00 }], keys: [{ title: "Игра", code: "AAA-BBB" }], orderUrl: "https://s/o/1" },
    orderDelivered: { number: "PG-1", items: ["Dota Plus"], note: "готово", orderUrl: "https://s/o/1" },
    tradeSent: { number: "PG-1", itemTitle: "AK-47", tradeHoldDays: 7, orderUrl: "https://s/o/1" },
    deliveryProblem: { number: "PG-1", orderUrl: "https://s/o/1", reviewDays: 5 },
    refund: { number: "PG-1", amountMinor: 100_00, refundDays: 5 },
    loginLink: { link: "https://s/login/email?token=t", purpose: "login" },
    lotSold: { title: "AWP", priceMinor: 1000_00, payoutMinor: 900_00, deadline: new Date(), dealUrl: "https://s/d/1" },
    transferReminder: { title: "AWP", deadline: new Date(), hoursLeft: 1, dealUrl: "https://s/d/1" },
    payoutSent: { amountMinor: 900_00, detailsMasked: "•••• 1234" },
  };

  it.each(Object.keys(samples) as TemplateName[])("%s: тема, текст и HTML", (name) => {
    const r = renderEmail(name, samples[name] as never);
    expect(r.subject.length).toBeGreaterThan(3);
    expect(r.text.length).toBeGreaterThan(10);
    expect(r.html).toMatch(/^<!doctype html>/);
    expect(r.text).not.toContain("undefined");
  });

  it("экранирует данные в HTML", () => {
    const r = renderEmail("orderDelivered", { number: "PG-1", items: ['<script>alert("x")</script>'], orderUrl: "https://s" });
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;");
  });

  it("письмо входа содержит ссылку", async () => {
    await requestEmailLogin("login@test.kg");
    const [row] = await db.select().from(emailOutbox);
    expect(row.template).toBe("loginLink");
    expect(decrypt(row.encryptedHtml!)).toMatch(/href="[^"]+\/login\/email\?token=/);
  });
});
