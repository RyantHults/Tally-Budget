CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"budgetId" uuid NOT NULL,
	"connectionId" uuid,
	"providerAccountId" text,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"isActive" boolean DEFAULT true NOT NULL,
	"reportedBalanceCents" integer DEFAULT 0 NOT NULL,
	"availableBalanceCents" integer,
	"reportedBalanceDate" timestamp with time zone,
	"currency" text DEFAULT 'USD' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "balance_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"accountId" uuid NOT NULL,
	"date" date NOT NULL,
	"reportedBalanceCents" integer NOT NULL,
	CONSTRAINT "balance_snapshots_account_date" UNIQUE("accountId","date")
);
--> statement-breakpoint
CREATE TABLE "bucket_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"budgetId" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#2563eb' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"budgetId" uuid NOT NULL,
	"bucketGroupId" uuid,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"targetAmountCents" integer NOT NULL,
	"targetDate" date,
	"fundingMode" text,
	"fundingScheduleId" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"budgetId" uuid NOT NULL,
	"userId" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	CONSTRAINT "budget_members_budget_user" UNIQUE("budgetId","userId")
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "categories_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "category_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"providerName" text NOT NULL,
	"rawValue" text NOT NULL,
	"categoryId" uuid NOT NULL,
	CONSTRAINT "category_mappings_provider_raw" UNIQUE("providerName","rawValue")
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"providerName" text NOT NULL,
	"providerConnectionId" text NOT NULL,
	"orgName" text,
	"status" text DEFAULT 'active' NOT NULL,
	"lastSyncAt" timestamp with time zone,
	CONSTRAINT "connections_provider_conn" UNIQUE("providerName","providerConnectionId")
);
--> statement-breakpoint
CREATE TABLE "credit_card_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"accountId" uuid NOT NULL,
	"mode" text NOT NULL,
	"payoffBucketId" uuid NOT NULL,
	CONSTRAINT "credit_card_configs_accountId_unique" UNIQUE("accountId")
);
--> statement-breakpoint
CREATE TABLE "funding_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"budgetId" uuid NOT NULL,
	"name" text NOT NULL,
	"recurrenceRule" text NOT NULL,
	"anchorDate" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"budgetId" uuid NOT NULL,
	"bucketId" uuid,
	"kind" text NOT NULL,
	"amountCents" integer NOT NULL,
	"sourceType" text NOT NULL,
	"sourceId" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_source" UNIQUE("sourceType","sourceId","kind")
);
--> statement-breakpoint
CREATE TABLE "provider_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"providerName" text NOT NULL,
	"encryptedPayload" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_credentials_providerName_unique" UNIQUE("providerName")
);
--> statement-breakpoint
CREATE TABLE "schedule_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucketId" uuid NOT NULL,
	"scheduleId" uuid NOT NULL,
	"dueDate" date NOT NULL,
	"amountCents" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"appliedAt" timestamp with time zone,
	CONSTRAINT "schedule_occurrences_bucket_due" UNIQUE("bucketId","dueDate")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"tokenHash" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_tokenHash_unique" UNIQUE("tokenHash")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"accountId" uuid NOT NULL,
	"providerTransactionId" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"supersedesPendingId" uuid,
	"amountCents" integer NOT NULL,
	"postedAt" timestamp with time zone NOT NULL,
	"transactedAt" timestamp with time zone,
	"merchantDescription" text NOT NULL,
	"rawCategory" text,
	"categoryId" uuid,
	"bucketId" uuid,
	"transferLinkId" uuid,
	CONSTRAINT "transactions_account_provider" UNIQUE("accountId","providerTransactionId")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"passwordHash" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_budgetId_budgets_id_fk" FOREIGN KEY ("budgetId") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_connectionId_connections_id_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_accountId_accounts_id_fk" FOREIGN KEY ("accountId") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bucket_groups" ADD CONSTRAINT "bucket_groups_budgetId_budgets_id_fk" FOREIGN KEY ("budgetId") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buckets" ADD CONSTRAINT "buckets_budgetId_budgets_id_fk" FOREIGN KEY ("budgetId") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buckets" ADD CONSTRAINT "buckets_bucketGroupId_bucket_groups_id_fk" FOREIGN KEY ("bucketGroupId") REFERENCES "public"."bucket_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_members" ADD CONSTRAINT "budget_members_budgetId_budgets_id_fk" FOREIGN KEY ("budgetId") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_members" ADD CONSTRAINT "budget_members_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_mappings" ADD CONSTRAINT "category_mappings_categoryId_categories_id_fk" FOREIGN KEY ("categoryId") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_configs" ADD CONSTRAINT "credit_card_configs_accountId_accounts_id_fk" FOREIGN KEY ("accountId") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_card_configs" ADD CONSTRAINT "credit_card_configs_payoffBucketId_buckets_id_fk" FOREIGN KEY ("payoffBucketId") REFERENCES "public"."buckets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_schedules" ADD CONSTRAINT "funding_schedules_budgetId_budgets_id_fk" FOREIGN KEY ("budgetId") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_budgetId_budgets_id_fk" FOREIGN KEY ("budgetId") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_bucketId_buckets_id_fk" FOREIGN KEY ("bucketId") REFERENCES "public"."buckets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_bucketId_buckets_id_fk" FOREIGN KEY ("bucketId") REFERENCES "public"."buckets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_scheduleId_funding_schedules_id_fk" FOREIGN KEY ("scheduleId") REFERENCES "public"."funding_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_accountId_accounts_id_fk" FOREIGN KEY ("accountId") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_categoryId_categories_id_fk" FOREIGN KEY ("categoryId") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_bucketId_buckets_id_fk" FOREIGN KEY ("bucketId") REFERENCES "public"."buckets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_budget_idx" ON "accounts" USING btree ("budgetId");--> statement-breakpoint
CREATE INDEX "buckets_budget_idx" ON "buckets" USING btree ("budgetId");--> statement-breakpoint
CREATE INDEX "ledger_entries_bucket_idx" ON "ledger_entries" USING btree ("bucketId");--> statement-breakpoint
CREATE INDEX "ledger_entries_budget_idx" ON "ledger_entries" USING btree ("budgetId");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "transactions_account_idx" ON "transactions" USING btree ("accountId");--> statement-breakpoint
CREATE INDEX "transactions_status_idx" ON "transactions" USING btree ("status");