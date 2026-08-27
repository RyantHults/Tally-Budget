import { and, isNull, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { categories, transactions, categoryMappings } from '../db/schema.js'
import { suggestCategory, KEYWORD_RULES } from '@tally/core'
import type { CategoryMappingRule } from '@tally/core'

/** Canonical taxonomy (plan §3) — global list, budget-assignable. */
export const CANONICAL_CATEGORIES = [
  'Groceries',
  'Dining',
  'Fast Food',
  'Rent',
  'Mortgage',
  'Utilities',
  'Gas',
  'Auto Insurance',
  'Health Insurance',
  'Healthcare',
  'Shopping',
  'Entertainment',
  'Subscriptions',
  'Travel',
  'Pet Supplies',
  'Investments',
  'Credit Card Payment',
  'Transfer',
  'Fees',
  'Income',
  'Other',
] as const

/** Idempotent seed — safe to call on every boot. */
export async function seedCategories(): Promise<void> {
  await db
    .insert(categories)
    .values(CANONICAL_CATEGORIES.map((name) => ({ name })))
    .onConflictDoNothing({ target: categories.name })
}

/**
 * Boot-time retroactive backfill: categorize all posted transactions with
 * NULL categoryId using existing learned mappings + keyword rules.
 * Idempotent — only touches NULL-category rows. Returns count updated.
 */
export async function backfillUncategorizedTransactions(
  logger: { info: (msg: string) => void },
): Promise<number> {
  // Load all learned mappings (provider-wide).
  const mappingRows = await db
    .select({ rawValue: categoryMappings.rawValue, categoryId: categoryMappings.categoryId })
    .from(categoryMappings)
  const mappings: CategoryMappingRule[] = mappingRows.map((r) => ({
    rawValue: r.rawValue.toLowerCase(),
    categoryId: r.categoryId,
  }))

  // Load canonical category name→id map.
  const catRows = await db.select({ id: categories.id, name: categories.name }).from(categories)
  const categoryByName = new Map(catRows.map((r) => [r.name, r.id]))

  // Find all posted transactions with NULL categoryId.
  const uncategorized = await db
    .select({
      id: transactions.id,
      merchantDescription: transactions.merchantDescription,
      rawCategory: transactions.rawCategory,
    })
    .from(transactions)
    .where(and(eq(transactions.status, 'posted'), isNull(transactions.categoryId)))

  if (uncategorized.length === 0) return 0

  // Categorize each and collect updates.
  const updates: { id: string; categoryId: string }[] = []
  for (const txn of uncategorized) {
    const categoryId = suggestCategory(
      txn.merchantDescription,
      txn.rawCategory,
      mappings,
      KEYWORD_RULES,
      categoryByName,
    )
    if (categoryId) {
      updates.push({ id: txn.id, categoryId })
    }
  }

  if (updates.length === 0) return 0

  // Bulk update (individual updates to avoid a single massive IN clause).
  for (const { id, categoryId } of updates) {
    await db
      .update(transactions)
      .set({ categoryId })
      .where(eq(transactions.id, id))
  }

  logger.info(`Boot backfill: categorized ${updates.length} of ${uncategorized.length} uncategorized posted transactions`)
  return updates.length
}
