/**
 * Модель данных магазина ключей и скинов CS2 / Dota 2.
 * Деньги храним в тыйынах (1 сом = 100 тыйын), целым числом. Валюта только KGS.
 * Кейсы, рулетки, внутренний баланс и вывод денег в модели отсутствуют намеренно (ТЗ, раздел 1 и 6).
 */
import {
  pgTable,
  pgEnum,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uuid,
  real,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ---------- Справочники ----------

export const gameEnum = pgEnum("game", ["CS2", "DOTA2", "OTHER"]);

export const productTypeEnum = pgEnum("product_type", [
  "GAME_KEY", // ключ игры или DLC (Steam)
  "CS2_PRIME", // CS2 Prime Status
  "DOTA_PLUS", // Dota Plus, срок в durationMonths
  "SHOP_SKIN", // скин из инвентаря бота магазина, одна карточка = один предмет
]);

export const userRoleEnum = pgEnum("user_role", ["BUYER", "ADMIN", "SUPPORT", "COMPLIANCE"]);

export const orderStatusEnum = pgEnum("order_status", [
  "PENDING_PAYMENT", // Ожидает оплаты
  "PAID", // Оплачен
  "TRADE_SENT", // Трейд отправлен (только скины)
  "DELIVERED", // Выдан
  "PROBLEM", // Проблема
  "REFUNDED", // Возврат
  "CANCELLED", // Отменен (не оплачен за 15 минут)
]);

export const paymentStatusEnum = pgEnum("payment_status", [
  "CREATED", // QR создан, ждем оплату
  "SUCCEEDED",
  "FAILED",
  "EXPIRED",
  "LATE_PAID", // оплата пришла по просроченному/отмененному заказу -> возврат
  "REFUNDED",
]);

export const keyStatusEnum = pgEnum("key_status", ["AVAILABLE", "RESERVED", "ISSUED", "DISABLED"]);

export const deliveryMethodEnum = pgEnum("delivery_method", [
  "KEY", // ключ на экране и в письме
  "STEAM_GIFT", // подарок Steam на аккаунт покупателя
  "TRADE_OFFER", // трейд-оффер от бота
  "MANUAL", // ручная выдача оператором (Dota Plus, пока способ не утвержден)
]);

// P2P
export const verificationStatusEnum = pgEnum("verification_status", [
  "NOT_STARTED",
  "PENDING",
  "APPROVED",
  "REJECTED",
]);
export const listingStatusEnum = pgEnum("listing_status", ["ACTIVE", "RESERVED", "SOLD", "WITHDRAWN", "BLOCKED"]);
export const dealStatusEnum = pgEnum("deal_status", [
  "PAID", // Оплачена
  "AWAITING_TRANSFER", // Ожидает передачи
  "TRANSFERRED", // Передана
  "PROTECTION", // Защита от отката (trade protection)
  "PAID_OUT", // Выплачена
  "DISPUTE", // Спор
  "CANCELLED", // Отменена
  "REVIEW", // На проверке
]);
export const payoutStatusEnum = pgEnum("payout_status", ["PENDING", "SENT", "FAILED", "CANCELLED"]);
export const tradeOfferStatusEnum = pgEnum("trade_offer_status", [
  "QUEUED",
  "SENT",
  "ACCEPTED",
  "DECLINED",
  "FAILED",
  "ROLLED_BACK",
]);

const ts = (name: string) => timestamp(name, { withTimezone: true });

// ---------- Пользователи ----------

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    steamId: text("steam_id"),
    email: text("email"),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    role: userRoleEnum("role").notNull().default("BUYER"),
    emailVerifiedAt: ts("email_verified_at"), // email подтвержден одноразовой ссылкой
    tradeUrl: text("trade_url"),
    isBlocked: boolean("is_blocked").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  // email храним в нижнем регистре; один email — один аккаунт
  (t) => [uniqueIndex("users_steam_id_uq").on(t.steamId), uniqueIndex("users_email_uq").on(t.email)],
);

