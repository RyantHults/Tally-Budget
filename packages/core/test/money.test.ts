import { describe, expect, it } from 'vitest'
import { addCents, formatCents, parseDecimalStringToCents, subCents } from '../src/money.js'

describe('parseDecimalStringToCents', () => {
  it('parses plain values', () => {
    expect(parseDecimalStringToCents('33293.43')).toBe(3329343)
    expect(parseDecimalStringToCents('-33293.43')).toBe(-3329343)
    expect(parseDecimalStringToCents('+5.01')).toBe(501)
    expect(parseDecimalStringToCents('1')).toBe(100)
    expect(parseDecimalStringToCents('0.1')).toBe(10)
    expect(parseDecimalStringToCents('.5')).toBe(50)
    expect(parseDecimalStringToCents('0')).toBe(0)
  })

  it('rounds half-even at exact ties', () => {
    expect(parseDecimalStringToCents('0.125')).toBe(12) // tie → 12 (even)
    expect(parseDecimalStringToCents('0.135')).toBe(14) // tie → 14 (even)
    expect(parseDecimalStringToCents('0.005')).toBe(0) // tie → 0 (even)
    expect(parseDecimalStringToCents('0.015')).toBe(2) // tie → 2 (even)
    expect(parseDecimalStringToCents('10.005')).toBe(1000) // tie → 1000 (even)
    expect(parseDecimalStringToCents('-0.125')).toBe(-12) // symmetric
  })

  it('rounds normally when beyond the tie', () => {
    expect(parseDecimalStringToCents('0.1251')).toBe(13)
    expect(parseDecimalStringToCents('0.1249')).toBe(12)
    expect(parseDecimalStringToCents('0.0001')).toBe(0)
    expect(parseDecimalStringToCents('0.006')).toBe(1)
    expect(parseDecimalStringToCents('1.999')).toBe(200)
  })

  it('rejects garbage', () => {
    for (const bad of ['', 'abc', '1.2.3', '12,34', '--5', '1e5', NaN as unknown as string]) {
      expect(() => parseDecimalStringToCents(bad)).toThrow()
    }
  })
})

describe('formatCents', () => {
  it('formats with grouping and sign', () => {
    expect(formatCents(123456)).toBe('$1,234.56')
    expect(formatCents(-123456)).toBe('-$1,234.56')
    expect(formatCents(5)).toBe('$0.05')
    expect(formatCents(0)).toBe('$0.00')
    expect(formatCents(123456789)).toBe('$1,234,567.89')
  })

  it('rejects non-integers', () => {
    expect(() => formatCents(1.5)).toThrow()
  })
})

describe('add/sub', () => {
  it('adds and subtracts integer cents', () => {
    expect(addCents(100, 250)).toBe(350)
    expect(subCents(100, 250)).toBe(-150)
  })

  it('rejects float inputs', () => {
    expect(() => addCents(1.5, 2)).toThrow()
    expect(() => subCents(1, 0.5)).toThrow()
  })
})
