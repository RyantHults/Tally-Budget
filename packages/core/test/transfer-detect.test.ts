import { describe, expect, it } from 'vitest'
import { detectTransferPair } from '../src/transfer-detect.js'
import type { TransferPairCandidate } from '../src/transfer-detect.js'

const DAY_MS = 24 * 60 * 60 * 1000
const BASE = Date.UTC(2026, 2, 10) // Mar 10 2026

function txn(overrides: Partial<TransferPairCandidate>): TransferPairCandidate {
  return {
    id: 'txn-a',
    accountId: 'acct-1',
    amountCents: -4800,
    description: 'PAYMENT TO CARD',
    dateMs: BASE,
    status: 'posted',
    transferLinkId: null,
    ...overrides,
  }
}

/** The canonical card-payment pair: checking outflow + card inflow. */
function pair(): [TransferPairCandidate, TransferPairCandidate] {
  return [
    txn({ id: 'out', accountId: 'checking', amountCents: -4800, description: 'PAYMENT TO CARD' }),
    txn({ id: 'in', accountId: 'card', amountCents: 4800, description: 'CARD PAYMENT' }),
  ]
}

describe('detectTransferPair', () => {
  it('links an exact inversion across accounts with similar descriptors', () => {
    const [a, b] = pair()
    expect(detectTransferPair(a, b)).toBe(true)
    expect(detectTransferPair(b, a)).toBe(true) // symmetric
  })

  it('links at exactly the 4-day window boundary', () => {
    const [a, b] = pair()
    expect(detectTransferPair(a, { ...b, dateMs: BASE + 4 * DAY_MS })).toBe(true)
    expect(detectTransferPair(a, { ...b, dateMs: BASE - 4 * DAY_MS })).toBe(true)
  })

  it('rejects pairs outside the 4-day window', () => {
    const [a, b] = pair()
    expect(detectTransferPair(a, { ...b, dateMs: BASE + 4 * DAY_MS + 1 })).toBe(false)
  })

  it('rejects amounts that are not exact inversions (off by a cent)', () => {
    const [a, b] = pair()
    expect(detectTransferPair(a, { ...b, amountCents: 4799 })).toBe(false)
  })

  it('rejects same-account pairs', () => {
    const [a, b] = pair()
    expect(detectTransferPair(a, { ...b, accountId: 'checking' })).toBe(false)
  })

  it('rejects pending transactions', () => {
    const [a, b] = pair()
    expect(detectTransferPair(a, { ...b, status: 'pending' })).toBe(false)
    expect(detectTransferPair({ ...a, status: 'pending' }, b)).toBe(false)
  })

  it('rejects already-linked sides', () => {
    const [a, b] = pair()
    expect(detectTransferPair(a, { ...b, transferLinkId: 'pair-1' })).toBe(false)
    expect(detectTransferPair({ ...a, transferLinkId: 'pair-1' }, b)).toBe(false)
  })

  it('rejects zero-amount non-pairs', () => {
    expect(
      detectTransferPair(txn({ amountCents: 0 }), txn({ id: 'b', amountCents: 0 })),
    ).toBe(false)
  })

  it('does NOT link a rent payment against an unrelated same-day refund of the same size', () => {
    // False-positive guard: identical $1200 inversion, dissimilar descriptors.
    const rent = txn({
      id: 'rent',
      accountId: 'checking',
      amountCents: -120_000,
      description: 'RENT JANUARY 1200 MAIN ST',
    })
    const refund = txn({
      id: 'refund',
      accountId: 'savings',
      amountCents: 120_000,
      description: 'AMAZON REFUND ORDER CONFIRMED',
    })
    expect(detectTransferPair(rent, refund)).toBe(false)
  })

  it('does NOT link similarly-sized transfers with unrelated descriptors', () => {
    const salary = txn({
      id: 'salary',
      accountId: 'checking',
      amountCents: -25_000,
      description: 'ACME PAYROLL DEP',
    })
    const gift = txn({
      id: 'gift',
      accountId: 'savings',
      amountCents: 25_000,
      description: 'BIRTHDAY GIFT FROM MOM',
    })
    expect(detectTransferPair(salary, gift)).toBe(false)
  })

  it('links near-threshold descriptor variants like WEB PAYMENT / PAYMENT THANK YOU', () => {
    // {web,payment} vs {payment,thank,you}: intersection 1, union 4 → 0.25 → no link.
    const [a, b] = pair()
    expect(detectTransferPair(a, { ...b, description: 'WEB PAYMENT THANK YOU' })).toBe(false)
    // {payment,to,card} vs {payment,card}: 2/3 → link.
    expect(detectTransferPair(a, { ...b, description: 'payment card' })).toBe(true)
  })
})
