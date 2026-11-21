ALTER TYPE "public"."trade_offer_status" ADD VALUE 'IN_ESCROW';--> statement-breakpoint
ALTER TABLE "bot_accounts" ADD COLUMN "status" text DEFAULT 'OFFLINE' NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_accounts" ADD COLUMN "last_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bot_accounts" ADD COLUMN "inventory_count" integer;--> statement-breakpoint
ALTER TABLE "trade_offers" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trade_offers" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trade_offers" ADD COLUMN "finished_at" timestamp with time zone;