import { describe, expect, it } from 'vitest'
import { classifyCardTransaction, payoffSweepAmount } from '../src/credit-card.js'

describe('classifyCardTransaction', () => {
  it('classifies negative amounts as charges regardless of transfer link', () => {
    expect(classifyCardTransaction(-5000, false)).toBe('charge')
    expect(classifyCardTransaction(-1, true)).toBe('charge')
    expect(classifyCardTransaction(-100_000, false)).toBe('charge')
  })

  it('classifies positive transfer-linked amounts as payments', () => {
    expect(classifyCardTransaction(5000, true)).toBe('payment')
    expect(classifyCardTransaction(1, true)).toBe('payment')
  })

  it('classifies positive non-linked amounts as credits (refunds, etc.)', () => {
    expect(classifyCardTransaction(3000, false)).toBe('credit')
    expect(classifyCardTransaction(1, false)).toBe('credit')
  })

  it('treats zero as credit (not a charge or payment)', () => {
    expect(classifyCardTransaction(0, false)).toBe('credit')
    expect(classifyCardTransaction(0, true)).toBe('payment')
  })
})

describe('payoffSweepAmount', () => {
  it('returns full amount when bucket has sufficient balance', () => {
    expect(payoffSweepAmount(10_000, 5000)).toBe(5000)
    expect(payoffSweepAmount(5000, 5000)).toBe(5000)
    expect(payoffSweepAmount(100_000, 5000)).toBe(5000)
  })

  it('clamps at bucket balance when insufficient', () => {
    expect(payoffSweepAmount(3000, 5000)).toBe(3000)
    expect(payoffSweepAmount(100, 5000)).toBe(100)
  })

  it('returns 0 when bucket is empty', () => {
    expect(payoffSweepAmount(0, 5000)).toBe(0)
  })

  it('returns 0 when bucket balance is negative', () => {
    expect(payoffSweepAmount(-1000, 5000)).toBe(0)
  })

  it('returns 0 for non-positive amounts', () => {
    expect(payoffSweepAmount(10_000, 0)).toBe(0)
    expect(payoffSweepAmount(10_000, -1)).toBe(0)
  })

  it('handles edge case: balance and amount both zero', () => {
    expect(payoffSweepAmount(0, 0)).toBe(0)
  })
})
