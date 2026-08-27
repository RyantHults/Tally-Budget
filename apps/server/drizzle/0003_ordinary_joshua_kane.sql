CREATE TABLE "provider_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connectionId" uuid NOT NULL,
	"providerAccountId" text NOT NULL,
	"name" text NOT NULL,
	"inferredType" text NOT NULL,
	"balanceCents" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"linkedAccountId" uuid,
	CONSTRAINT "provider_accounts_conn_provider" UNIQUE("connectionId","providerAccountId")
);
--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_connectionId_connections_id_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_linkedAccountId_accounts_id_fk" FOREIGN KEY ("linkedAccountId") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;