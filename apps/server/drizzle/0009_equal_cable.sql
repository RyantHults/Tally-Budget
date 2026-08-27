ALTER TABLE "buckets" ADD COLUMN "funding_starts_on" date;--> statement-breakpoint
UPDATE "buckets"
SET "funding_starts_on" = CURRENT_DATE
WHERE "funding_starts_on" IS NULL
  AND (
    ("type" = 'expense' AND "due_day" IS NOT NULL)
    OR ("type" IN ('goal', 'vault') AND "targetDate" IS NOT NULL)
  );
