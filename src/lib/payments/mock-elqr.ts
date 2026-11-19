import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { mockProviderPayments } from "@/db/schema";
import type {
  CreateQrInput,
  CreateQrResult,
  PaymentProvider,
  ProviderPaymentStatus,
  WebhookVerification,
} from "./types";

/**
 * Mock-провайдер ELQR для разработки.
 * Повторяет то, что будет у реального провайдера: динамический QR на заказ,
 * срок жизни, webhook с HMAC-подписью и меткой времени, запрос статуса, возврат.
 *
 * Подпись: заголовок x-elqr-signature = hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`)),
 * x-elqr-timestamp = unix-секунды. События старше 5 минут отклоняются (защита от повтора).
 */
export const SIGNATURE_HEADER = "x-elqr-signature";
export const TIMESTAMP_HEADER = "x-elqr-timestamp";
const MAX_SKEW_SECONDS = 300;

export function signMockWebhook(secret: string, rawBody: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function verifyMockSignature(
  secret: string,
  rawBody: string,
  headers: Headers,
  nowSeconds = Math.floor(Date.now() / 1000),
): { ok: true } | { ok: false; reason: string } {
  const signature = headers.get(SIGNATURE_HEADER);
  const tsRaw = headers.get(TIMESTAMP_HEADER);
  if (!signature || !tsRaw) return { ok: false, reason: "missing signature headers" };
  const ts = Number(tsRaw);
  if (!Number.isInteger(ts)) return { ok: false, reason: "bad timestamp" };
  if (Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return { ok: false, reason: "timestamp outside tolerance" };
  const expected = Buffer.from(signMockWebhook(secret, rawBody, ts), "hex");
  let given: Buffer;
  try {
    given = Buffer.from(signature, "hex");
  } catch {
    return { ok: false, reason: "bad signature encoding" };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

type MockWebhookBody = {
  eventId: string;
  paymentId: string;
  status: ProviderPaymentStatus;
  amount: number;
  currency: string;
  occurredAt: string;
};

export class MockElqrProvider implements PaymentProvider {
  readonly name = "mock";
  constructor(
    private readonly secret: string,
    private readonly appUrl: string,
  ) {}

  async createQr(input: CreateQrInput): Promise<CreateQrResult> {
    const id = `mock_${randomUUID()}`;
    await db.insert(mockProviderPayments).values({
      id,
      merchantOrderId: input.orderId,
      amountMinor: input.amountMinor,
      expiresAt: input.expiresAt,
    });
    // Реальный ELQR — строка EMVCo. Здесь условный формат, чтобы QR сканировался и был уникален.
    const qrPayload = `ELQR-MOCK|${id}|${input.amountMinor}|KGS|${input.orderNumber}`;
    const bankUrl = `${this.appUrl}/dev/mock-bank/${id}`;
    return {
      providerPaymentId: id,
      qrPayload,
      deeplinks: [
        { bank: "Тестовый банк", url: bankUrl },
      ],
    };
  }

  async getStatus(providerPaymentId: string): Promise<ProviderPaymentStatus> {
    const [row] = await db.select().from(mockProviderPayments).where(eq(mockProviderPayments.id, providerPaymentId));
    if (!row) throw new Error("mock payment not found");
    if (row.status === "PENDING" && row.expiresAt < new Date()) return "EXPIRED";
    return row.status as ProviderPaymentStatus;
  }

  verifyWebhook(rawBody: string, headers: Headers): WebhookVerification {
    let body: MockWebhookBody;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return { ok: false, reason: "invalid json" };
    }
    const sig = verifyMockSignature(this.secret, rawBody, headers);
    if (!sig.ok) return { ok: false, reason: sig.reason, eventId: body?.eventId };
    if (body.currency !== "KGS") return { ok: false, reason: "unsupported currency", eventId: body.eventId };
    if (!Number.isInteger(body.amount)) return { ok: false, reason: "bad amount", eventId: body.eventId };
    return {
      ok: true,
      event: {
        eventId: body.eventId,
        providerPaymentId: body.paymentId,
        status: body.status,
        amountMinor: body.amount,
        currency: "KGS",
        occurredAt: new Date(body.occurredAt),
      },
    };
  }

  async refund(providerPaymentId: string, amountMinor: number) {
    const [row] = await db.select().from(mockProviderPayments).where(eq(mockProviderPayments.id, providerPaymentId));
    if (!row) throw new Error("mock payment not found");
    if (row.status !== "SUCCEEDED") throw new Error(`cannot refund payment in status ${row.status}`);
    if (amountMinor > row.amountMinor) throw new Error("refund exceeds payment amount");
    await db.update(mockProviderPayments).set({ status: "REFUNDED" }).where(eq(mockProviderPayments.id, providerPaymentId));
    return { providerRefundId: `mock_refund_${randomUUID()}` };
  }

  // ---- только для страницы «тестового банка» ----

  /** Имитация оплаты в банке: меняет статус и отправляет подписанный webhook на сайт. */
  async simulateBankAction(providerPaymentId: string, outcome: "SUCCEEDED" | "FAILED") {
    const [row] = await db.select().from(mockProviderPayments).where(eq(mockProviderPayments.id, providerPaymentId));
    if (!row) throw new Error("mock payment not found");
    if (row.status !== "PENDING") throw new Error(`payment already ${row.status}`);
    // Банк, как и реальный, принимает оплату и после истечения QR — сайт обязан это обработать (возврат).
    await db.update(mockProviderPayments).set({ status: outcome }).where(eq(mockProviderPayments.id, providerPaymentId));
    return this.sendWebhook({
      eventId: `evt_${randomUUID()}`,
      paymentId: providerPaymentId,
      status: outcome,
      amount: row.amountMinor,
      currency: "KGS",
      occurredAt: new Date().toISOString(),
    });
  }

  async sendWebhook(body: MockWebhookBody) {
    const rawBody = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetch(`${this.appUrl}/api/payments/webhook/mock`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signMockWebhook(this.secret, rawBody, ts),
        [TIMESTAMP_HEADER]: String(ts),
      },
      body: rawBody,
    });
    return { status: res.status, text: await res.text(), rawBody };
  }
}
