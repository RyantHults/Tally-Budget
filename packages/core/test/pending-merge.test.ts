import { describe, expect, it } from 'vitest'
import {
  AMOUNT_TOLERANCE_CENTS,
  MATCH_WINDOW_DAYS,
  descriptorSimilarity,
  matchPendingToPosted,
  normalizeDescriptor,
} from '../src/pending-merge.js'
import type { MergeCandidate } from '../src/pending-merge.js'

const DAY_MS = 24 * 60 * 60 * 1000
const BASE = Date.UTC(2026, 0, 10) // Jan 10 2026

function pending(
  id: string,
  amountCents: number,
  description: string,
  dateMs: number = BASE,
): MergeCandidate {
  return { id, amountCents, description, dateMs }
}

function posted(
  id: string,
  amountCents: number,
  description: string,
  dateMs: number = BASE,
): MergeCandidate {
  return { id, amountCents, description, dateMs }
}

describe('normalizeDescriptor', () => {
  it('lowercases and strips non-alphanumerics into tokens', () => {
    expect(normalizeDescriptor('SQ *COFFEE SHOP #1234')).toEqual(['sq', 'coffee', 'shop', '1234'])
    expect(normalizeDescriptor('  Amazon.com*2X7  ')).toEqual(['amazon', 'com', '2x7'])
  })

  it('yields no tokens for punctuation-only strings', () => {
    expect(normalizeDescriptor('*** --- ***')).toEqual([])
  })
})

describe('descriptorSimilarity', () => {
  it('is 1 for identical descriptors', () => {
    expect(descriptorSimilarity('Coffee Shop', 'coffee shop')).toBe(1)
  })

  it('scores SQ-prefixed variants above the merge threshold', () => {
    expect(descriptorSimilarity('SQ *COFFEE SHOP', 'coffee shop')).toBeCloseTo(2 / 3, 5)
    expect(descriptorSimilarity('SQ *COFFEE SHOP', 'coffee shop')).toBeGreaterThanOrEqual(0.6)
  })

  it('is 0 when either side has no tokens', () => {
    expect(descriptorSimilarity('***', 'coffee')).toBe(0)
  })
})

