ALTER TABLE "schedule_occurrences" DROP CONSTRAINT "schedule_occurrences_scheduleId_funding_schedules_id_fk";
--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ALTER COLUMN "scheduleId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_scheduleId_funding_schedules_id_fk" FOREIGN KEY ("scheduleId") REFERENCES "public"."funding_schedules"("id") ON DELETE set null ON UPDATE no action;