import { describe, expect, it } from 'vitest'
import { selectMatchingBucket, tokensMatchRule } from '../src/spend.js'
import type { MatchableBucket } from '../src/spend.js'

const buckets: MatchableBucket[] = [
  { id: 'groceries', matchMerchants: ['trader joes', 'safeway'], matchCategories: ['Groceries'] },
  { id: 'coffee', matchMerchants: ['blue bottle'], matchCategories: ['Dining', 'Fast Food'] },
  { id: 'fun', matchMerchants: [], matchCategories: ['Entertainment'] },
]

describe('tokensMatchRule', () => {
  it('matches single-token rules case-insensitively', () => {
    expect(tokensMatchRule(['blue', 'bottle', 'coffee', '123'], 'BLUE BOTTLE')).toBe(true)
    expect(tokensMatchRule(['blue', 'bottle', 'coffee'], 'starbucks')).toBe(false)
  })

  it('requires every word of a multi-word rule to be present', () => {
    expect(tokensMatchRule(['trader', 'joes', '456'], 'trader joes')).toBe(true)
    expect(tokensMatchRule(['trader'], 'trader joes')).toBe(false)
  })

  it('never matches empty rules', () => {
    expect(tokensMatchRule(['anything'], '***')).toBe(false)
    expect(tokensMatchRule(['anything'], '')).toBe(false)
  })
})

describe('selectMatchingBucket', () => {
  it('matches by merchant token containment', () => {
    expect(selectMatchingBucket('TRADER JOES #456', null, buckets)).toBe('groceries')
    expect(selectMatchingBucket('sq *blue bottle coffee', null, buckets)).toBe('coffee')
  })

  it('matches by category name (case-insensitive)', () => {
    expect(selectMatchingBucket('RANDOM MARKET PURCHASE', 'groceries', buckets)).toBe('groceries')
    expect(selectMatchingBucket('CINEMA TICKET', 'entertainment', buckets)).toBe('fun')
  })

  it('returns null for uncategorized transactions with no merchant hit → FTS', () => {
    expect(selectMatchingBucket('SOME RANDOM STORE', null, buckets)).toBeNull()
  })

  it('returns null when the category matches nothing', () => {
    expect(selectMatchingBucket('SOME RANDOM STORE', 'Healthcare', buckets)).toBeNull()
  })

  it('prefers an explicit merchant hit over a category hit on a different bucket', () => {
    // "Blue Bottle" is merchant-matched to `coffee`; its category would say Dining → also coffee.
    // Construct the real conflict: merchant rule for groceries hits while category says Dining.
    const conflicting: MatchableBucket[] = [
      { id: 'dining', matchMerchants: [], matchCategories: ['Fast Food'] },
      { id: 'promo', matchMerchants: ['blue bottle'], matchCategories: [] },
    ]
    expect(selectMatchingBucket('BLUE BOTTLE COFFEE', 'fast food', conflicting)).toBe('promo')
  })

  it('keeps the first bucket in caller order on equal-rank ties', () => {
    const tied: MatchableBucket[] = [
      { id: 'first', matchMerchants: ['target'], matchCategories: [] },
      { id: 'second', matchMerchants: ['target'], matchCategories: [] },
    ]
    expect(selectMatchingBucket('TARGET STORE', null, tied)).toBe('first')
  })

  it('returns null with no buckets at all', () => {
    expect(selectMatchingBucket('ANYTHING', 'Groceries', [])).toBeNull()
  })
})