/**
 * Сессии. В cookie лежит `<token>.<hmac>`, в базе — sha256(token):
 * утечка таблицы не дает войти, подделка cookie отсекается подписью.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(), // sha256(token)
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** Одноразовые ссылки входа по email (15 минут). userId задан, если вошедший пользователь привязывает email. */
export const loginTokens = pgTable(
  "login_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    email: text("email").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    nextPath: text("next_path"),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    ip: text("ip"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("login_tokens_hash_uq").on(t.tokenHash), index("login_tokens_email_idx").on(t.email, t.createdAt)],
);

/** Счетчики ограничения частоты (по IP, email и т. п.) с фиксированным окном. */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowEndsAt: ts("window_ends_at").notNull(),
});

export const botAccounts = pgTable("bot_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  steamId: text("steam_id").notNull().unique(),
  game: gameEnum("game"),
  isActive: boolean("is_active").notNull().default(true),
  lastSyncAt: ts("last_sync_at"),
  lastError: text("last_error"),
});

// ---------- Каталог ----------

/** Атрибуты конкретного скина. Используется и для скинов магазина, и для P2P-лотов. */
export type SkinAttributes = {
  marketHashName: string;
  assetId?: string;
  classId?: string;
  exterior?: string; // Factory New, Minimal Wear ...
  rarity?: string;
  float?: number;
  pattern?: number;
  statTrak?: boolean;
  stickers?: { name: string; slot: number }[];
  weaponOrHero?: string;
};

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    type: productTypeEnum("type").notNull(),
    game: gameEnum("game").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    activationInstructions: text("activation_instructions").notNull().default(""),
    platform: text("platform").notNull().default("Steam"),
    region: text("region"), // регион активации ключа
    durationMonths: integer("duration_months"), // для Dota Plus
    deliveryMethod: deliveryMethodEnum("delivery_method").notNull(),
    deliveryEta: text("delivery_eta").notNull(), // текст для карточки: «Сразу после оплаты», «До [__] часов»
    priceMinor: integer("price_minor").notNull(), // тыйыны
    imageUrl: text("image_url"),
    // для SHOP_SKIN
    skin: jsonb("skin").$type<SkinAttributes>(),
    botAccountId: uuid("bot_account_id").references(() => botAccounts.id),
    reservedByOrderId: uuid("reserved_by_order_id"),
    reservedUntil: ts("reserved_until"),
    soldAt: ts("sold_at"),
    // общее
    isActive: boolean("is_active").notNull().default(true),
    popularity: integer("popularity").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("products_slug_uq").on(t.slug),
    index("products_game_type_idx").on(t.game, t.type),
  ],
);

/** Ключи активации: хранятся зашифрованными (AES-256-GCM), см. src/lib/crypto.ts */
export const productKeys = pgTable(
  "product_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    encryptedCode: text("encrypted_code").notNull(),
    codeHash: text("code_hash").notNull(), // sha256 для защиты от дублей при загрузке CSV
    status: keyStatusEnum("status").notNull().default("AVAILABLE"),
    orderItemId: uuid("order_item_id"),
    reservedUntil: ts("reserved_until"),
    issuedAt: ts("issued_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("product_keys_hash_uq").on(t.codeHash),
    index("product_keys_product_status_idx").on(t.productId, t.status),
  ],
);

// ---------- Заказы и оплата ----------

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: text("number").notNull(), // человекочитаемый номер, уходит в QR и в письмо
    accessToken: text("access_token").notNull(), // ссылка на заказ для гостя
    userId: uuid("user_id").references(() => users.id),
    email: text("email").notNull(),
    tradeUrl: text("trade_url"),
    tradeHoldDays: integer("trade_hold_days"), // задержка обмена Steam на момент заказа (скины)
    status: orderStatusEnum("status").notNull().default("PENDING_PAYMENT"),
    totalMinor: integer("total_minor").notNull(),
    adultConfirmed: boolean("adult_confirmed").notNull(),
    offerAccepted: boolean("offer_accepted").notNull(),
    clientIp: text("client_ip"),
    needsReview: boolean("needs_review").notNull().default(false),
    problemReason: text("problem_reason"),
    expiresAt: ts("expires_at").notNull(),
    paidAt: ts("paid_at"),
    deliveredAt: ts("delivered_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("orders_number_uq").on(t.number),
    uniqueIndex("orders_access_token_uq").on(t.accessToken),
    index("orders_email_created_idx").on(t.email, t.createdAt),
    index("orders_status_expires_idx").on(t.status, t.expiresAt),
  ],
);

