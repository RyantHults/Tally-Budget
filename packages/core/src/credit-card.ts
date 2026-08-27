/**
 * Credit-card mode logic (plan §4 step 6) — pure classification + clamp math.
 *
 * Card accounts are excluded from the FTS balance sum; card debt is
 * represented solely by the payoff bucket allocation.
 *
 * Two modes:
 *   - free_to_spend: charges sweep into the payoff bucket only
 *   - bucket: charges sweep into the payoff bucket AND draw down matched spending buckets
 *
 * Payments always draw down the payoff bucket.
 * Non-payment credits are flagged for review.
 */

export type CardTransactionType = 'charge' | 'payment' | 'credit'

/**
 * Classify a posted credit-card transaction by direction and transfer context.
 *
 *   - charge:  amountCents < 0  (purchase, interest, fee)
 *   - payment: amountCents > 0 AND transfer-linked to a checking/savings outflow
 *   - credit:  amountCents > 0 AND NOT transfer-linked (merchant refund, etc.)
 */
export function classifyCardTransaction(
  amountCents: number,
  isTransferLinked: boolean,
): CardTransactionType {
  if (amountCents < 0) return 'charge'
  if (isTransferLinked) return 'payment'
  return 'credit'
}

/**
 * Compute the actual drawdown amount for a card payment against the payoff bucket.
 *
 * Clamps at zero: if the bucket balance is insufficient, we only draw down
 * what's available. Returns 0 when the bucket is empty or the amount is non-positive.
 *
 * The caller writes: kind='spend', sourceType='transaction', sourceId=`ccpay:${txnId}`,
 * amountCents = -payoffSweepAmount(...).
 */
export function payoffSweepAmount(balanceCents: number, amountCents: number): number {
  if (amountCents <= 0 || balanceCents <= 0) return 0
  return Math.min(amountCents, balanceCents)
}
