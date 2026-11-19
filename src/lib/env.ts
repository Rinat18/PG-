import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_URL: z.string().url().default("http://localhost:3000"),
  // 32 байта в base64: openssl rand -base64 32
  DATA_ENCRYPTION_KEY: z.string().min(40),
  PAYMENT_PROVIDER: z.enum(["mock"]).default("mock"),
  MOCK_ELQR_WEBHOOK_SECRET: z.string().min(16).optional(),
  ORDER_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  MAX_ORDERS_PER_EMAIL_PER_HOUR: z.coerce.number().int().positive().default(3),
  REVIEW_THRESHOLD_MINOR: z.coerce.number().int().positive().optional(), // порог ручной проверки [__] сом
  CRON_SECRET: z.string().min(16).optional(),
});

export const env = schema.parse(process.env);
