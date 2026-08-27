ALTER TABLE "bucket_groups" ADD COLUMN "sort_order" integer;--> statement-breakpoint
WITH ordered_groups AS (
	SELECT
		"id",
		(ROW_NUMBER() OVER (PARTITION BY "budgetId" ORDER BY "name" ASC, "id" ASC) - 1)::integer AS "sort_order"
	FROM "bucket_groups"
)
UPDATE "bucket_groups" AS bg
SET "sort_order" = ordered_groups."sort_order"
FROM ordered_groups
WHERE bg."id" = ordered_groups."id";--> statement-breakpoint
ALTER TABLE "bucket_groups" ALTER COLUMN "sort_order" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "bucket_groups" ALTER COLUMN "sort_order" SET NOT NULL;
