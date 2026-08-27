CREATE TABLE "bucket_group_preferences" (
	"userId" uuid NOT NULL,
	"budgetId" uuid NOT NULL,
	"sectionKey" text NOT NULL,
	"expanded" boolean DEFAULT true NOT NULL,
	CONSTRAINT "bucket_group_preferences_userId_budgetId_sectionKey_pk" PRIMARY KEY("userId","budgetId","sectionKey")
);
--> statement-breakpoint
ALTER TABLE "bucket_group_preferences" ADD CONSTRAINT "bucket_group_preferences_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bucket_group_preferences" ADD CONSTRAINT "bucket_group_preferences_budgetId_budgets_id_fk" FOREIGN KEY ("budgetId") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;