describe('matchPendingToPosted', () => {
  it('merges an exact match (same amount, date, descriptor)', () => {
    const result = matchPendingToPosted(
      [pending('p1', -4800, 'BLUE BOTTLE COFFEE')],
      [posted('t1', -4800, 'BLUE BOTTLE COFFEE')],
    )
    expect(result.size).toBe(1)
    expect(result.get('t1')).toBe('p1')
  })

  it('merges within the ±100 cent amount tolerance', () => {
    // $48.00 pending settles at $48.99 → 99 cents apart.
    const result = matchPendingToPosted(
      [pending('p1', -4800, 'TRADER JOES #456')],
      [posted('t1', -4899, 'TRADER JOES #456')],
    )
    expect(result.get('t1')).toBe('p1')
  })

  it('merges at exactly the tolerance boundary', () => {
    const result = matchPendingToPosted(
      [pending('p1', -4800, 'SHELL OIL')],
      [posted('t1', -4800 + AMOUNT_TOLERANCE_CENTS, 'SHELL OIL')],
    )
    expect(result.get('t1')).toBe('p1')
  })

  it('does NOT merge when the amount is outside tolerance', () => {
    // $48.00 pending vs $52.00 posted — tip changed by more than $1.
    const result = matchPendingToPosted(
      [pending('p1', -4800, 'BLUE BOTTLE COFFEE')],
      [posted('t1', -5200, 'BLUE BOTTLE COFFEE')],
    )
    expect(result.size).toBe(0)
  })

  it('does NOT merge when dates are further apart than the window', () => {
    const result = matchPendingToPosted(
      [pending('p1', -4800, 'BLUE BOTTLE COFFEE', BASE)],
      [posted('t1', -4800, 'BLUE BOTTLE COFFEE', BASE + (MATCH_WINDOW_DAYS * DAY_MS + 1))],
    )
    expect(result.size).toBe(0)
  })

  it('merges right at the 7-day window boundary', () => {
    const result = matchPendingToPosted(
      [pending('p1', -4800, 'BLUE BOTTLE COFFEE', BASE)],
      [posted('t1', -4800, 'BLUE BOTTLE COFFEE', BASE + MATCH_WINDOW_DAYS * DAY_MS)],
    )
    expect(result.get('t1')).toBe('p1')
  })

  it('matches "SQ *COFFEE SHOP" style descriptors against clean merchant names', () => {
    const cases: Array<[string, string]> = [
      ['SQ *COFFEE SHOP', 'coffee shop'],
      ['SQ*COFFEE SHOP', 'COFFEE SHOP'],
      ['coffee shop #123', 'COFFEE SHOP'], // subset tokens → 2/3
      ['Coffee Shop (Sq)', 'SQ *COFFEE SHOP'], // {coffee,shop,sq} overlap → 2/3
    ]
    for (const [pendingDesc, postedDesc] of cases) {
      const result = matchPendingToPosted(
        [pending('p1', -1250, pendingDesc)],
        [posted('t1', -1250, postedDesc)],
      )
      expect(result.get('t1'), `${pendingDesc} vs ${postedDesc}`).toBe('p1')
    }
  })

  it('does not merge dissimilar descriptors even with identical amounts', () => {
    const result = matchPendingToPosted(
      [pending('p1', -4800, 'WALMART GROCERY')],
      [posted('t1', -4800, 'BLUE BOTTLE COFFEE')],
    )
    expect(result.size).toBe(0)
  })

  it('merges at most one pair when two identical pendings meet one posting', () => {
    // Two duplicate $48 charges captured as pending; only one has posted so far.
    const result = matchPendingToPosted(
      [pending('p1', -4800, 'BLUE BOTTLE COFFEE', BASE), pending('p2', -4800, 'BLUE BOTTLE COFFEE', BASE)],
      [posted('t1', -4800, 'BLUE BOTTLE COFFEE', BASE)],
    )
    expect(result.size).toBe(1)
    // Deterministic: the first pending in input order wins the tie.
    expect(result.get('t1')).toBe('p1')
  })

  it('pairs one-to-one when duplicates post separately', () => {
    const result = matchPendingToPosted(
      [
        pending('p1', -4800, 'BLUE BOTTLE COFFEE', BASE),
        pending('p2', -4800, 'BLUE BOTTLE COFFEE', BASE),
      ],
      [
        posted('t1', -4800, 'BLUE BOTTLE COFFEE', BASE),
        posted('t2', -4800, 'BLUE BOTTLE COFFEE', BASE),
      ],
    )
    expect(result.size).toBe(2)
    expect(new Set(result.values())).toEqual(new Set(['p1', 'p2']))
    expect(new Set(result.keys())).toEqual(new Set(['t1', 't2']))
  })

  it('prefers the best-scoring pair greedily', () => {
    // p1 is a stronger descriptor match for t1; p2 should fall to t2 despite order.
    const result = matchPendingToPosted(
      [
        pending('p1', -2000, 'AMAZON MKTPLACE PKG'),
        pending('p2', -2000, 'AMAZON.COM AMZN.COM/BILL'),
      ],
      [
        posted('t1', -2000, 'AMAZON.COM AMZN.COM/BILL'),
        posted('t2', -2000, 'AMAZON MKTPLACE PKG'),
      ],
    )
    expect(result.get('t1')).toBe('p2')
    expect(result.get('t2')).toBe('p1')
  })

  it('ignores stale pendings that never matched anything', () => {
    const result = matchPendingToPosted(
      [
        pending('stale', -3000, 'OLD RESTAURANT', BASE - 30 * DAY_MS),
        pending('fresh', -1250, 'SQ *COFFEE SHOP', BASE),
      ],
      [posted('t1', -1250, 'coffee shop', BASE)],
    )
    expect(result.size).toBe(1)
    expect(result.get('t1')).toBe('fresh')
  })

  it('handles deposits (positive amounts) symmetrically', () => {
    const result = matchPendingToPosted(
      [pending('p1', 150000, 'ACME PAYROLL DEP')],
      [posted('t1', 150050, 'ACME PAYROLL DEP')],
    )
    expect(result.get('t1')).toBe('p1')
  })

  it('returns an empty map for empty inputs', () => {
    expect(matchPendingToPosted([], []).size).toBe(0)
    expect(matchPendingToPosted([pending('p1', -100, 'X')], []).size).toBe(0)
    expect(matchPendingToPosted([], [posted('t1', -100, 'X')]).size).toBe(0)
  })
})
