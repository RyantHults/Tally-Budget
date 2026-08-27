import { and, eq, ne, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { PgTransaction } from 'drizzle-orm/pg-core'
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres'
import type { ExtractTablesWithRelations } from 'drizzle-orm'
import { db } from '../db/index.js'
import type * as schema from '../db/schema.js'
import { accounts, buckets, ledgerEntries } from '../db/schema.js'

/**
 * Ledger-derived money views (plan §1/§3): bucket balances and FTS are
 * derived/cached views over ledger_entries — never independently mutated.
 *
 * FTS = Σ reported balances of active non-credit-card accounts − Σ bucket
 * allocations. Credit card accounts are excluded from the balance sum; card
 * debt is represented solely by its payoff allocation (Phase 3).
 */

/** Anything that can run queries: the root db or a transaction handle. */
export type DbExecutor =
  | NodePgDatabase<typeof schema>
  | PgTransaction<NodePgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>

/** Σ ledger entries for one bucket — its current allocated balance. */
export async function bucketBalance(bucketId: string, executor: DbExecutor = db): Promise<number> {
  const rows = await executor
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountCents}), 0)` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.bucketId, bucketId))
  return Number(rows[0]?.total ?? 0)
}

export interface BudgetMoneySummary {
  /** Σ reported balances of active non-credit_card accounts. */
  balanceCents: number
  /** Σ all ledger allocations across the budget's buckets. */
  allocatedCents: number
  /** balanceCents − allocatedCents (may be negative via automatic sweeps). */
  ftsCents: number
}

/** Single-query-per-side summary — cheap enough for the Home endpoint. */
export async function budgetMoneySummary(
  budgetId: string,
  executor: DbExecutor = db,
): Promise<BudgetMoneySummary> {
  const balanceRows = await executor
    .select({ total: sql<string>`coalesce(sum(${accounts.reportedBalanceCents}), 0)` })
    .from(accounts)
    .where(
      and(eq(accounts.budgetId, budgetId), eq(accounts.status, 'active'), ne(accounts.type, 'credit_card')),
    )
  const allocationRows = await executor
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountCents}), 0)` })
    .from(ledgerEntries)
    .innerJoin(buckets, eq(ledgerEntries.bucketId, buckets.id))
    .where(eq(buckets.budgetId, budgetId))

  const balanceCents = Number(balanceRows[0]?.total ?? 0)
  const allocatedCents = Number(allocationRows[0]?.total ?? 0)
  return { balanceCents, allocatedCents, ftsCents: balanceCents - allocatedCents }
}

export async function ftsCents(budgetId: string, executor: DbExecutor = db): Promise<number> {
  return (await budgetMoneySummary(budgetId, executor)).ftsCents
}
