import { randomUUID } from 'node:crypto'
import { and, between, eq, inArray, isNull, lt, ne } from 'drizzle-orm'
import {
  classifyCardTransaction,
  detectTransferPair,
  descriptorSimilarity,
  matchPendingToPosted,
  selectMatchingBucket,
  suggestCategory,
  KEYWORD_RULES,
} from '@tally/core'
import type { CategoryMappingRule } from '@tally/core'
import type { NormalizedSimplefinTransaction } from './simplefin.js'
import {
  applySpendDrawdown,
  applyCardChargeSweep,
  applyCardPaymentDrawdown,
  reverseTransactionRouting,
} from './spend-routing.js'
import { db } from '../db/index.js'
import {
  accounts,
  buckets,
  categories,
  categoryMappings,
  creditCardConfigs,
  transactions,
} from '../db/schema.js'

/**
 * Ingest pipeline for one account's synced batch (plan §4, SimpleFin slice).
 *
 * Order matters and is deterministic:
 *   1. Upsert posted transactions on (account_id, provider_transaction_id);
 *      NEW posted rows are heuristically matched against the account's open
 *      pendings — matches mark the pending 'superseded' and link the posted row.
 *   2. Transfer-pair detection (default-deny) on new posted rows; linked pairs
 *      are excluded from matching and spend math.
 *   3. Auto-spend routing for remaining new posted spends:
 *      merchant match > category match > FTS, drawdown clamped at zero.
 *   4. Upsert pending transactions with status='pending' (existing rows keep
 *      their status — a re-sent pending must never resurrect a superseded row).
 *   5. Pendings older than 14 days expire to 'superseded'.
 *   6. Category resolution via exact category_mappings lookups; miss → null.
 *   7. Account balances refreshed from provider-reported values.
 */

const PENDING_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000
const TRANSFER_WINDOW_MS = 4 * 24 * 60 * 60 * 1000

export interface IngestAccountBatch {
  balanceCents: number
  availableBalanceCents: number | null
  balanceDate: Date | null
  transactions: readonly NormalizedSimplefinTransaction[]
}

export interface IngestAccountResult {
  insertedPosted: number
  insertedPending: number
  supersededPendings: number
  transfersLinked: number
  routedToBuckets: number
  /** Phase 3: card charges swept into payoff buckets. */
  cardSweeps: number
  /** Phase 3: card payments drew down payoff buckets. */
  cardPayments: number
  /** Phase 3: non-payment credits flagged for review. */
  flaggedForReview: number
}

/**
 * Lowercased rawValue → categoryId mappings for this provider, learned from
 * user corrections. Load once per sync run, pass into each account batch.
 */
export async function loadSimplefinCategoryMappings(): Promise<Map<string, string>> {
  const rows = await db
    .select({ rawValue: categoryMappings.rawValue, categoryId: categoryMappings.categoryId })
    .from(categoryMappings)
    .where(eq(categoryMappings.providerName, 'simplefin'))
  return new Map(rows.map((row) => [row.rawValue.toLowerCase(), row.categoryId]))
}

/**
 * Load all canonical category name → id pairs for keyword rule resolution.
 * Called once per sync batch (not per transaction).
 */
export async function loadCategoryNameMap(): Promise<Map<string, string>> {
  const rows = await db.select({ id: categories.id, name: categories.name }).from(categories)
  return new Map(rows.map((r) => [r.name, r.id]))
}

/** Exact mapping lookup: rawCategory first, then merchant description; miss → null ("Unknown"). */
export function resolveCategoryId(
  description: string,
  rawCategory: string | null,
  mappings: ReadonlyMap<string, string>,
): string | null {
  if (rawCategory) {
    const byRaw = mappings.get(rawCategory.trim().toLowerCase())
    if (byRaw) return byRaw
  }
  return mappings.get(description.trim().toLowerCase()) ?? null
}

/**
 * Smart categorization: exact match → similarity → keyword rules → null.
 * Backs resolveCategoryId when categoryByName is available (preferred).
 */
export function smartResolveCategoryId(
  description: string,
  rawCategory: string | null,
  mappings: ReadonlyMap<string, string>,
  categoryByName: ReadonlyMap<string, string>,
): string | null {
  // Convert map to CategoryMappingRule[] for suggestCategory
  const mappingArray: CategoryMappingRule[] = Array.from(mappings.entries()).map(
    ([rawValue, categoryId]) => ({ rawValue, categoryId }),
  )
  return suggestCategory(description, rawCategory, mappingArray, KEYWORD_RULES, categoryByName)
}

