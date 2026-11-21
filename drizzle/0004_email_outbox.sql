ALTER TABLE "email_outbox" ADD COLUMN "template" text;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "encrypted_html" text;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "email_outbox_pending_idx" ON "email_outbox" USING btree ("sent_at","failed_at","next_attempt_at");