ALTER TABLE "buckets" ADD COLUMN "due_date" date;--> statement-breakpoint
ALTER TABLE "buckets" ADD COLUMN "due_frequency" text;--> statement-breakpoint
ALTER TABLE "buckets" ADD CONSTRAINT "buckets_due_frequency_values" CHECK ("buckets"."due_frequency" IS NULL OR "buckets"."due_frequency" IN ('monthly', 'weekly', 'biweekly', 'quarterly', 'semiannual', 'annual'));--> statement-breakpoint
UPDATE "buckets"
SET "due_frequency" = 'monthly'
WHERE "type" = 'expense'
  AND "due_day" IS NOT NULL;
