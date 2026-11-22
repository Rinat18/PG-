CREATE TABLE "private_files" (
	"key" text PRIMARY KEY NOT NULL,
	"data" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
