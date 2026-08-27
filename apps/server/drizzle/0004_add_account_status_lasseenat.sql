ALTER TABLE "accounts" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "lastSeenAt" timestamp with time zone;--> statement-breakpoint
UPDATE "accounts" SET "status" = 'archived' WHERE "isActive" = false;--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "isActive";
