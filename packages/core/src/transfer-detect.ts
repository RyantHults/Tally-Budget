/**
 * Transfer-pair detection (plan §4 step 3) — default-deny heuristic.
 *
 * SimpleFin provides no transfer flag, so internal account transfers (card
 * payments, checking→savings) are auto-linked ONLY when every guard holds:
 *   - both sides posted
 *   - exact amount inversion (+X / −X, never zero)
 *   - different accounts
 *   - dates within TRANSFER_WINDOW_DAYS
 *   - normalized descriptors similar (≥ 0.5) — e.g. "PAYMENT TO CARD" /
 *     "CARD PAYMENT" — so same-day coincidental amounts don't link
 *   - neither side already linked
 *
 * Everything else must be marked manually; ambiguous cases stay unlinked and
 * remain fully visible in spend math.
 */

import { descriptorSimilarity } from './pending-merge.js'
import type { TransactionStatus } from './domain.js'

export const TRANSFER_WINDOW_DAYS = 4
export const TRANSFER_SIMILARITY_THRESHOLD = 0.5

const DAY_MS = 24 * 60 * 60 * 1000

export interface TransferPairCandidate {
  id: string
  accountId: string
  amountCents: number
  description: string
  /** Posted/settlement epoch ms. */
  dateMs: number
  status: TransactionStatus
  /** Non-null means this side is already part of a linked pair. */
  transferLinkId?: string | null
}

export function detectTransferPair(a: TransferPairCandidate, b: TransferPairCandidate): boolean {
  if (a.status !== 'posted' || b.status !== 'posted') return false
  if (a.accountId === b.accountId) return false
  if (a.transferLinkId != null || b.transferLinkId != null) return false
  if (a.amountCents === 0 || a.amountCents !== -b.amountCents) return false
  if (Math.abs(a.dateMs - b.dateMs) > TRANSFER_WINDOW_DAYS * DAY_MS) return false
  return descriptorSimilarity(a.description, b.description) >= TRANSFER_SIMILARITY_THRESHOLD
}
