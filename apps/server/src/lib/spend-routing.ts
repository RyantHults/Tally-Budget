import { and, eq, like, or, sql } from 'drizzle-orm'
import { computeBucketDrawdown, payoffSweepAmount } from '@tally/core'
import { db } from '../db/index.js'
import { ledgerEntries, transactions } from '../db/schema.js'
import { bucketBalance, type DbExecutor } from './ledger.js'

/**
 * Spend routing over the append-only ledger (plan §4 steps 5–7).
 *
 * Every ledger entry attributable to a transaction's routing has
 * sourceType='transaction' and a sourceId of either the transaction row id
 * (the original auto-spend drawdown) or `reassign:<txnId>:...` (compensating
 * corrections). Buckets clamp at zero — remainder spills to FTS implicitly.
 */

export interface SpendDrawdownInput {
  budgetId: string
  transactionRowId: string
  txnAmountCents: number
  bucketId: string
}

/**
 * Draw a matched bucket down for a posted spend, clamped at zero.
 * Returns the entry amount written (0 when the bucket was empty — the whole
 * spend spills to FTS and no entry is needed).
 */
export async function applySpendDrawdown(
  executor: DbExecutor,
  input: SpendDrawdownInput,
): Promise<number> {
  const balance = await bucketBalance(input.bucketId, executor)
  const drawdown = computeBucketDrawdown(input.txnAmountCents, balance)
  if (drawdown !== 0) {
    await executor
      .insert(ledgerEntries)
      .values({
        budgetId: input.budgetId,
        bucketId: input.bucketId,
        kind: 'spend',
        amountCents: drawdown,
        sourceType: 'transaction',
        sourceId: input.transactionRowId,
      })
      .onConflictDoNothing()
  }
  return drawdown
}

/**
 * Net routed amount per bucket for a transaction: its original spend entries
 * plus every reassignment correction. Transfer-reversal entries cancel out in
 * the sum, keeping this the single source of truth for "where is this txn's
 * money routed right now".
 */
export async function netRoutedByBucket(
  executor: DbExecutor,
  transactionRowId: string,
): Promise<Map<string, number>> {
  const rows = await executor
    .select({
      bucketId: ledgerEntries.bucketId,
      total: sql<string>`coalesce(sum(${ledgerEntries.amountCents}), 0)`,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.sourceType, 'transaction'),
        or(
          eq(ledgerEntries.sourceId, transactionRowId),
          like(ledgerEntries.sourceId, `reassign:${transactionRowId}:%`),
          eq(ledgerEntries.sourceId, `cc:${transactionRowId}`),
          eq(ledgerEntries.sourceId, `ccpay:${transactionRowId}`),
        ),
      ),
    )
    .groupBy(ledgerEntries.bucketId)
  const net = new Map<string, number>()
  for (const row of rows) {
    if (row.bucketId) net.set(row.bucketId, Number(row.total ?? 0))
  }
  return net
}

/**
 * Undo a transaction's routing entirely (used when it becomes transfer-linked
 * after its pair arrives late): compensating corrections restore every bucket's
 * net to zero, keyed uniquely per pair/bucket. Appends only — history preserved.
 */
export async function reverseTransactionRouting(
  executor: DbExecutor,
  budgetId: string,
  transactionRowId: string,
  reversalKeyPrefix: string,
): Promise<boolean> {
  const net = await netRoutedByBucket(executor, transactionRowId)
  let touched = false
  for (const [bucketId, amount] of net) {
    if (amount === 0) continue
    await executor
      .insert(ledgerEntries)
      .values({
        budgetId,
        bucketId,
        kind: 'correction',
        amountCents: -amount,
        sourceType: 'transaction',
        sourceId: `${reversalKeyPrefix}:${bucketId}`,
      })
      .onConflictDoNothing()
    touched = true
  }
  if (net.size > 0) {
    await executor.update(transactions).set({ bucketId: null }).where(eq(transactions.id, transactionRowId))
  }
  return touched
}

export interface ReassignmentInput {
  budgetId: string
  transactionRowId: string
  txnAmountCents: number
  oldBucketId: string | null
  newBucketId: string | null
}

