/**
 * Контракт платежного провайдера ELQR.
 * Провайдер еще не выбран: сайт работает с этим интерфейсом, а реальный провайдер
 * подключается отдельным адаптером без изменения логики заказов.
 */

export type ProviderPaymentStatus = "PENDING" | "SUCCEEDED" | "FAILED" | "EXPIRED" | "REFUNDED";

export interface CreateQrInput {
  orderId: string;
  orderNumber: string;
  amountMinor: number; // тыйыны, валюта всегда KGS
  expiresAt: Date;
  description: string;
}

export interface CreateQrResult {
  providerPaymentId: string;
  qrPayload: string; // строка, которая кодируется в QR (ELQR / EMVCo)
  deeplinks: { bank: string; url: string }[];
}

/** Нормализованное событие из webhook провайдера. */
export interface PaymentWebhookEvent {
  eventId: string;
  providerPaymentId: string;
  status: ProviderPaymentStatus;
  amountMinor: number;
  currency: "KGS";
  occurredAt: Date;
}

export type WebhookVerification =
  | { ok: true; event: PaymentWebhookEvent }
  | { ok: false; reason: string; eventId?: string };

export interface PaymentProvider {
  readonly name: string;
  createQr(input: CreateQrInput): Promise<CreateQrResult>;
  getStatus(providerPaymentId: string): Promise<ProviderPaymentStatus>;
  /** Проверка подписи и разбор тела. Тело передается сырым, до JSON.parse. */
  verifyWebhook(rawBody: string, headers: Headers): WebhookVerification;
  refund(providerPaymentId: string, amountMinor: number): Promise<{ providerRefundId: string }>;
}
