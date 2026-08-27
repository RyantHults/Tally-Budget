/**
 * Auto-spend matching (plan §4 step 5) — pure selection rules.
 *
 * Priority: explicit merchant match > category match > FTS. When both rule
 * types hit different buckets, the merchant hit wins; ties keep the first
 * bucket in the caller's order, so callers control deterministic fallbacks.
 */

import { normalizeDescriptor } from './pending-merge.js'

export interface MatchableBucket {
  id: string
  /** Raw description tokens; matched case-insensitively against description tokens. */
  matchMerchants: readonly string[]
  /** Canonical category NAMES; compared case-insensitively. */
  matchCategories: readonly string[]
}

/** A rule token matches when every normalized word of the token appears in the description's tokens. */
export function tokensMatchRule(descriptionTokens: readonly string[], ruleToken: string): boolean {
  const ruleTokens = normalizeDescriptor(ruleToken)
  if (ruleTokens.length === 0) return false
  const available = new Set(descriptionTokens)
  return ruleTokens.every((token) => available.has(token))
}

/**
 * Pick the bucket a posted transaction should draw down from.
 * `categoryName` is the resolved canonical name of the transaction's category
 * (null when uncategorized). Returns the bucket id or null for FTS.
 */
export function selectMatchingBucket(
  description: string,
  categoryName: string | null,
  buckets: readonly MatchableBucket[],
): string | null {
  const tokens = normalizeDescriptor(description)
  const normalizedCategory = categoryName?.trim().toLowerCase() ?? null

  let bestId: string | null = null
  let bestScore = 0
  for (const bucket of buckets) {
    const merchantHit = bucket.matchMerchants.some((rule) => tokensMatchRule(tokens, rule))
    const categoryHit =
      normalizedCategory !== null &&
      bucket.matchCategories.some((c) => c.trim().toLowerCase() === normalizedCategory)
    if (!merchantHit && !categoryHit) continue
    // Merchant (2) beats category-only (1); equal rank keeps the earlier bucket.
    const score = merchantHit ? 2 : 1
    if (score > bestScore) {
      bestScore = score
      bestId = bucket.id
    }
  }
  return bestId
}