/**
 * Move a transaction's routing between buckets (or bucket ↔ FTS) using
 * compensating kind='correction' entries (plan §4 step 7):
 *   :out — reverses the net currently routed to the old bucket
 *   :in  — applies a fresh clamped drawdown against the new bucket
 * Keyed `reassign:<txnId>:<old|fts>:<new|fts>:(out|in)`; the unique
 * (sourceType, sourceId, kind) constraint makes replays harmless no-ops.
 */
export async function reassignTransactionRouting(
  executor: DbExecutor,
  input: ReassignmentInput,
): Promise<void> {
  const baseKey = `reassign:${input.transactionRowId}:${input.oldBucketId ?? 'fts'}:${input.newBucketId ?? 'fts'}`

  if (input.oldBucketId) {
    const net = (await netRoutedByBucket(executor, input.transactionRowId)).get(input.oldBucketId) ?? 0
    if (net !== 0) {
      await executor
        .insert(ledgerEntries)
        .values({
          budgetId: input.budgetId,
          bucketId: input.oldBucketId,
          kind: 'correction',
          amountCents: -net,
          sourceType: 'transaction',
          sourceId: `${baseKey}:out`,
        })
        .onConflictDoNothing()
    }
  }

  if (input.newBucketId) {
    // Balance read AFTER the reversal above (same tx) so the fresh drawdown
    // sees restored funds.
    const balance = await bucketBalance(input.newBucketId, executor)
    const drawdown = computeBucketDrawdown(input.txnAmountCents, balance)
    if (drawdown !== 0) {
      await executor
        .insert(ledgerEntries)
        .values({
          budgetId: input.budgetId,
          bucketId: input.newBucketId,
          kind: 'correction',
          amountCents: drawdown,
          sourceType: 'transaction',
          sourceId: `${baseKey}:in`,
        })
        .onConflictDoNothing()
    }
  }

  await executor
    .update(transactions)
    .set({ bucketId: input.newBucketId })
    .where(eq(transactions.id, input.transactionRowId))
}

/**
 * Sweep a card charge into the payoff bucket (plan §4 step 6, charge path).
 *
 * Ledger entry: kind='funding', sourceType='transaction', sourceId=`cc:${txnId}`,
 * amountCents = |chargeAmount| (always positive — money flows INTO the bucket).
 *
 * In 'bucket' mode, the caller ALSO runs routeAutoSpend for the matched spending
 * bucket drawdown — the two entries net against each other per plan §4 walkthrough.
 */
export async function applyCardChargeSweep(
  executor: DbExecutor,
  input: { budgetId: string; transactionRowId: string; payoffBucketId: string; sweepAmountCents: number },
): Promise<void> {
  if (input.sweepAmountCents <= 0) return
  await executor
    .insert(ledgerEntries)
    .values({
      budgetId: input.budgetId,
      bucketId: input.payoffBucketId,
      kind: 'funding',
      amountCents: input.sweepAmountCents,
      sourceType: 'transaction',
      sourceId: `cc:${input.transactionRowId}`,
    })
    .onConflictDoNothing()
}

/**
 * Draw down the payoff bucket for a card payment (plan §4 step 6, payment path).
 *
 * Ledger entry: kind='spend', sourceType='transaction', sourceId=`ccpay:${txnId}`,
 * amountCents = -payoffSweepAmount(...) (negative — money flows OUT of the bucket).
 * Clamped at zero: if the bucket balance is less than the payment, only the
 * available balance is drawn down.
 */
export async function applyCardPaymentDrawdown(
  executor: DbExecutor,
  input: { budgetId: string; transactionRowId: string; payoffBucketId: string; paymentAmountCents: number },
): Promise<void> {
  const balance = await bucketBalance(input.payoffBucketId, executor)
  const drawdown = payoffSweepAmount(balance, input.paymentAmountCents)
  if (drawdown === 0) return
  await executor
    .insert(ledgerEntries)
    .values({
      budgetId: input.budgetId,
      bucketId: input.payoffBucketId,
      kind: 'spend',
      amountCents: -drawdown,
      sourceType: 'transaction',
      sourceId: `ccpay:${input.transactionRowId}`,
    })
    .onConflictDoNothing()
}