export const orderItems = pgTable("order_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id),
  productId: uuid("product_id").references(() => products.id),
  listingId: uuid("listing_id"), // P2P-лот
  titleSnapshot: text("title_snapshot").notNull(),
  typeSnapshot: productTypeEnum("type_snapshot"),
  deliveryMethod: deliveryMethodEnum("delivery_method").notNull(),
  priceMinor: integer("price_minor").notNull(),
  quantity: integer("quantity").notNull().default(1),
});

/** Один заказ = один платеж (ТЗ, раздел 5). */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    provider: text("provider").notNull(),
    providerPaymentId: text("provider_payment_id").notNull(),
    qrPayload: text("qr_payload").notNull(),
    deeplinks: jsonb("deeplinks").$type<{ bank: string; url: string }[]>().notNull().default([]),
    amountMinor: integer("amount_minor").notNull(),
    status: paymentStatusEnum("status").notNull().default("CREATED"),
    expiresAt: ts("expires_at").notNull(),
    paidAt: ts("paid_at"),
    lastStatusCheckAt: ts("last_status_check_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payments_order_uq").on(t.orderId),
    uniqueIndex("payments_provider_pid_uq").on(t.provider, t.providerPaymentId),
  ],
);

/** Журнал всех входящих колбэков, включая отклоненные по подписи (ТЗ, раздел 7). */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    eventId: text("event_id"),
    signatureValid: boolean("signature_valid").notNull(),
    rawBody: text("raw_body").notNull(),
    headers: jsonb("headers").$type<Record<string, string>>().notNull(),
    result: text("result"),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
  },
  (t) => [uniqueIndex("webhook_events_provider_event_uq").on(t.provider, t.eventId)],
);

export const refunds = pgTable("refunds", {
  id: uuid("id").primaryKey().defaultRandom(),
  paymentId: uuid("payment_id")
    .notNull()
    .references(() => payments.id),
  amountMinor: integer("amount_minor").notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("PENDING"), // PENDING | PROCESSING | DONE | FAILED
  requestedBy: text("requested_by"), // system | admin:<id>
  attempts: integer("attempts").notNull().default(0),
  providerRefundId: text("provider_refund_id"),
  error: text("error"),
  createdAt: ts("created_at").notNull().defaultNow(),
  doneAt: ts("done_at"),
});

