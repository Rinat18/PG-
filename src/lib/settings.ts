import { inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { env } from "@/lib/env";

/**
 * Параметры, которые в ТЗ помечены [__]: меняются в админке без деплоя.
 * Значения по умолчанию — из env или условные, до утверждения заказчиком.
 */
export const settingsSchema = z.object({
  orderTtlMinutes: z.coerce.number().int().min(5).max(60),
  maxOrdersPerHour: z.coerce.number().int().min(1).max(100),
  reviewThresholdSom: z.coerce.number().int().min(0), // 0 — проверка выключена
  primeEtaHours: z.coerce.number().int().min(0).max(168),
  dotaPlusEtaHours: z.coerce.number().int().min(0).max(168),
  skinEtaMinutes: z.coerce.number().int().min(1).max(1440),
  tradeAcceptHours: z.coerce.number().int().min(1).max(168),
  refundReviewDays: z.coerce.number().int().min(1).max(60),
  p2pCommissionPercent: z.coerce.number().min(0).max(50),
  p2pTransferHours: z.coerce.number().int().min(1).max(168),
  p2pProtectionDays: z.coerce.number().int().min(0).max(30),
  sellerDailyPayoutLimitSom: z.coerce.number().int().min(0), // 0 — без лимита
  sellerMonthlyPayoutLimitSom: z.coerce.number().int().min(0),
});
export type Settings = z.infer<typeof settingsSchema>;

export const settingsDefaults: Settings = {
  orderTtlMinutes: env.ORDER_TTL_MINUTES,
  maxOrdersPerHour: env.MAX_ORDERS_PER_EMAIL_PER_HOUR,
  reviewThresholdSom: env.REVIEW_THRESHOLD_MINOR ? Math.round(env.REVIEW_THRESHOLD_MINOR / 100) : 0,
  primeEtaHours: 24,
  dotaPlusEtaHours: 24,
  skinEtaMinutes: 30,
  tradeAcceptHours: 24,
  refundReviewDays: 5,
  p2pCommissionPercent: 10,
  p2pTransferHours: 12,
  p2pProtectionDays: 7,
  sellerDailyPayoutLimitSom: 0,
  sellerMonthlyPayoutLimitSom: 0,
};

export const settingsLabels: Record<keyof Settings, string> = {
  orderTtlMinutes: "Срок оплаты QR, минут",
  maxOrdersPerHour: "Заказов с одного email/аккаунта в час",
  reviewThresholdSom: "Порог ручной проверки заказа, сом (0 — выкл.)",
  primeEtaHours: "Срок выдачи Prime подарком, часов",
  dotaPlusEtaHours: "Срок выдачи Dota Plus, часов",
  skinEtaMinutes: "Срок отправки трейда скина, минут",
  tradeAcceptHours: "Сколько часов ждать принятия трейда",
  refundReviewDays: "Срок рассмотрения возврата, рабочих дней",
  p2pCommissionPercent: "Комиссия P2P, %",
  p2pTransferHours: "Срок передачи скина продавцом, часов",
  p2pProtectionDays: "Защита от отката (trade protection), дней",
  sellerDailyPayoutLimitSom: "Лимит выплат продавцу в сутки, сом (0 — нет)",
  sellerMonthlyPayoutLimitSom: "Лимит выплат продавцу в месяц, сом (0 — нет)",
};

export async function getSettings(): Promise<Settings> {
  const rows = await db.select().from(settings).where(inArray(settings.key, Object.keys(settingsDefaults)));
  const merged: Record<string, unknown> = { ...settingsDefaults };
  for (const r of rows) merged[r.key] = r.value;
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : settingsDefaults;
}
