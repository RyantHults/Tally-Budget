/**
 * Pending→posted transaction merging (plan §4 step 2).
 *
 * SimpleFin supplies no pending↔posting reference, so postings are heuristically
 * matched to open pendings. A pair is eligible only when ALL of:
 *   - amounts are within AMOUNT_TOLERANCE_CENTS of each other
 *   - dates are within MATCH_WINDOW_DAYS of each other
 *   - normalized descriptor similarity ≥ DESCRIPTOR_SIMILARITY_THRESHOLD
 *
 * Matching is greedy best-pair and strictly one-to-one: each pending merges into
 * at most one posted row and vice versa. Outside tolerance → keep both, never merge.
 */

/** |amount difference| must be ≤ this many cents (i.e. ±$1.00). */
export const AMOUNT_TOLERANCE_CENTS = 100
/** Posting must land within this many days of the pending's date. */
export const MATCH_WINDOW_DAYS = 7
/** Minimum Jaccard token overlap of normalized descriptors. */
export const DESCRIPTOR_SIMILARITY_THRESHOLD = 0.6

export interface MergeCandidate {
  id: string
  amountCents: number
  description: string
  /** Epoch ms of the relevant date (posted/settlement date). */
  dateMs: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Lowercase and split into alphanumeric tokens, dropping separators.
 * "SQ *COFFEE SHOP #123" → ["sq", "coffee", "shop", "123"]
 */
export function normalizeDescriptor(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** Jaccard overlap of the two descriptors' normalized token sets (0..1). */
export function descriptorSimilarity(a: string, b: string): number {
  const tokensA = new Set(normalizeDescriptor(a))
  const tokensB = new Set(normalizeDescriptor(b))
  if (tokensA.size === 0 || tokensB.size === 0) return 0
  let intersection = 0
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++
  }
  const union = tokensA.size + tokensB.size - intersection
  return intersection / union
}

export function isEligiblePair(pending: MergeCandidate, posted: MergeCandidate): boolean {
  if (Math.abs(pending.amountCents - posted.amountCents) > AMOUNT_TOLERANCE_CENTS) return false
  if (Math.abs(pending.dateMs - posted.dateMs) > MATCH_WINDOW_DAYS * DAY_MS) return false
  return descriptorSimilarity(pending.description, posted.description) >= DESCRIPTOR_SIMILARITY_THRESHOLD
}

/**
 * Match open pendings to newly arrived posted transactions.
 * Returns a Map keyed by posted id → the pending id it supersedes.
 *
 * Deterministic: pairs are considered best-first by descriptor similarity,
 * then tighter amount difference, then tighter date difference, then input order.
 */
export function matchPendingToPosted(
  pending: readonly MergeCandidate[],
  posted: readonly MergeCandidate[],
): Map<string, string> {
  interface ScoredPair {
    pendingIndex: number
    postedIndex: number
    score: number
    amountDiff: number
    dateDiff: number
  }

  const pairs: ScoredPair[] = []
  for (let p = 0; p < pending.length; p++) {
    const pendingTxn = pending[p]!
    for (let q = 0; q < posted.length; q++) {
      const postedTxn = posted[q]!
      if (!isEligiblePair(pendingTxn, postedTxn)) continue
      pairs.push({
        pendingIndex: p,
        postedIndex: q,
        score: descriptorSimilarity(pendingTxn.description, postedTxn.description),
        amountDiff: Math.abs(pendingTxn.amountCents - postedTxn.amountCents),
        dateDiff: Math.abs(pendingTxn.dateMs - postedTxn.dateMs),
      })
    }
  }

  pairs.sort(
    (a, b) =>
      b.score - a.score ||
      a.amountDiff - b.amountDiff ||
      a.dateDiff - b.dateDiff ||
      a.pendingIndex - b.pendingIndex ||
      a.postedIndex - b.postedIndex,
  )

  const matchedPending = new Set<number>()
  const matchedPosted = new Set<number>()
  const result = new Map<string, string>()
  for (const pair of pairs) {
    if (matchedPending.has(pair.pendingIndex) || matchedPosted.has(pair.postedIndex)) continue
    matchedPending.add(pair.pendingIndex)
    matchedPosted.add(pair.postedIndex)
    result.set(posted[pair.postedIndex]!.id, pending[pair.pendingIndex]!.id)
  }
  return result
}