/** Очередь трейд-офферов для воркера ботов (этап 3). */
export const tradeOffers = pgTable("trade_offers", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderItemId: uuid("order_item_id")
    .notNull()
    .references(() => orderItems.id),
  botAccountId: uuid("bot_account_id").references(() => botAccounts.id),
  steamOfferId: text("steam_offer_id"),
  tradeUrl: text("trade_url").notNull(),
  status: tradeOfferStatusEnum("status").notNull().default("QUEUED"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/**
 * Исходящие письма. Пока без SMTP: пишем в таблицу, отправку подключим позже.
 * Тело шифруется, потому что в письме может быть ключ активации.
 */
export const emailOutbox = pgTable("email_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  to: text("to").notNull(),
  subject: text("subject").notNull(),
  encryptedBody: text("encrypted_body").notNull(),
  sentAt: ts("sent_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// ---------- P2P-маркет (раздел 5.1, этап 4) ----------

export const sellerProfiles = pgTable("seller_profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  verificationStatus: verificationStatusEnum("verification_status").notNull().default("NOT_STARTED"),
  // персональные данные шифруются, доступ только у роли COMPLIANCE
  encryptedFullName: text("encrypted_full_name"),
  encryptedBirthDate: text("encrypted_birth_date"),
  encryptedPassport: text("encrypted_passport"),
  passportPhotoKey: text("passport_photo_key"),
  selfiePhotoKey: text("selfie_photo_key"),
  phone: text("phone"),
  encryptedPayoutDetails: text("encrypted_payout_details"), // реквизиты на имя самого продавца
  dailyLimitMinor: integer("daily_limit_minor"), // [__] сом в сутки
  monthlyLimitMinor: integer("monthly_limit_minor"), // [__] сом в месяц
  rating: real("rating"),
  verifiedAt: ts("verified_at"),
  rejectionReason: text("rejection_reason"),
});

export const listings = pgTable(
  "listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => users.id),
    game: gameEnum("game").notNull(),
    title: text("title").notNull(),
    skin: jsonb("skin").$type<SkinAttributes>().notNull(),
    imageUrl: text("image_url"),
    priceMinor: integer("price_minor").notNull(),
    marketPriceMinor: integer("market_price_minor"), // для контроля отклонения ±[30] %
    status: listingStatusEnum("status").notNull().default("ACTIVE"),
    reservedByOrderId: uuid("reserved_by_order_id"),
    reservedUntil: ts("reserved_until"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("listings_game_status_idx").on(t.game, t.status)],
);

export const deals = pgTable("deals", {
  id: uuid("id").primaryKey().defaultRandom(),
  listingId: uuid("listing_id")
    .notNull()
    .references(() => listings.id),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id),
  sellerId: uuid("seller_id")
    .notNull()
    .references(() => users.id),
  buyerId: uuid("buyer_id").references(() => users.id),
  status: dealStatusEnum("status").notNull().default("PAID"),
  priceMinor: integer("price_minor").notNull(),
  commissionMinor: integer("commission_minor").notNull(), // комиссия площадки [__] %
  transferDeadline: ts("transfer_deadline"), // [__] часов на передачу
  transferredAt: ts("transferred_at"),
  protectionUntil: ts("protection_until"), // trade protection [__] дней
  reviewReason: text("review_reason"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** Выплата продавцу с его баланса на реквизиты, указанные при верификации. dealId — если выплата по одной сделке. */
export const payouts = pgTable("payouts", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id")
    .references(() => deals.id)
    .unique(),
  sellerId: uuid("seller_id")
    .notNull()
    .references(() => users.id),
  amountMinor: integer("amount_minor").notNull(),
  status: payoutStatusEnum("status").notNull().default("PENDING"),
  providerPayoutId: text("provider_payout_id"),
  error: text("error"),
  requestedBy: text("requested_by"), // admin:<id>
  createdAt: ts("created_at").notNull().defaultNow(),
  sentAt: ts("sent_at"),
});

/**
 * Баланс продавца P2P = сумма проводок. Пополнить баланс деньгами нельзя (ТЗ, разделы 1 и 6):
 * плюс дают только заработок по сделке и корректировка администратора с причиной, минус — выплата.
 */
export const balanceEntryKindEnum = pgEnum("balance_entry_kind", [
  "DEAL_EARNING", // цена сделки минус комиссия, после защиты от отката
  "ADJUSTMENT", // ручная корректировка администратора (+/-), причина обязательна
  "PAYOUT", // выплата на реквизиты (минус)
  "PAYOUT_REVERSAL", // выплата не прошла — деньги возвращаются на баланс
]);

export const balanceEntries = pgTable(
  "balance_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => users.id),
    kind: balanceEntryKindEnum("kind").notNull(),
    amountMinor: integer("amount_minor").notNull(), // со знаком
    dealId: uuid("deal_id").references(() => deals.id),
    payoutId: uuid("payout_id").references(() => payouts.id),
    reason: text("reason"),
    actor: text("actor").notNull(), // system | admin:<id>
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("balance_entries_seller_idx").on(t.sellerId, t.createdAt)],
);

/** Настройки магазина, которые меняются из админки без деплоя. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// ---------- Аудит ----------

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  actor: text("actor").notNull(), // system | user:<id> | admin:<id>
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  data: jsonb("data"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// ---------- Только для разработки: «банк» mock-провайдера ELQR ----------

export const mockProviderPayments = pgTable("mock_provider_payments", {
  id: text("id").primaryKey(),
  merchantOrderId: text("merchant_order_id").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  status: text("status").notNull().default("PENDING"), // PENDING | SUCCEEDED | FAILED | EXPIRED | REFUNDED
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});
