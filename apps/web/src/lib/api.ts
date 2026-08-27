/** Thin typed fetch wrapper. Cookie-based session auth via credentials:'include'. */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new ApiError(res.status, text)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
}

// ---- Endpoint types ----

export interface User {
  id: string
  email: string
}

export interface Budget {
  id: string
  name: string
  createdAt: string
}

export interface Bucket {
  id: string
  budgetId: string
  bucketGroupId: string | null
  type: 'expense' | 'goal' | 'vault'
  name: string
  targetAmountCents: number
  dueDate: string | null
  dueFrequency: BucketDueFrequency | null
  dueDay: number | null
  targetDate: string | null
  fundingMode: 'set_aside' | 'reach_target' | null
  fundingScheduleId: string | null
  /** Keyword tokens matched against transaction descriptions. */
  matchMerchants: string[]
  /** Canonical category names matched against transactions. */
  matchCategories: string[]
  version: number
  /** Phase 2: current ledger-derived balance. */
  currentBalanceCents: number
}

export type BucketDueFrequency = 'monthly' | 'weekly' | 'biweekly' | 'quarterly' | 'semiannual' | 'annual'

export interface BucketGroup {
  id: string
  budgetId: string
  name: string
  color: string
  sortOrder: number
}

export interface FundingSchedule {
  id: string
  budgetId: string
  name: string
  recurrenceRule: string
  anchorDate: string
}

export interface StoredCredential {
  providerName: string
  createdAt: string
}

export type AccountType = 'checking' | 'savings' | 'cd' | 'credit_card'

export interface Account {
  id: string
  name: string
  type: AccountType
  status: 'active' | 'archived'
  connectionId: string | null
  reportedBalanceCents: number
  reportedBalanceDate: string | null
  currency: string
  connectionName: string | null
  orgName: string | null
  lastSyncAt: string | null
  lastSeenAt: string | null
  connectionStatus: 'active' | 'error' | 'disconnected' | null
}

export interface Transaction {
  id: string
  accountId: string
  accountName: string
  status: 'pending' | 'posted' | 'superseded'
  amountCents: number
  postedAt: string
  merchantDescription: string
  categoryId: string | null
  bucketId: string | null
  /** Phase 2: populated when this txn is part of a transfer pair. */
  transferLinkId: string | null
}

export interface Category {
  id: string
  name: string
}

// ---- Phase 2 types ----

export interface FtsResult {
  ftsCents: number
  allocatedCents: number
  balanceCents: number
}

export interface UpcomingEvent {
  id: string
  bucketId: string
  bucketName: string
  dueDate: string
  amountCents: number
  status: string
}

export interface TransferRequest {
  fromBucketId: string | null
  toBucketId: string | null
  amountCents: number
}

export interface MarkTransferRequest {
  otherTransactionId: string
}

// ---- SimpleFin onboarding types ----

export interface SimpleFinClaimResult {
  reusedExistingConnection: boolean
  linkedCount: number
  totalDiscovered: number
}

export interface DiscoveredAccount {
  providerAccountId: string
  name: string
  inferredType: 'checking' | 'savings' | 'cd' | 'credit_card'
  balanceCents: number
  linked: boolean
  linkedAccountId: string | null
  connectionId: string
  connectionName: string
}

export interface SimpleFinLinkResult {
  accountsCreated: number
  accountsSkipped: number
}

// ---- Phase 3 types (credit card config) ----

export interface BucketActivity {
  id: string
  kind: 'funding' | 'spend' | 'transfer_in' | 'transfer_out' | 'correction'
  amountCents: number
  createdAt: string
  description: string | null
  scheduleName?: string | null
  counterpartName?: string | null
}

export interface CreditCardConfig {
  id: string
  accountId: string
  mode: 'free_to_spend' | 'bucket'
  payoffBucketId: string
  cardAccountName: string
  cardReportedBalanceCents: number
  payoffBucketName: string
  payoffBalanceCents: number
}
