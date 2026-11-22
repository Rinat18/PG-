CREATE TABLE "market_prices" (
	"game" "game" NOT NULL,
	"market_hash_name" text NOT NULL,
	"price_minor" integer,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_prices_game_market_hash_name_pk" PRIMARY KEY("game","market_hash_name")
);
--> statement-breakpoint
CREATE TABLE "mock_steam_items" (
	"asset_id" text PRIMARY KEY NOT NULL,
	"steam_id" text NOT NULL,
	"app_id" integer NOT NULL,
	"item" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mock_steam_seeded" (
	"key" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_fingerprints" (
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value_hash" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_fingerprints_user_id_kind_value_hash_pk" PRIMARY KEY("user_id","kind","value_hash")
);
--> statement-breakpoint
ALTER TABLE "payouts" DROP CONSTRAINT "payouts_deal_id_unique";--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "dispute_reason" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "status_before_dispute" "deal_status";--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "received_asset_id" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "earning_credited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "payout_error" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "last_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "last_check_error" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "asset_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "buyer_baseline_asset_ids" jsonb;--> statement-breakpoint
ALTER TABLE "seller_profiles" ADD COLUMN "payout_details_hash" text;--> statement-breakpoint
ALTER TABLE "seller_profiles" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "seller_profiles" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "seller_profiles" ADD COLUMN "seller_offer_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_fingerprints" ADD CONSTRAINT "user_fingerprints_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mock_steam_items_owner_idx" ON "mock_steam_items" USING btree ("steam_id","app_id");--> statement-breakpoint
CREATE INDEX "user_fingerprints_value_idx" ON "user_fingerprints" USING btree ("kind","value_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "deals_order_uq" ON "deals" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "deals_status_idx" ON "deals" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "listings_live_asset_uq" ON "listings" USING btree ("game","asset_id") WHERE status in ('ACTIVE', 'RESERVED');--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_live_deal_uq" ON "payouts" USING btree ("deal_id") WHERE status in ('PENDING', 'SENT') and deal_id is not null;