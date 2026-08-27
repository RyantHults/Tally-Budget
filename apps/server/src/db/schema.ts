import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  date,
  timestamp,
  unique,
  index,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type {
  AccountType,
  BucketType,
  FundingMode,
  LedgerEntryKind,
  LedgerSourceType,
  MemberRole,
  OccurrenceStatus,
  TransactionStatus,
  CreditCardMode,
} from '@tally/core'

// Money columns are integer cents everywhere. Enum-ish columns are text typed
// via $type<>() to keep migrations simple; validity is enforced at the zod boundary.

export const users = pgTable('users', {
  id: uuid().defaultRandom().primaryKey(),
  email: text().notNull().unique(),
  passwordHash: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

export const sessions = pgTable(
  'sessions',
  {
    id: uuid().defaultRandom().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
)

export const budgets = pgTable('budgets', {
  id: uuid().defaultRandom().primaryKey(),
  name: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

export const budgetMembers = pgTable(
  'budget_members',
  {
    id: uuid().defaultRandom().primaryKey(),
    budgetId: uuid()
      .notNull()
      .references(() => budgets.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text().$type<MemberRole>().notNull().default('member'),
  },
  (t) => [unique('budget_members_budget_user').on(t.budgetId, t.userId)],
)

export const categories = pgTable('categories', {
  id: uuid().defaultRandom().primaryKey(),
  name: text().notNull().unique(),
})

export const categoryMappings = pgTable(
  'category_mappings',
  {
    id: uuid().defaultRandom().primaryKey(),
    providerName: text().notNull(),
    rawValue: text().notNull(),
    categoryId: uuid()
      .notNull()
      .references(() => categories.id),
  },
  (t) => [unique('category_mappings_provider_raw').on(t.providerName, t.rawValue)],
)

/** Instance-level (installation-wide) provider credentials, encrypted at rest. */
export const providerCredentials = pgTable('provider_credentials', {
  id: uuid().defaultRandom().primaryKey(),
  providerName: text().notNull().unique(),
  encryptedPayload: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

export const connections = pgTable(
  'connections',
  {
    id: uuid().defaultRandom().primaryKey(),
    providerName: text().notNull(),
    providerConnectionId: text().notNull(),
    orgName: text(),
    status: text().$type<'active' | 'error' | 'disconnected'>().notNull().default('active'),
    lastSyncAt: timestamp({ withTimezone: true }),
  },
  (t) => [unique('connections_provider_conn').on(t.providerName, t.providerConnectionId)],
)

/**
 * Discovered provider-side accounts (e.g. everything behind a SimpleFin access
 * URL), independent of whether we created a local Account row for them yet.
 * Linking = creating/reusing an Account row and setting linkedAccountId.
 */
export const providerAccounts = pgTable(
  'provider_accounts',
  {
    id: uuid().defaultRandom().primaryKey(),
    connectionId: uuid()
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    providerAccountId: text().notNull(),
    name: text().notNull(),
    inferredType: text().$type<AccountType>().notNull(),
    balanceCents: integer().notNull().default(0),
    currency: text().notNull().default('USD'),
    linkedAccountId: uuid().references(() => accounts.id, { onDelete: 'set null' }),
  },
  (t) => [unique('provider_accounts_conn_provider').on(t.connectionId, t.providerAccountId)],
)

export const accounts = pgTable(
  'accounts',
  {
    id: uuid().defaultRandom().primaryKey(),
    budgetId: uuid()
      .notNull()
      .references(() => budgets.id, { onDelete: 'cascade' }),
    connectionId: uuid().references(() => connections.id, { onDelete: 'set null' }),
    providerAccountId: text(),
    type: text().$type<AccountType>().notNull(),
    name: text().notNull(),
    status: text().$type<'active' | 'archived'>().notNull().default('active'),
    lastSeenAt: timestamp({ withTimezone: true }),
    reportedBalanceCents: integer().notNull().default(0),
    availableBalanceCents: integer(),
    reportedBalanceDate: timestamp({ withTimezone: true }),
    currency: text().notNull().default('USD'),
  },
  (t) => [index('accounts_budget_idx').on(t.budgetId)],
)

export const balanceSnapshots = pgTable(
  'balance_snapshots',
  {
    id: uuid().defaultRandom().primaryKey(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    date: date().notNull(),
    reportedBalanceCents: integer().notNull(),
  },
  (t) => [unique('balance_snapshots_account_date').on(t.accountId, t.date)],
)

export const bucketGroups = pgTable('bucket_groups', {
  id: uuid().defaultRandom().primaryKey(),
  budgetId: uuid()
    .notNull()
    .references(() => budgets.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  color: text().notNull().default('#2563eb'),
  sortOrder: integer('sort_order').notNull().default(0),
})

export const bucketGroupPreferences = pgTable(
  'bucket_group_preferences',
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    budgetId: uuid()
      .notNull()
      .references(() => budgets.id, { onDelete: 'cascade' }),
    sectionKey: text().notNull(),
    expanded: boolean().notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.userId, t.budgetId, t.sectionKey] })],
)

export const buckets = pgTable(
  'buckets',
  {
    id: uuid().defaultRandom().primaryKey(),
    budgetId: uuid()
      .notNull()
      .references(() => budgets.id, { onDelete: 'cascade' }),
    bucketGroupId: uuid().references(() => bucketGroups.id, { onDelete: 'set null' }),
    type: text().$type<BucketType>().notNull(),
    name: text().notNull(),
    targetAmountCents: integer().notNull(),
    dueDay: integer('due_day'),
    dueDate: date('due_date'),
    dueFrequency: text('due_frequency').$type<
      'monthly' | 'weekly' | 'biweekly' | 'quarterly' | 'semiannual' | 'annual'
    >(),
    fundingStartsOn: date('funding_starts_on'),
    targetDate: date(),
    fundingMode: text().$type<FundingMode>(),
    fundingScheduleId: uuid(),
    // Auto-spend match rules (plan §4 step 5): merchant tokens matched against
    // description tokens; category NAMES resolved to ids at match time.
    matchMerchants: text().array().notNull().default([]),
    matchCategories: text().array().notNull().default([]),
    version: integer().notNull().default(1),
  },
  (t) => [
    index('buckets_budget_idx').on(t.budgetId),
    check('buckets_due_day_range', sql`${t.dueDay} IS NULL OR ${t.dueDay} BETWEEN 1 AND 31`),
    check(
      'buckets_due_frequency_values',
      sql`${t.dueFrequency} IS NULL OR ${t.dueFrequency} IN ('monthly', 'weekly', 'biweekly', 'quarterly', 'semiannual', 'annual')`,
    ),
  ],
)

export const fundingSchedules = pgTable('funding_schedules', {
  id: uuid().defaultRandom().primaryKey(),
  budgetId: uuid()
    .notNull()
    .references(() => budgets.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  recurrenceRule: text().notNull(),
  anchorDate: date().notNull(),
})

export const scheduleOccurrences = pgTable(
  'schedule_occurrences',
  {
    id: uuid().defaultRandom().primaryKey(),
    bucketId: uuid()
      .notNull()
      .references(() => buckets.id, { onDelete: 'cascade' }),
    scheduleId: uuid()
      .references(() => fundingSchedules.id, { onDelete: 'set null' }),
    dueDate: date().notNull(),
    amountCents: integer().notNull(),
    status: text().$type<OccurrenceStatus>().notNull().default('pending'),
    appliedAt: timestamp({ withTimezone: true }),
  },
  // Idempotency backbone: a re-run can never double-fund the same tick.
  (t) => [unique('schedule_occurrences_bucket_due').on(t.bucketId, t.dueDate)],
)

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid().defaultRandom().primaryKey(),
    budgetId: uuid()
      .notNull()
      .references(() => budgets.id, { onDelete: 'cascade' }),
    /** null = the FTS side of an entry */
    bucketId: uuid().references(() => buckets.id, { onDelete: 'set null' }),
    kind: text().$type<LedgerEntryKind>().notNull(),
    /** Signed: positive adds to the bucket/FTS, negative removes. */
    amountCents: integer().notNull(),
    sourceType: text().$type<LedgerSourceType>().notNull(),
    sourceId: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One transaction may produce multiple entries (drawdown + payoff sweep),
    // so uniqueness includes kind.
    unique('ledger_entries_source').on(t.sourceType, t.sourceId, t.kind),
    index('ledger_entries_bucket_idx').on(t.bucketId),
    index('ledger_entries_budget_idx').on(t.budgetId),
  ],
)

export const transactions = pgTable(
  'transactions',
  {
    id: uuid().defaultRandom().primaryKey(),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    providerTransactionId: text().notNull(),
    status: text().$type<TransactionStatus>().notNull().default('pending'),
    supersedesPendingId: uuid(),
    amountCents: integer().notNull(),
    postedAt: timestamp({ withTimezone: true }).notNull(),
    transactedAt: timestamp({ withTimezone: true }),
    merchantDescription: text().notNull(),
    rawCategory: text(),
    categoryId: uuid().references(() => categories.id, { onDelete: 'set null' }),
    bucketId: uuid().references(() => buckets.id, { onDelete: 'set null' }),
    transferLinkId: uuid(),
    /** Phase 3: non-payment credits on configured cards are flagged for review. */
    needsReview: boolean().notNull().default(false),
  },
  (t) => [
    unique('transactions_account_provider').on(t.accountId, t.providerTransactionId),
    index('transactions_account_idx').on(t.accountId),
    index('transactions_status_idx').on(t.status),
  ],
)

export const creditCardConfigs = pgTable('credit_card_configs', {
  id: uuid().defaultRandom().primaryKey(),
  accountId: uuid()
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' })
    .unique(),
  mode: text().$type<CreditCardMode>().notNull(),
  payoffBucketId: uuid()
    .notNull()
    .references(() => buckets.id, { onDelete: 'restrict' }),
})
