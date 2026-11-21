import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Сервис выплат продавцам. Реальный провайдер подключается после согласования маркетплейс-схемы (план, этап 6);
 * до этого — только mock: деньги никуда не уходят.
 */
export interface PayoutProvider {
  readonly name: string;
  send(input: { payoutId: string; amountMinor: number; details: string; fullName: string }): Promise<{ providerPayoutId: string }>;
}

class MockPayoutProvider implements PayoutProvider {
  readonly name = "mock";
  async send(input: { amountMinor: number; details: string }) {
    if (input.amountMinor <= 0) throw new Error("amount must be positive");
    if (/FAIL/i.test(input.details)) throw new Error("mock: реквизиты отклонены банком"); // для проверки сбоя
    return { providerPayoutId: `mock_payout_${randomUUID()}` };
  }
}

let override: PayoutProvider | null = null;
export function setPayoutProviderForTests(p: PayoutProvider | null) {
  override = p;
}

export function getPayoutProvider(): PayoutProvider {
  if (override) return override;
  if (env.PAYMENT_PROVIDER === "mock") return new MockPayoutProvider();
  throw new Error("Реальный сервис выплат не подключен");
}
