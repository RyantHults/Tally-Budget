import { z } from 'zod'

// ---- Enums (mirror the plan's §3 data model) ----

export const AccountType = z.enum(['checking', 'savings', 'cd', 'credit_card'])
export type AccountType = z.infer<typeof AccountType>

export const BucketType = z.enum(['expense', 'goal', 'vault'])
export type BucketType = z.infer<typeof BucketType>

export const ExpenseDueFrequency = z.enum([
  'monthly',
  'weekly',
  'biweekly',
  'quarterly',
  'semiannual',
  'annual',
])
export type ExpenseDueFrequency = z.infer<typeof ExpenseDueFrequency>

export const FundingMode = z.enum(['set_aside', 'reach_target'])
export type FundingMode = z.infer<typeof FundingMode>

export const OccurrenceStatus = z.enum(['pending', 'applied', 'skipped'])
export type OccurrenceStatus = z.infer<typeof OccurrenceStatus>

export const LedgerEntryKind = z.enum([
  'funding',
  'spend',
  'transfer_in',
  'transfer_out',
  'correction',
])
export type LedgerEntryKind = z.infer<typeof LedgerEntryKind>

export const TransactionStatus = z.enum(['pending', 'posted', 'superseded'])
export type TransactionStatus = z.infer<typeof TransactionStatus>

export const CreditCardMode = z.enum(['free_to_spend', 'bucket'])
export type CreditCardMode = z.infer<typeof CreditCardMode>

export const MemberRole = z.enum(['owner', 'member'])
export type MemberRole = z.infer<typeof MemberRole>

export const LedgerSourceType = z.enum([
  'occurrence',
  'transaction',
  'transfer_pair',
  'manual',
])
export type LedgerSourceType = z.infer<typeof LedgerSourceType>

// ---- Shared primitives ----

const uuid = z.string().uuid()
const isoDatetime = z.string().datetime()
/** Integer cents — never floats. */
const cents = z.number().int()

// ---- Entities ----

export const User = z.object({
  id: uuid,
  email: z.string().email(),
  passwordHash: z.string(),
  createdAt: isoDatetime,
})
export type User = z.infer<typeof User>

export const Budget = z.object({
  id: uuid,
  name: z.string().min(1),
  createdAt: isoDatetime,
})
export type Budget = z.infer<typeof Budget>

export const BudgetMember = z.object({
  id: uuid,
  budgetId: uuid,
  userId: uuid,
  role: MemberRole,
})
export type BudgetMember = z.infer<typeof BudgetMember>

export const Category = z.object({
  id: uuid,
  name: z.string().min(1),
})
export type Category = z.infer<typeof Category>

export const CategoryMapping = z.object({
  id: uuid,
  providerName: z.string(), // e.g. "simplefin"
  rawValue: z.string(),
  categoryId: uuid,
})
export type CategoryMapping = z.infer<typeof CategoryMapping>

export const ProviderCredential = z.object({
  id: uuid,
  providerName: z.string(),
  /** Encrypted payload (AES-256-GCM), never exposed to clients after save. */
  encryptedPayload: z.string(),
  createdAt: isoDatetime,
})
export type ProviderCredential = z.infer<typeof ProviderCredential>

export const Connection = z.object({
  id: uuid,
  providerName: z.string(),
  providerConnectionId: z.string(),
  orgName: z.string().nullable(),
  status: z.enum(['active', 'error', 'disconnected']),
  lastSyncAt: isoDatetime.nullable(),
})
export type Connection = z.infer<typeof Connection>

export const AccountStatus = z.enum(['active', 'archived'])
export type AccountStatus = z.infer<typeof AccountStatus>

export const Account = z.object({
  id: uuid,
  budgetId: uuid,
  connectionId: uuid.nullable(),
  providerAccountId: z.string().nullable(),
  type: AccountType,
  name: z.string().min(1),
  status: AccountStatus,
  lastSeenAt: isoDatetime.nullable(),
  reportedBalanceCents: cents,
  availableBalanceCents: cents.nullable(),
  reportedBalanceDate: isoDatetime.nullable(),
  currency: z.literal('USD'),
})
export type Account = z.infer<typeof Account>

export const BalanceSnapshot = z.object({
  id: uuid,
  accountId: uuid,
  date: z.string().date(),
  reportedBalanceCents: cents,
})
export type BalanceSnapshot = z.infer<typeof BalanceSnapshot>

export const BucketGroup = z.object({
  id: uuid,
  budgetId: uuid,
  name: z.string().min(1),
  color: z.string(),
})
export type BucketGroup = z.infer<typeof BucketGroup>

export const Bucket = z
  .object({
    id: uuid,
    budgetId: uuid,
    bucketGroupId: uuid.nullable(),
    type: BucketType,
    name: z.string().min(1),
    targetAmountCents: cents,
    dueDate: z.string().date().nullable(),
    dueFrequency: ExpenseDueFrequency.nullable(),
    targetDate: z.string().date().nullable(),
    dueDay: z.number().int().min(1).max(31).nullable(),
    fundingMode: FundingMode.nullable(),
    fundingScheduleId: uuid.nullable(),
    version: z.number().int(),
  })
export type Bucket = z.infer<typeof Bucket>

export const FundingSchedule = z.object({
  id: uuid,
  budgetId: uuid,
  name: z.string().min(1),
  recurrenceRule: z.string(),
  anchorDate: z.string().date(),
})
export type FundingSchedule = z.infer<typeof FundingSchedule>

export const ScheduleOccurrence = z.object({
  id: uuid,
  bucketId: uuid,
  scheduleId: uuid.nullable(),
  dueDate: z.string().date(),
  amountCents: cents,
  status: OccurrenceStatus,
  appliedAt: isoDatetime.nullable(),
})
export type ScheduleOccurrence = z.infer<typeof ScheduleOccurrence>

export const LedgerEntry = z.object({
  id: uuid,
  budgetId: uuid,
  /** null = the FTS side of an entry */
  bucketId: uuid.nullable(),
  kind: LedgerEntryKind,
  /** Signed: positive adds to the bucket/FTS, negative removes. */
  amountCents: cents,
  sourceType: LedgerSourceType,
  sourceId: z.string(),
  createdAt: isoDatetime,
})
export type LedgerEntry = z.infer<typeof LedgerEntry>

export const Transaction = z.object({
  id: uuid,
  accountId: uuid,
  providerTransactionId: z.string(),
  status: TransactionStatus,
  supersedesPendingId: uuid.nullable(),
  amountCents: cents,
  postedAt: isoDatetime,
  transactedAt: isoDatetime.nullable(),
  merchantDescription: z.string(),
  rawCategory: z.string().nullable(),
  categoryId: uuid.nullable(),
  bucketId: uuid.nullable(),
  transferLinkId: uuid.nullable(),
})
export type Transaction = z.infer<typeof Transaction>

export const CreditCardConfig = z.object({
  id: uuid,
  accountId: uuid,
  mode: CreditCardMode,
  payoffBucketId: uuid,
})
export type CreditCardConfig = z.infer<typeof CreditCardConfig>
