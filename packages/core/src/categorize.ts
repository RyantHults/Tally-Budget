/**
 * Smart transaction categorization (plan §4 step 4).
 *
 * Priority order:
 *   1. Exact match — lowercased description or rawCategory equals a mapping's rawValue
 *   2. Similarity match — best mapping with descriptorSimilarity >= minSimilarity
 *   3. Keyword rules — first rule whose tokens all appear in normalized description
 *   4. null ("Unknown")
 */

import { normalizeDescriptor, descriptorSimilarity } from './pending-merge.js'

export interface CategoryMappingRule {
  /** Lowercased raw value (merchant description or provider category). */
  rawValue: string
  /** Canonical category id. */
  categoryId: string
}

export interface KeywordRule {
  /** All tokens must appear in the normalized description (subset match). */
  tokens: readonly string[]
  /** Canonical category name (must match the seeded categories list). */
  categoryName: string
}

/**
 * Built-in keyword rules evaluated in order. The first rule whose tokens
 * are all present in the normalized description wins. Learned mappings
 * (exact + similarity) ALWAYS beat keywords — user intent wins over
 * heuristics.
 */
export const KEYWORD_RULES: readonly KeywordRule[] = [
  // Fees — single-token variants
  { tokens: ['fee'], categoryName: 'Fees' },
  { tokens: ['fees'], categoryName: 'Fees' },
  // Fees — multi-token compound
  { tokens: ['service', 'charge'], categoryName: 'Fees' },

  // Transfers
  { tokens: ['zelle'], categoryName: 'Transfer' },
  { tokens: ['transfer'], categoryName: 'Transfer' },
  { tokens: ['xfer'], categoryName: 'Transfer' },

  // Income
  { tokens: ['payroll'], categoryName: 'Income' },
  { tokens: ['paycheck'], categoryName: 'Income' },
  { tokens: ['direct', 'deposit'], categoryName: 'Income' },
]

/**
 * Suggest a category for a transaction.
 *
 * @param description - Merchant description from the provider
 * @param rawCategory - Provider's raw category string (may be null)
 * @param mappings - Pre-loaded rawValue→categoryId mappings for this provider
 * @param keywordRules - Keyword rules to fall back to after similarity
 * @param categoryByName - Map of canonical category NAME → id (for keyword resolution)
 * @param minSimilarity - Minimum Jaccard similarity threshold (default 0.6)
 * @returns The suggested categoryId, or null if no match ("Unknown")
 */
export function suggestCategory(
  description: string,
  rawCategory: string | null,
  mappings: readonly CategoryMappingRule[],
  keywordRules: readonly KeywordRule[],
  categoryByName: ReadonlyMap<string, string>,
  minSimilarity = 0.6,
): string | null {
  // 1. Exact match — rawCategory first, then description
  if (rawCategory) {
    const lcRaw = rawCategory.trim().toLowerCase()
    for (const m of mappings) {
      if (m.rawValue === lcRaw) return m.categoryId
    }
  }
  const lcDesc = description.trim().toLowerCase()
  for (const m of mappings) {
    if (m.rawValue === lcDesc) return m.categoryId
  }

  // 2. Similarity match — best mapping above threshold
  const normalizedDesc = normalizeDescriptor(description).join(' ')
  let bestMapping: { categoryId: string; similarity: number } | null = null
  for (const m of mappings) {
    const sim = descriptorSimilarity(normalizedDesc, m.rawValue)
    if (sim >= minSimilarity) {
      if (!bestMapping || sim > bestMapping.similarity) {
        bestMapping = { categoryId: m.categoryId, similarity: sim }
      }
    }
  }
  if (bestMapping) return bestMapping.categoryId

  // 3. Keyword rules — first rule whose tokens all appear in description
  const descTokens = new Set(normalizeDescriptor(description))
  for (const rule of keywordRules) {
    if (rule.tokens.every((t) => descTokens.has(t))) {
      const catId = categoryByName.get(rule.categoryName)
      if (catId) return catId
    }
  }

  // 4. Unknown
  return null
}
