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
  // Приватное хранилище фото паспорта и селфи продавцов. Файлы шифруются до загрузки.
  // local — папка FILE_STORAGE_DIR (только разработка), s3 — любое S3-совместимое хранилище с закрытым бакетом
  FILE_STORAGE: z.enum(["local", "db", "s3"]).default("local"), // db — в базе, для демо-стенда без диска
  FILE_STORAGE_DIR: z.string().default(".data/private"),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  // Курс для перевода рыночной цены Steam (USD) в сомы при проверке цены лота
  USD_KGS_RATE: z.coerce.number().positive().default(87.5),
  // Демо-стенд для показа клиенту: тестовые роли на /login, тестовый бот и проверка сделок без воркера.
  // Только с PAYMENT_PROVIDER=mock. Пароль на весь сайт — DEMO_PASSWORD (middleware).
  DEMO_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export const env = schema
  .refine((e) => e.STEAM_CHECKS === "real" || e.PAYMENT_PROVIDER === "mock", {
    message: "STEAM_CHECKS=mock допустим только с PAYMENT_PROVIDER=mock",
  })
  .refine((e) => e.EMAIL_TRANSPORT === "smtp" || e.PAYMENT_PROVIDER === "mock", {
    message: "EMAIL_TRANSPORT=dev допустим только с PAYMENT_PROVIDER=mock",
  })
  .refine((e) => e.EMAIL_TRANSPORT !== "smtp" || Boolean(e.SMTP_HOST), { message: "Для EMAIL_TRANSPORT=smtp нужен SMTP_HOST" })
  .refine((e) => e.FILE_STORAGE === "s3" || e.PAYMENT_PROVIDER === "mock", {
    message: "FILE_STORAGE=local и db допустимы только с PAYMENT_PROVIDER=mock: паспорта продавцов — в приватном S3",
  })
  .refine((e) => !e.DEMO_MODE || e.PAYMENT_PROVIDER === "mock", { message: "DEMO_MODE только с PAYMENT_PROVIDER=mock" })
  .refine((e) => e.FILE_STORAGE !== "s3" || Boolean(e.S3_BUCKET && e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY), {
    message: "Для FILE_STORAGE=s3 нужны S3_BUCKET, S3_ACCESS_KEY_ID и S3_SECRET_ACCESS_KEY",
  })
  .parse(process.env);
