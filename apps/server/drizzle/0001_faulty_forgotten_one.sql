ALTER TABLE "buckets" ADD COLUMN "matchMerchants" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "buckets" ADD COLUMN "matchCategories" text[] DEFAULT '{}' NOT NULL;