/** Effective postedAt for storage — the column is NOT NULL even for pendings. */
function effectivePostedAt(txn: NormalizedSimplefinTransaction): Date {
  return new Date(txn.postedAtMs ?? txn.transactedAtMs ?? Date.now())
}

interface NewPostedRow {
  id: string
  txn: NormalizedSimplefinTransaction
  categoryId: string | null
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Default-deny transfer-pair detection (plan §4 step 3): auto-link only exact
 * amount inversions across accounts within the window AND with similar
 * descriptors. Returns the shared pair id when linked.
 */
async function tryLinkTransferPair(
  tx: Tx,
  ctx: { budgetId: string; accountId: string; row: NewPostedRow },
): Promise<string | null> {
  const { row } = ctx
  const dateMs = effectivePostedAt(row.txn).getTime()
  const candidates = await tx
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      merchantDescription: transactions.merchantDescription,
      postedAt: transactions.postedAt,
      transferLinkId: transactions.transferLinkId,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(
      and(
        eq(accounts.budgetId, ctx.budgetId),
        ne(transactions.accountId, ctx.accountId),
        eq(transactions.status, 'posted'),
        eq(transactions.amountCents, -row.txn.amountCents),
        isNull(transactions.transferLinkId),
        between(transactions.postedAt, new Date(dateMs - TRANSFER_WINDOW_MS), new Date(dateMs + TRANSFER_WINDOW_MS)),
      ),
    )

  const incoming = {
    id: row.id,
    accountId: ctx.accountId,
    amountCents: row.txn.amountCents,
    description: row.txn.description,
    dateMs,
    status: 'posted' as const,
    transferLinkId: null,
  }

  let best: { id: string; similarity: number } | null = null
  for (const candidate of candidates) {
    const candidateInput = {
      id: candidate.id,
      accountId: candidate.accountId,
      amountCents: candidate.amountCents,
      description: candidate.merchantDescription,
      dateMs: candidate.postedAt.getTime(),
      status: 'posted' as const,
      transferLinkId: candidate.transferLinkId,
    }
    if (!detectTransferPair(incoming, candidateInput)) continue
    const similarity = descriptorSimilarity(incoming.description, candidateInput.description)
    if (!best || similarity > best.similarity) best = { id: candidate.id, similarity }
  }
  if (!best) return null

  const pairId = randomUUID()
  // The earlier side may already have been spend-routed before its pair showed
  // up — undo that via append-only corrections so linked pairs exit spend math.
  await reverseTransactionRouting(tx, ctx.budgetId, best.id, `transfer-reversal:${pairId}`)
  await tx
    .update(transactions)
    .set({ transferLinkId: pairId })
    .where(inArray(transactions.id, [best.id, row.id]))

  // Phase 3 retroactive card payment: if the earlier side is a credit card
  // payment (positive amount on a configured card) that was previously classified
  // as a 'credit', retroactively apply the payoff bucket drawdown now that the
  // pair exists. This handles the case where the card payment arrives before
  // the checking outflow.
  const earlierTxn = await tx
    .select({ id: transactions.id, amountCents: transactions.amountCents, accountId: transactions.accountId })
    .from(transactions)
    .where(eq(transactions.id, best.id))
    .limit(1)
  if (earlierTxn[0] && earlierTxn[0].amountCents > 0) {
    const earlierAccount = await tx
      .select({ type: accounts.type })
      .from(accounts)
      .where(eq(accounts.id, earlierTxn[0].accountId))
      .limit(1)
    if (earlierAccount[0]?.type === 'credit_card') {
      const config = await tx
        .select({ payoffBucketId: creditCardConfigs.payoffBucketId })
        .from(creditCardConfigs)
        .where(eq(creditCardConfigs.accountId, earlierTxn[0].accountId))
        .limit(1)
      if (config[0]) {
        await applyCardPaymentDrawdown(tx, {
          budgetId: ctx.budgetId,
          transactionRowId: earlierTxn[0].id,
          payoffBucketId: config[0].payoffBucketId,
          paymentAmountCents: earlierTxn[0].amountCents,
        })
        // Clear the needsReview flag — this was a payment, not a credit.
        await tx
          .update(transactions)
          .set({ needsReview: false })
          .where(eq(transactions.id, earlierTxn[0].id))
      }
    }
  }
  return pairId
}

/**
 * Auto-spend matching for a new posted SPEND (plan §4 step 5): merchant rule >
 * category rule > FTS; drawdown clamps the bucket at zero. Positive amounts
 * (refunds/credits) stay unrouted pending the Phase-3+ refund policy.
 */
async function routeAutoSpend(
  tx: Tx,
  ctx: { budgetId: string; row: NewPostedRow },
): Promise<boolean> {
  const { row } = ctx
  if (row.txn.amountCents >= 0) return false

  const bucketRows = await tx
    .select({
      id: buckets.id,
      matchMerchants: buckets.matchMerchants,
      matchCategories: buckets.matchCategories,
    })
    .from(buckets)
    .where(eq(buckets.budgetId, ctx.budgetId))
  if (bucketRows.length === 0) return false

  let categoryName: string | null = null
  if (row.categoryId) {
    const rows = await tx
      .select({ name: categories.name })
      .from(categories)
      .where(eq(categories.id, row.categoryId))
      .limit(1)
    categoryName = rows[0]?.name ?? null
  }

  const matchedBucketId = selectMatchingBucket(row.txn.description, categoryName, bucketRows)
  if (!matchedBucketId) return false

  await applySpendDrawdown(tx, {
    budgetId: ctx.budgetId,
    transactionRowId: row.id,
    txnAmountCents: row.txn.amountCents,
    bucketId: matchedBucketId,
  })
  await tx.update(transactions).set({ bucketId: matchedBucketId }).where(eq(transactions.id, row.id))
  return true
}

export async function ingestAccountBatch(
  accountId: string,
  batch: IngestAccountBatch,
  categoryMappingsByRawValue: ReadonlyMap<string, string>,
): Promise<IngestAccountResult> {
  const result: IngestAccountResult = {
    insertedPosted: 0,
    insertedPending: 0,
    supersededPendings: 0,
    transfersLinked: 0,
    routedToBuckets: 0,
    cardSweeps: 0,
    cardPayments: 0,
    flaggedForReview: 0,
  }

  await db.transaction(async (tx) => {
    const [accountRow] = await tx
      .select({ budgetId: accounts.budgetId })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1)
    if (!accountRow) throw new Error(`Cannot ingest unknown account ${accountId}`)
    const budgetId = accountRow.budgetId

    // Load canonical category name→id map once per batch for keyword resolution.
    const catRows = await tx.select({ id: categories.id, name: categories.name }).from(categories)
    const categoryByName = new Map(catRows.map((r) => [r.name, r.id]))

    const posted = batch.transactions.filter((t) => !t.pending)
    const pendings = batch.transactions.filter((t) => t.pending)

    // Which of these provider ids already exist locally?
    const allIds = batch.transactions.map((t) => t.id)
    const existingRows = allIds.length
      ? await tx
          .select({ providerTransactionId: transactions.providerTransactionId })
          .from(transactions)
          .where(
            and(eq(transactions.accountId, accountId), inArray(transactions.providerTransactionId, allIds)),
          )
      : []
    const existingIds = new Set(existingRows.map((row) => row.providerTransactionId))

    // ---- 1. Upsert posted transactions ----
    const newPostedRows: NewPostedRow[] = []
    for (const txn of posted) {
      const shared = {
        amountCents: txn.amountCents,
        postedAt: effectivePostedAt(txn),
        transactedAt: txn.transactedAtMs ? new Date(txn.transactedAtMs) : null,
        merchantDescription: txn.description,
        rawCategory: txn.rawCategory,
      }
      if (!existingIds.has(txn.id)) {
        const categoryId = smartResolveCategoryId(txn.description, txn.rawCategory, categoryMappingsByRawValue, categoryByName)
        const [row] = await tx
          .insert(transactions)
          .values({
            accountId,
            providerTransactionId: txn.id,
            status: 'posted',
            ...shared,
            categoryId,
          })
          .returning({ id: transactions.id })
        if (row) {
          newPostedRows.push({ id: row.id, txn, categoryId })
          result.insertedPosted++
        }
      } else {
        // Provider-side mutation (amount/date changed between polls): update in place.
        // Never touch categoryId/bucketId here — user corrections must survive re-syncs.
        await tx
          .update(transactions)
          .set({ ...shared, status: 'posted' })
          .where(and(eq(transactions.accountId, accountId), eq(transactions.providerTransactionId, txn.id)))
      }
    }

    // ---- Pending→posted merge for newly arrived posted rows only ----
    if (newPostedRows.length > 0) {
      const openPendings = await tx
        .select()
        .from(transactions)
        .where(and(eq(transactions.accountId, accountId), eq(transactions.status, 'pending')))
      if (openPendings.length > 0) {
        const matches = matchPendingToPosted(
          openPendings.map((row) => ({
            id: row.id,
            amountCents: row.amountCents,
            description: row.merchantDescription,
            dateMs: row.postedAt.getTime(),
          })),
          newPostedRows.map(({ id, txn }) => ({
            id,
            amountCents: txn.amountCents,
            description: txn.description,
            dateMs: effectivePostedAt(txn).getTime(),
          })),
        )
        for (const [postedRowId, pendingRowId] of matches) {
          const updated = await tx
            .update(transactions)
            .set({ status: 'superseded' })
            .where(and(eq(transactions.id, pendingRowId), eq(transactions.status, 'pending')))
            .returning({ id: transactions.id })
          if (updated.length > 0) {
            result.supersededPendings++
            await tx
              .update(transactions)
              .set({ supersedesPendingId: pendingRowId })
              .where(eq(transactions.id, postedRowId))
          }
        }
      }
    }

    // ---- 2+3+6. Transfer detection, card logic, auto-spend routing ----
    // Load credit card config if this account is a credit card (Phase 3).
    const [cardConfigRow] = await tx
      .select({
        accountId: creditCardConfigs.accountId,
        mode: creditCardConfigs.mode,
        payoffBucketId: creditCardConfigs.payoffBucketId,
      })
      .from(creditCardConfigs)
      .where(eq(creditCardConfigs.accountId, accountId))
      .limit(1)

    for (const row of newPostedRows) {
      const pairId = await tryLinkTransferPair(tx, { budgetId, accountId, row })

      if (cardConfigRow) {
        // Phase 3: credit card with config — direction-based card logic (plan §4 step 6).
        const cardType = classifyCardTransaction(row.txn.amountCents, !!pairId)

        switch (cardType) {
          case 'charge': {
            // Sweep |amount| into the payoff bucket (always).
            await applyCardChargeSweep(tx, {
              budgetId,
              transactionRowId: row.id,
              payoffBucketId: cardConfigRow.payoffBucketId,
              sweepAmountCents: Math.abs(row.txn.amountCents),
            })
            result.cardSweeps++
            // In 'bucket' mode, also run auto-spend matching for spending bucket drawdowns.
            if (cardConfigRow.mode === 'bucket') {
              if (await routeAutoSpend(tx, { budgetId, row })) result.routedToBuckets++
            }
            break
          }
          case 'payment': {
            // Draw down the payoff bucket by min(payment, balance), clamped >= 0.
            await applyCardPaymentDrawdown(tx, {
              budgetId,
              transactionRowId: row.id,
              payoffBucketId: cardConfigRow.payoffBucketId,
              paymentAmountCents: row.txn.amountCents,
            })
            result.cardPayments++
            break
          }
          case 'credit': {
            // Non-payment credit (merchant refund to card): flag for review.
            await tx
              .update(transactions)
              .set({ needsReview: true })
              .where(eq(transactions.id, row.id))
            result.flaggedForReview++
            break
          }
        }
        if (pairId) result.transfersLinked++
      } else {
        // No config or not a credit card — original behavior.
        if (pairId) {
          result.transfersLinked++
          continue
        }
        if (await routeAutoSpend(tx, { budgetId, row })) result.routedToBuckets++
      }
    }

    // ---- 4. Upsert pending transactions ----
    for (const txn of pendings) {
      const shared = {
        amountCents: txn.amountCents,
        postedAt: effectivePostedAt(txn),
        transactedAt: txn.transactedAtMs ? new Date(txn.transactedAtMs) : null,
        merchantDescription: txn.description,
        rawCategory: txn.rawCategory,
      }
      if (!existingIds.has(txn.id)) {
        await tx.insert(transactions).values({
          accountId,
          providerTransactionId: txn.id,
          status: 'pending',
          ...shared,
          categoryId: smartResolveCategoryId(txn.description, txn.rawCategory, categoryMappingsByRawValue, categoryByName),
        })
        result.insertedPending++
      } else {
        // Refresh fields but preserve status: a still-pending re-send must not
        // resurrect a row that already posted or was superseded.
        await tx
          .update(transactions)
          .set(shared)
          .where(and(eq(transactions.accountId, accountId), eq(transactions.providerTransactionId, txn.id)))
      }
    }

    // ---- 5. Expire stale pendings ----
    const expiryCutoff = new Date(Date.now() - PENDING_EXPIRY_MS)
    const expired = await tx
      .update(transactions)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(transactions.accountId, accountId),
          eq(transactions.status, 'pending'),
          lt(transactions.postedAt, expiryCutoff),
        ),
      )
      .returning({ id: transactions.id })
    result.supersededPendings += expired.length

    // ---- 7. Refresh reported balances from the provider ----
    await tx
      .update(accounts)
      .set({
        reportedBalanceCents: batch.balanceCents,
        availableBalanceCents: batch.availableBalanceCents,
        reportedBalanceDate: batch.balanceDate ?? new Date(),
      })
      .where(eq(accounts.id, accountId))
  })

  return result
}
