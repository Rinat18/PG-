CREATE TYPE "public"."deal_status" AS ENUM('PAID', 'AWAITING_TRANSFER', 'TRANSFERRED', 'PROTECTION', 'PAID_OUT', 'DISPUTE', 'CANCELLED', 'REVIEW');--> statement-breakpoint
CREATE TYPE "public"."delivery_method" AS ENUM('KEY', 'STEAM_GIFT', 'TRADE_OFFER', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."game" AS ENUM('CS2', 'DOTA2', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."key_status" AS ENUM('AVAILABLE', 'RESERVED', 'ISSUED', 'DISABLED');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('ACTIVE', 'RESERVED', 'SOLD', 'WITHDRAWN', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('PENDING_PAYMENT', 'PAID', 'TRADE_SENT', 'DELIVERED', 'PROBLEM', 'REFUNDED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('CREATED', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'LATE_PAID', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('PENDING', 'SENT', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."product_type" AS ENUM('GAME_KEY', 'CS2_PRIME', 'DOTA_PLUS', 'SHOP_SKIN');--> statement-breakpoint
CREATE TYPE "public"."trade_offer_status" AS ENUM('QUEUED', 'SENT', 'ACCEPTED', 'DECLINED', 'FAILED', 'ROLLED_BACK');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('BUYER', 'ADMIN', 'SUPPORT', 'COMPLIANCE');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('NOT_STARTED', 'PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"steam_id" text NOT NULL,
	"game" "game",
	"is_active" boolean DEFAULT true NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "bot_accounts_steam_id_unique" UNIQUE("steam_id")
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"buyer_id" uuid,
	"status" "deal_status" DEFAULT 'PAID' NOT NULL,
	"price_minor" integer NOT NULL,
	"commission_minor" integer NOT NULL,
	"transfer_deadline" timestamp with time zone,
	"transferred_at" timestamp with time zone,
	"protection_until" timestamp with time zone,
	"review_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"to" text NOT NULL,
	"subject" text NOT NULL,
	"encrypted_body" text NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"game" "game" NOT NULL,
	"title" text NOT NULL,
	"skin" jsonb NOT NULL,
	"image_url" text,
	"price_minor" integer NOT NULL,
	"market_price_minor" integer,
	"status" "listing_status" DEFAULT 'ACTIVE' NOT NULL,
	"reserved_by_order_id" uuid,
	"reserved_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mock_provider_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_order_id" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid,
	"listing_id" uuid,
	"title_snapshot" text NOT NULL,
	"type_snapshot" "product_type",
	"delivery_method" "delivery_method" NOT NULL,
	"price_minor" integer NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"access_token" text NOT NULL,
	"user_id" uuid,
	"email" text NOT NULL,
	"trade_url" text,
	"status" "order_status" DEFAULT 'PENDING_PAYMENT' NOT NULL,
	"total_minor" integer NOT NULL,
	"adult_confirmed" boolean NOT NULL,
	"offer_accepted" boolean NOT NULL,
	"client_ip" text,
	"needs_review" boolean DEFAULT false NOT NULL,
	"problem_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_payment_id" text NOT NULL,
	"qr_payload" text NOT NULL,
	"deeplinks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"amount_minor" integer NOT NULL,
	"status" "payment_status" DEFAULT 'CREATED' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"last_status_check_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"amount_minor" integer NOT NULL,
	"status" "payout_status" DEFAULT 'PENDING' NOT NULL,
	"provider_payout_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "payouts_deal_id_unique" UNIQUE("deal_id")
);
--> statement-breakpoint
CREATE TABLE "product_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"encrypted_code" text NOT NULL,
	"code_hash" text NOT NULL,
	"status" "key_status" DEFAULT 'AVAILABLE' NOT NULL,
	"order_item_id" uuid,
	"reserved_until" timestamp with time zone,
	"issued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"type" "product_type" NOT NULL,
	"game" "game" NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"activation_instructions" text DEFAULT '' NOT NULL,
	"platform" text DEFAULT 'Steam' NOT NULL,
	"region" text,
	"duration_months" integer,
	"delivery_method" "delivery_method" NOT NULL,
	"delivery_eta" text NOT NULL,
	"price_minor" integer NOT NULL,
	"image_url" text,
	"skin" jsonb,
	"bot_account_id" uuid,
	"reserved_by_order_id" uuid,
	"reserved_until" timestamp with time zone,
	"sold_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"popularity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_minor" integer NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"provider_refund_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "seller_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"verification_status" "verification_status" DEFAULT 'NOT_STARTED' NOT NULL,
	"encrypted_full_name" text,
	"encrypted_birth_date" text,
	"encrypted_passport" text,
	"passport_photo_key" text,
	"selfie_photo_key" text,
	"phone" text,
	"encrypted_payout_details" text,
	"daily_limit_minor" integer,
	"monthly_limit_minor" integer,
	"rating" real,
	"verified_at" timestamp with time zone,
	"rejection_reason" text
);
--> statement-breakpoint
CREATE TABLE "trade_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_item_id" uuid NOT NULL,
	"bot_account_id" uuid,
	"steam_offer_id" text,
	"trade_url" text NOT NULL,
	"status" "trade_offer_status" DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"steam_id" text,
	"email" text,
	"display_name" text,
	"avatar_url" text,
	"role" "user_role" DEFAULT 'BUYER' NOT NULL,
	"trade_url" text,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text,
	"signature_valid" boolean NOT NULL,
	"raw_body" text NOT NULL,
	"headers" jsonb NOT NULL,
	"result" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_keys" ADD CONSTRAINT "product_keys_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_bot_account_id_bot_accounts_id_fk" FOREIGN KEY ("bot_account_id") REFERENCES "public"."bot_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_profiles" ADD CONSTRAINT "seller_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_offers" ADD CONSTRAINT "trade_offers_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_offers" ADD CONSTRAINT "trade_offers_bot_account_id_bot_accounts_id_fk" FOREIGN KEY ("bot_account_id") REFERENCES "public"."bot_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listings_game_status_idx" ON "listings" USING btree ("game","status");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_number_uq" ON "orders" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_access_token_uq" ON "orders" USING btree ("access_token");--> statement-breakpoint
CREATE INDEX "orders_email_created_idx" ON "orders" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "orders_status_expires_idx" ON "orders" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_order_uq" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_pid_uq" ON "payments" USING btree ("provider","provider_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_keys_hash_uq" ON "product_keys" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "product_keys_product_status_idx" ON "product_keys" USING btree ("product_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "products_slug_uq" ON "products" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "products_game_type_idx" ON "products" USING btree ("game","type");--> statement-breakpoint
CREATE UNIQUE INDEX "users_steam_id_uq" ON "users" USING btree ("steam_id");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_uq" ON "webhook_events" USING btree ("provider","event_id");