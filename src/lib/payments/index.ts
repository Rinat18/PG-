import { env } from "@/lib/env";
import { MockElqrProvider } from "./mock-elqr";
import type { PaymentProvider } from "./types";

let provider: PaymentProvider | undefined;

export function getPaymentProvider(name: string = env.PAYMENT_PROVIDER): PaymentProvider {
  if (name !== env.PAYMENT_PROVIDER) throw new Error(`Provider ${name} is not enabled`);
  if (provider) return provider;
  switch (env.PAYMENT_PROVIDER) {
    case "mock": {
      if (!env.MOCK_ELQR_WEBHOOK_SECRET) throw new Error("MOCK_ELQR_WEBHOOK_SECRET is not set");
      provider = new MockElqrProvider(env.MOCK_ELQR_WEBHOOK_SECRET, env.APP_URL);
      return provider;
    }
  }
}

export function getMockProvider(): MockElqrProvider {
  const p = getPaymentProvider();
  if (!(p instanceof MockElqrProvider)) throw new Error("Mock provider is disabled");
  return p;
}

export type { PaymentProvider } from "./types";
