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
  // Подпись cookie сессии: openssl rand -hex 32
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30), // срок жизни сессии [__] дней
  // Ключ Steam Web API (имя и аватар, в этапе 2 — проверки инвентаря): https://steamcommunity.com/dev/apikey
  STEAM_API_KEY: z.string().optional().transform((v) => v || undefined),
  // real — проверки покупателя скина через Steam Web API; mock — без Steam, только для разработки
  STEAM_CHECKS: z.enum(["real", "mock"]).default("real"),
  // Письма: smtp — отправка через SMTP; dev — письма не уходят, их видно на /dev/mail (только с mock-оплатой)
  EMAIL_TRANSPORT: z.enum(["smtp", "dev"]).default("dev"),
  EMAIL_FROM: z.string().default("PlayGround <no-reply@localhost>"),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"), // true — порт 465 (TLS сразу), false — STARTTLS
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
});

export const env = schema
  .refine((e) => e.STEAM_CHECKS === "real" || e.PAYMENT_PROVIDER === "mock", {
    message: "STEAM_CHECKS=mock допустим только с PAYMENT_PROVIDER=mock",
  })
  .refine((e) => e.EMAIL_TRANSPORT === "smtp" || e.PAYMENT_PROVIDER === "mock", {
    message: "EMAIL_TRANSPORT=dev допустим только с PAYMENT_PROVIDER=mock",
  })
  .refine((e) => e.EMAIL_TRANSPORT !== "smtp" || Boolean(e.SMTP_HOST), { message: "Для EMAIL_TRANSPORT=smtp нужен SMTP_HOST" })
  .parse(process.env);
