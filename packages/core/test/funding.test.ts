import { describe, expect, it } from 'vitest'
import {
  addDaysYmd,
  applicableDeadline,
  computeBucketDrawdown,
  computeOccurrenceAmount,
  countScheduledOccurrences,
  daysInMonth,
  expandSchedule,
  isLeapYear,
  planDueDateFunding,
  isValidRecurrenceRule,
  parseYmd,
} from '../src/funding.js'

function ymds(dates: Date[]): string[] {
  return dates.map((d) => d.toISOString().slice(0, 10))
}

describe('date helpers', () => {
  it('detects leap years', () => {
    expect(isLeapYear(2024)).toBe(true)
    expect(isLeapYear(2000)).toBe(true)
    expect(isLeapYear(1900)).toBe(false)
    expect(isLeapYear(2026)).toBe(false)
  })

  it('computes days in month', () => {
    expect(daysInMonth(2026, 1)).toBe(31)
    expect(daysInMonth(2026, 4)).toBe(30)
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2024, 2)).toBe(29)
  })

  it('adds days across month and year boundaries', () => {
    expect(addDaysYmd('2026-01-30', 5)).toBe('2026-02-04')
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysYmd('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('rejects malformed dates', () => {
    expect(() => parseYmd('2026-13-01')).toThrow()
    expect(() => parseYmd('2026-02-30')).toThrow()
    expect(() => parseYmd('junk')).toThrow()
  })
})

describe('expandSchedule', () => {
  it('expands daily schedules', () => {
    const dates = ymds(expandSchedule('daily', '2026-01-30', '2026-01-01', '2026-02-02'))
    expect(dates).toEqual(['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02'])
  })

  it('derives weekly phase from the anchor, not the calendar', () => {
    const dates = ymds(expandSchedule('weekly', '2026-01-07', '2026-01-01', '2026-01-31'))
    expect(dates).toEqual(['2026-01-07', '2026-01-14', '2026-01-21', '2026-01-28'])
  })

  it('derives biweekly phase from the anchor (not every other Friday)', () => {
    const dates = ymds(expandSchedule('biweekly', '2026-01-07', '2026-01-01', '2026-02-15'))
    expect(dates).toEqual(['2026-01-07', '2026-01-21', '2026-02-04'])
  })

  it('clamps month-end anchors to short months without losing phase', () => {
    // Anchor on the 31st: Feb clamps to 28 (2026 is not a leap year), Mar returns to 31.
    const dates = ymds(expandSchedule('monthly', '2026-01-31', '2026-01-01', '2026-04-30'))
    expect(dates).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'])
  })

  it('clamps to Feb 29 in leap years', () => {
    const dates = ymds(expandSchedule('monthly', '2024-01-31', '2024-01-01', '2024-03-31'))
    expect(dates).toEqual(['2024-01-31', '2024-02-29', '2024-03-31'])
  })

  it('handles monthly anchors late in the year crossing into the next year', () => {
    const dates = ymds(expandSchedule('monthly', '2026-11-15', '2026-11-01', '2027-02-28'))
    expect(dates).toEqual(['2026-11-15', '2026-12-15', '2027-01-15', '2027-02-15'])
  })

  it('expands semimonthly 1st-and-15th starting from the anchor', () => {
    // Anchor Jan 10 → the Jan 1st already passed; first occurrence is Jan 15.
    const dates = ymds(expandSchedule('1st-and-15th', '2026-01-10', '2026-01-01', '2026-02-28'))
    expect(dates).toEqual(['2026-01-15', '2026-02-01', '2026-02-15'])
  })

  it('includes the anchor itself for semimonthly when it lands on the 1st or 15th', () => {
    const dates = ymds(expandSchedule('semimonthly', '2026-01-01', '2026-01-01', '2026-01-31'))
    expect(dates).toEqual(['2026-01-01', '2026-01-15'])
  })

  it('expands yearly with Feb 29 clamping in common years', () => {
    const dates = ymds(expandSchedule('yearly', '2024-02-29', '2024-01-01', '2028-12-31'))
    expect(dates).toEqual(['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29'])
  })

  it('expands parameterised semimonthly 15,eom across Feb (non-leap)', () => {
    const dates = ymds(expandSchedule('semimonthly:15,eom', '2026-01-15', '2026-01-01', '2026-03-31'))
    expect(dates).toEqual([
      '2026-01-15', '2026-01-31',
      '2026-02-15', '2026-02-28',
      '2026-03-15', '2026-03-31',
    ])
  })

  it('expands parameterised semimonthly 15,eom across Feb (leap year)', () => {
    const dates = ymds(expandSchedule('semimonthly:15,eom', '2024-01-15', '2024-01-01', '2024-03-31'))
    expect(dates).toEqual([
      '2024-01-15', '2024-01-31',
      '2024-02-15', '2024-02-29',
      '2024-03-15', '2024-03-31',
    ])
  })

  it('collapses 31,eom to a single tick in short months', () => {
    const dates = ymds(expandSchedule('semimonthly:31,eom', '2026-01-31', '2026-01-01', '2026-04-30'))
    expect(dates).toEqual([
      '2026-01-31', // Jan: both clamp to 31 → deduped
      '2026-02-28', // Feb: 31→28, eom=28 → deduped
      '2026-03-31', // Mar: both clamp to 31 → deduped
      '2026-04-30', // Apr: 31→30, eom=30 → deduped
    ])
  })

  it('expands semimonthly 1,15 (classic start+mid)', () => {
    const dates = ymds(expandSchedule('semimonthly:1,15', '2026-01-01', '2026-01-01', '2026-03-15'))
    expect(dates).toEqual([
      '2026-01-01', '2026-01-15',
      '2026-02-01', '2026-02-15',
      '2026-03-01', '2026-03-15',
    ])
  })

  it('expands semimonthly 10,eom (date + end-of-month)', () => {
    const dates = ymds(expandSchedule('semimonthly:10,eom', '2026-01-10', '2026-01-01', '2026-02-28'))
    expect(dates).toEqual([
      '2026-01-10', '2026-01-31',
      '2026-02-10', '2026-02-28',
    ])
  })

  it('expands semimonthly 1,20 (start-of-month + date)', () => {
    const dates = ymds(expandSchedule('semimonthly:1,20', '2026-01-01', '2026-01-01', '2026-02-28'))
    expect(dates).toEqual([
      '2026-01-01', '2026-01-20',
      '2026-02-01', '2026-02-20',
    ])
  })

  it('respects [fromDate, toDate] for parameterised semimonthly', () => {
    const dates = ymds(expandSchedule('semimonthly:10,eom', '2026-01-10', '2026-01-20', '2026-02-28'))
    expect(dates).toEqual([
      '2026-01-31',
      '2026-02-10', '2026-02-28',
    ])
  })

  it('filters strictly to [fromDate, toDate] inclusive', () => {
    const dates = ymds(expandSchedule('daily', '2026-01-01', '2026-01-05', '2026-01-07'))
    expect(dates).toEqual(['2026-01-05', '2026-01-06', '2026-01-07'])
  })

  it('returns empty when the anchor is after toDate', () => {
    expect(expandSchedule('daily', '2026-06-01', '2026-01-01', '2026-05-31')).toEqual([])
  })

  it('throws on unsupported rules', () => {
    expect(() => expandSchedule('whenever', '2026-01-01', '2026-01-01', '2026-12-31')).toThrow()
  })
})

describe('isValidRecurrenceRule', () => {
  it('accepts basic rules', () => {
    expect(isValidRecurrenceRule('daily')).toBe(true)
    expect(isValidRecurrenceRule('weekly')).toBe(true)
    expect(isValidRecurrenceRule('biweekly')).toBe(true)
    expect(isValidRecurrenceRule('monthly')).toBe(true)
    expect(isValidRecurrenceRule('yearly')).toBe(true)
  })

  it('accepts valid semimonthly rules', () => {
    expect(isValidRecurrenceRule('semimonthly:15,eom')).toBe(true)
    expect(isValidRecurrenceRule('semimonthly:1,15')).toBe(true)
    expect(isValidRecurrenceRule('semimonthly:10,eom')).toBe(true)
    expect(isValidRecurrenceRule('semimonthly:1,20')).toBe(true)
    expect(isValidRecurrenceRule('semimonthly:31,eom')).toBe(true)
    expect(isValidRecurrenceRule('semimonthly:eom,15')).toBe(true)
    expect(isValidRecurrenceRule('semimonthly:eom,5')).toBe(true)
  })

  it('accepts rules case-insensitively', () => {
    expect(isValidRecurrenceRule('Daily')).toBe(true)
    expect(isValidRecurrenceRule('Semimonthly:15,EOM')).toBe(true)
    expect(isValidRecurrenceRule('MONTHLY')).toBe(true)
  })

  it('rejects A=B', () => {
    expect(isValidRecurrenceRule('semimonthly:15,15')).toBe(false)
    expect(isValidRecurrenceRule('semimonthly:eom,eom')).toBe(false)
  })

  it('rejects day 0 and day 32', () => {
    expect(isValidRecurrenceRule('semimonthly:0,15')).toBe(false)
    expect(isValidRecurrenceRule('semimonthly:32,15')).toBe(false)
    expect(isValidRecurrenceRule('semimonthly:15,0')).toBe(false)
    expect(isValidRecurrenceRule('semimonthly:15,32')).toBe(false)
  })

  it('rejects garbage and malformed strings', () => {
    expect(isValidRecurrenceRule('whenever')).toBe(false)
    expect(isValidRecurrenceRule('semimonthly:15')).toBe(false)
    expect(isValidRecurrenceRule('semimonthly:15,')).toBe(false)
    expect(isValidRecurrenceRule('semimonthly:,15')).toBe(false)
    expect(isValidRecurrenceRule('semimonthly:a,b')).toBe(false)
    expect(isValidRecurrenceRule('')).toBe(false)
  })
})

describe('due-date funding planning', () => {
  it('clamps monthly day 31 and rolls over after each independently clamped deadline', () => {
    const dueRule = { kind: 'legacy_monthly' as const, dueDay: 31 }

    expect(applicableDeadline(dueRule, '2026-02-28')).toBe('2026-02-28')
    expect(applicableDeadline(dueRule, '2026-03-01')).toBe('2026-03-31')
    expect(applicableDeadline(dueRule, '2026-04-15')).toBe('2026-04-30')
    expect(applicableDeadline(dueRule, '2026-05-01')).toBe('2026-05-31')
  })

  it('keeps recurring weekly deadlines on the due-rule weekday', () => {
    const dueRule = { kind: 'recurring' as const, frequency: 'weekly' as const, anchorDate: '2026-01-07' }

    expect(applicableDeadline(dueRule, '2026-01-07')).toBe('2026-01-07')
    expect(applicableDeadline(dueRule, '2026-01-08')).toBe('2026-01-14')
    expect(applicableDeadline(dueRule, '2026-01-20')).toBe('2026-01-21')
  })

  it('keeps recurring biweekly deadlines exactly 14 days apart', () => {
    const dueRule = { kind: 'recurring' as const, frequency: 'biweekly' as const, anchorDate: '2026-01-07' }

    expect(applicableDeadline(dueRule, '2026-01-21')).toBe('2026-01-21')
    expect(applicableDeadline(dueRule, '2026-01-22')).toBe('2026-02-04')
  })

  it('clamps recurring quarterly, semiannual, and annual calendar deadlines', () => {
    const quarterly = { kind: 'recurring' as const, frequency: 'quarterly' as const, anchorDate: '2026-01-31' }
    expect(applicableDeadline(quarterly, '2026-02-01')).toBe('2026-04-30')
    expect(applicableDeadline(quarterly, '2026-04-30')).toBe('2026-04-30')
    expect(applicableDeadline(quarterly, '2026-05-01')).toBe('2026-07-31')

    const semiannual = { kind: 'recurring' as const, frequency: 'semiannual' as const, anchorDate: '2026-08-31' }
    expect(applicableDeadline(semiannual, '2026-09-01')).toBe('2027-02-28')
    expect(applicableDeadline(semiannual, '2027-03-01')).toBe('2027-08-31')

    const annual = { kind: 'recurring' as const, frequency: 'annual' as const, anchorDate: '2024-02-29' }
    expect(applicableDeadline(annual, '2025-02-27')).toBe('2025-02-28')
    expect(applicableDeadline(annual, '2025-03-01')).toBe('2026-02-28')
    expect(applicableDeadline(annual, '2028-01-01')).toBe('2028-02-29')
  })

  it('includes exact deadlines and rejects one-time occurrences after them', () => {
    expect(applicableDeadline({ kind: 'legacy_monthly', dueDay: 15 }, '2026-01-15')).toBe('2026-01-15')
    expect(applicableDeadline({ kind: 'once', targetDate: '2026-04-15' }, '2026-04-15')).toBe('2026-04-15')
    expect(applicableDeadline({ kind: 'once', targetDate: '2026-04-15' }, '2026-04-16')).toBeNull()

    expect(
      planDueDateFunding({
        recurrenceRule: 'daily',
        anchorDate: '2026-04-01',
        occurrenceDate: '2026-04-16',
        dueRule: { kind: 'once', targetDate: '2026-04-15' },
        fundingMode: 'reach_target',
        targetAmountCents: 10_000,
        currentBalanceCents: 0,
      }),
    ).toBeNull()
  })

  it('counts pure recurrence dates through deadlines beyond the materialized horizon', () => {
    const plan = planDueDateFunding({
      recurrenceRule: 'daily',
      anchorDate: '2026-01-01',
      occurrenceDate: '2026-01-01',
      dueRule: { kind: 'once', targetDate: '2026-04-15' },
      fundingMode: 'reach_target',
      targetAmountCents: 10_000,
      currentBalanceCents: 0,
    })

    expect(countScheduledOccurrences('daily', '2026-01-01', '2026-01-01', '2026-04-15')).toBe(105)
    expect(plan).toEqual({
      deadline: '2026-04-15',
      cycleOccurrenceCount: 105,
      remainingOccurrenceCount: 105,
      amountCents: 96,
    })
  })

  it('funds set_aside by whole-cycle count regardless of the current balance', () => {
    const input = {
      recurrenceRule: 'semimonthly:1,15' as const,
      anchorDate: '2026-01-01',
      occurrenceDate: '2026-01-01',
      dueRule: { kind: 'legacy_monthly' as const, dueDay: 31 },
      fundingMode: 'set_aside' as const,
      targetAmountCents: 100,
      currentBalanceCents: 0,
    }

    expect(planDueDateFunding(input)).toEqual({
      deadline: '2026-01-31',
      cycleOccurrenceCount: 2,
      remainingOccurrenceCount: 2,
      amountCents: 50,
    })
    expect(planDueDateFunding({ ...input, occurrenceDate: '2026-01-15', currentBalanceCents: 100 })).toEqual({
      deadline: '2026-01-31',
      cycleOccurrenceCount: 2,
      remainingOccurrenceCount: 1,
      amountCents: 50,
    })
  })

  it('funds reach_target by the live remaining gap and resumes after a drawdown', () => {
    const input = {
      recurrenceRule: 'semimonthly:1,15' as const,
      anchorDate: '2026-01-01',
      dueRule: { kind: 'legacy_monthly' as const, dueDay: 31 },
      fundingMode: 'reach_target' as const,
      targetAmountCents: 100,
    }

    expect(planDueDateFunding({ ...input, occurrenceDate: '2026-01-01', currentBalanceCents: 0 })).toEqual({
      deadline: '2026-01-31',
      cycleOccurrenceCount: 2,
      remainingOccurrenceCount: 2,
      amountCents: 50,
    })
    expect(planDueDateFunding({ ...input, occurrenceDate: '2026-01-15', currentBalanceCents: 50 })).toEqual({
      deadline: '2026-01-31',
      cycleOccurrenceCount: 2,
      remainingOccurrenceCount: 1,
      amountCents: 50,
    })
    expect(planDueDateFunding({ ...input, occurrenceDate: '2026-02-01', currentBalanceCents: 100 })).toEqual({
      deadline: '2026-02-28',
      cycleOccurrenceCount: 2,
      remainingOccurrenceCount: 2,
      amountCents: 0,
    })
    expect(planDueDateFunding({ ...input, occurrenceDate: '2026-02-15', currentBalanceCents: 25 })).toEqual({
      deadline: '2026-02-28',
      cycleOccurrenceCount: 2,
      remainingOccurrenceCount: 1,
      amountCents: 75,
    })
  })

  it('uses a first partial monthly cycle after the funding start boundary', () => {
    const input = {
      recurrenceRule: 'semimonthly:15,eom' as const,
      anchorDate: '2026-01-15',
      fundingStartsOn: '2026-01-20',
      dueRule: { kind: 'legacy_monthly' as const, dueDay: 31 },
      fundingMode: 'set_aside' as const,
      targetAmountCents: 100,
      currentBalanceCents: 0,
    }

    expect(planDueDateFunding({ ...input, occurrenceDate: '2026-01-15' })).toBeNull()
    expect(planDueDateFunding({ ...input, occurrenceDate: '2026-01-31' })).toEqual({
      deadline: '2026-01-31',
      cycleOccurrenceCount: 1,
      remainingOccurrenceCount: 1,
      amountCents: 100,
    })
    expect(planDueDateFunding({ ...input, occurrenceDate: '2026-02-15' })).toEqual({
      deadline: '2026-02-28',
      cycleOccurrenceCount: 2,
      remainingOccurrenceCount: 2,
      amountCents: 50,
    })
  })

  it('uses a first partial cycle for canonical recurring due dates', () => {
    const input = {
      recurrenceRule: 'semimonthly:15,eom' as const,
      anchorDate: '2026-01-15',
      fundingStartsOn: '2026-01-20',
      dueRule: { kind: 'recurring' as const, frequency: 'monthly' as const, anchorDate: '2026-01-15' },
      fundingMode: 'set_aside' as const,
      targetAmountCents: 100,
      currentBalanceCents: 0,
    }

    expect(planDueDateFunding({ ...input, occurrenceDate: '2026-01-15' })).toBeNull()
    expect(planDueDateFunding({ ...input, occurrenceDate: '2026-01-31' })).toEqual({
      deadline: '2026-02-15',
      cycleOccurrenceCount: 2,
      remainingOccurrenceCount: 2,
      amountCents: 50,
    })
  })

  it('excludes historical schedule ticks before fundingStartsOn', () => {
    const input = {
      recurrenceRule: 'daily' as const,
      anchorDate: '2026-01-01',
      fundingStartsOn: '2026-01-03',
      dueRule: { kind: 'once' as const, targetDate: '2026-01-05' },
      fundingMode: 'set_aside' as const,
      targetAmountCents: 101,
      currentBalanceCents: 0,
    }

    expect(planDueDateFunding({ ...input, occurrenceDate: '2026-01-01' })).toBeNull()
    expect(planDueDateFunding({ ...input, occurrenceDate: '2026-01-03' })).toEqual({
      deadline: '2026-01-05',
      cycleOccurrenceCount: 3,
      remainingOccurrenceCount: 3,
      amountCents: 34,
    })
  })

  it('ceiling-rounds set_aside amounts from the whole cycle', () => {
    expect(
      planDueDateFunding({
        recurrenceRule: 'semimonthly:1,15',
        anchorDate: '2026-01-01',
        occurrenceDate: '2026-01-01',
        dueRule: { kind: 'legacy_monthly', dueDay: 31 },
        fundingMode: 'set_aside',
        targetAmountCents: 101,
        currentBalanceCents: 0,
      }),
    ).toMatchObject({ cycleOccurrenceCount: 2, amountCents: 51 })
  })

  it('includes a recurring deadline and starts the next cycle after it', () => {
    const input = {
      recurrenceRule: 'daily' as const,
      anchorDate: '2026-01-01',
      dueRule: { kind: 'recurring' as const, frequency: 'monthly' as const, anchorDate: '2026-01-31' },
      fundingMode: 'set_aside' as const,
      targetAmountCents: 100,
      currentBalanceCents: 0,
    }

    expect(planDueDateFunding({ ...input, occurrenceDate: '2026-01-31' })).toMatchObject({
      deadline: '2026-01-31',
      cycleOccurrenceCount: 31,
      remainingOccurrenceCount: 1,
      amountCents: 4,
    })
    expect(planDueDateFunding({ ...input, occurrenceDate: '2026-02-01' })).toMatchObject({
      deadline: '2026-02-28',
      cycleOccurrenceCount: 28,
      remainingOccurrenceCount: 28,
      amountCents: 4,
    })
  })

  it('applies set_aside and reach_target math across a weekly due cycle', () => {
    const base = {
      recurrenceRule: 'semimonthly:7,10' as const,
      anchorDate: '2026-01-07',
      dueRule: { kind: 'recurring' as const, frequency: 'weekly' as const, anchorDate: '2026-01-14' },
      targetAmountCents: 100,
    }

    expect(
      planDueDateFunding({ ...base, occurrenceDate: '2026-01-07', fundingMode: 'set_aside', currentBalanceCents: 0 }),
    ).toMatchObject({ cycleOccurrenceCount: 2, remainingOccurrenceCount: 2, amountCents: 50 })
    expect(
      planDueDateFunding({ ...base, occurrenceDate: '2026-01-10', fundingMode: 'set_aside', currentBalanceCents: 100 }),
    ).toMatchObject({ cycleOccurrenceCount: 2, remainingOccurrenceCount: 1, amountCents: 50 })

    expect(
      planDueDateFunding({ ...base, occurrenceDate: '2026-01-07', fundingMode: 'reach_target', currentBalanceCents: 0 }),
    ).toMatchObject({ cycleOccurrenceCount: 2, remainingOccurrenceCount: 2, amountCents: 50 })
    expect(
      planDueDateFunding({ ...base, occurrenceDate: '2026-01-10', fundingMode: 'reach_target', currentBalanceCents: 50 }),
    ).toMatchObject({ cycleOccurrenceCount: 2, remainingOccurrenceCount: 1, amountCents: 50 })
  })

  it('keeps legacy dueDay planning compatible with monthly clamping', () => {
    const input = {
      recurrenceRule: 'daily' as const,
      anchorDate: '2026-01-01',
      dueRule: { kind: 'legacy_monthly' as const, dueDay: 31 },
      fundingMode: 'set_aside' as const,
      targetAmountCents: 100,
      currentBalanceCents: 0,
    }

    expect(planDueDateFunding({ ...input, occurrenceDate: '2026-01-31' })).toMatchObject({
      deadline: '2026-01-31',
      cycleOccurrenceCount: 31,
      amountCents: 4,
    })
    expect(planDueDateFunding({ ...input, occurrenceDate: '2026-02-01' })).toMatchObject({
      deadline: '2026-02-28',
      cycleOccurrenceCount: 28,
      amountCents: 4,
    })
  })

  it('only allows a terminal checkpoint for an entirely empty cycle', () => {
    const emptyCycle = planDueDateFunding({
      recurrenceRule: 'monthly',
      anchorDate: '2026-01-01',
      fundingStartsOn: '2026-01-20',
      occurrenceDate: '2026-01-31',
      dueRule: { kind: 'legacy_monthly', dueDay: 31 },
      fundingMode: 'set_aside',
      targetAmountCents: 10_001,
      currentBalanceCents: 1,
    })
    expect(emptyCycle).toEqual({
      deadline: '2026-01-31',
      cycleOccurrenceCount: 0,
      remainingOccurrenceCount: 0,
      amountCents: 10_001,
    })

    expect(
      planDueDateFunding({
        recurrenceRule: 'monthly',
        anchorDate: '2026-01-01',
        fundingStartsOn: '2026-01-20',
        occurrenceDate: '2026-01-31',
        dueRule: { kind: 'legacy_monthly', dueDay: 31 },
        fundingMode: 'reach_target',
        targetAmountCents: 10_001,
        currentBalanceCents: 4_000,
      }),
    ).toMatchObject({ cycleOccurrenceCount: 0, remainingOccurrenceCount: 0, amountCents: 6_001 })

    expect(
      planDueDateFunding({
        recurrenceRule: 'monthly',
        anchorDate: '2026-01-01',
        occurrenceDate: '2026-01-30',
        dueRule: { kind: 'legacy_monthly', dueDay: 31 },
        fundingMode: 'set_aside',
        targetAmountCents: 100,
        currentBalanceCents: 0,
      }),
    ).toBeNull()

    expect(
      planDueDateFunding({
        recurrenceRule: 'monthly',
        anchorDate: '2026-01-31',
        occurrenceDate: '2026-01-31',
        dueRule: { kind: 'legacy_monthly', dueDay: 31 },
        fundingMode: 'set_aside',
        targetAmountCents: 100,
        currentBalanceCents: 0,
      }),
    ).toEqual({
      deadline: '2026-01-31',
      cycleOccurrenceCount: 1,
      remainingOccurrenceCount: 1,
      amountCents: 100,
    })
  })

  it('rejects non-empty checkpoints and counts a coincident scheduled date once', () => {
    const checkpoint = planDueDateFunding({
      recurrenceRule: 'weekly',
      anchorDate: '2026-01-01',
      occurrenceDate: '2026-01-05',
      dueRule: { kind: 'once', targetDate: '2026-01-05' },
      fundingMode: 'reach_target',
      targetAmountCents: 10_001,
      currentBalanceCents: 1,
    })
    expect(checkpoint).toBeNull()

    const scheduledOnDeadline = planDueDateFunding({
      recurrenceRule: 'weekly',
      anchorDate: '2026-01-05',
      occurrenceDate: '2026-01-05',
      dueRule: { kind: 'once', targetDate: '2026-01-05' },
      fundingMode: 'reach_target',
      targetAmountCents: 10_001,
      currentBalanceCents: 1,
    })
    expect(scheduledOnDeadline).toEqual({
      deadline: '2026-01-05',
      cycleOccurrenceCount: 1,
      remainingOccurrenceCount: 1,
      amountCents: 10_000,
    })
  })

  it('rejects unscheduled non-deadline occurrences', () => {
    expect(
      planDueDateFunding({
        recurrenceRule: 'weekly',
        anchorDate: '2026-01-01',
        occurrenceDate: '2026-01-03',
        dueRule: { kind: 'once', targetDate: '2026-01-05' },
        fundingMode: 'reach_target',
        targetAmountCents: 100,
        currentBalanceCents: 0,
      }),
    ).toBeNull()
  })
})

describe('computeOccurrenceAmount', () => {
  const dueDate = '2026-01-15'

  it('funds a fixed amount every period for set_aside', () => {
    const bucket = { type: 'expense' as const, fundingMode: 'set_aside' as const, targetAmountCents: 20_000, currentCents: 100_000 }
    expect(computeOccurrenceAmount(bucket, dueDate, 5)).toBe(20_000)
    expect(computeOccurrenceAmount(bucket, dueDate, 1)).toBe(20_000)
  })

  it('defaults missing fundingMode to set_aside behavior', () => {
    const bucket = { type: 'goal' as const, targetAmountCents: 5_000, currentCents: 0 }
    expect(computeOccurrenceAmount(bucket, dueDate, 3)).toBe(5_000)
  })

  it('tops up reach_target buckets toward their target', () => {
    const bucket = { type: 'expense' as const, fundingMode: 'reach_target' as const, targetAmountCents: 50_000, currentCents: 30_000 }
    expect(computeOccurrenceAmount(bucket, dueDate, 2)).toBe(20_000)
  })

  it('pauses reach_target buckets once filled (amount 0)', () => {
    const bucket = { type: 'expense' as const, fundingMode: 'reach_target' as const, targetAmountCents: 50_000, currentCents: 50_000 }
    expect(computeOccurrenceAmount(bucket, dueDate, 2)).toBe(0)
  })

  it('never overfills reach_target past the target', () => {
    const bucket = { type: 'expense' as const, fundingMode: 'reach_target' as const, targetAmountCents: 50_000, currentCents: 60_000 }
    expect(computeOccurrenceAmount(bucket, dueDate, 2)).toBe(0)
  })

  it('divides vault funding evenly with ceiling rounding', () => {
    // $1000 target over 3 remaining periods → ceil(100000/3) = 33334.
    const bucket = { type: 'vault' as const, targetAmountCents: 100_000, targetDate: '2026-04-01', currentCents: 0 }
    expect(computeOccurrenceAmount(bucket, dueDate, 3)).toBe(33_334)
  })

  it('self-corrects vault amounts as the balance grows', () => {
    // After two ticks of 33334: current 66668, one period left → remainder 33332.
    const bucket = { type: 'vault' as const, targetAmountCents: 100_000, targetDate: '2026-04-01', currentCents: 66_668 }
    expect(computeOccurrenceAmount(bucket, dueDate, 1)).toBe(33_332)
  })

  it('stops funding a vault once its target is reached', () => {
    const bucket = { type: 'vault' as const, targetAmountCents: 100_000, targetDate: '2026-04-01', currentCents: 100_000 }
    expect(computeOccurrenceAmount(bucket, dueDate, 2)).toBe(0)
  })

  it('returns 0 for overfilled vaults (min 0)', () => {
    const bucket = { type: 'vault' as const, targetAmountCents: 100_000, targetDate: '2026-04-01', currentCents: 120_000 }
    expect(computeOccurrenceAmount(bucket, dueDate, 2)).toBe(0)
  })

  it('funds the full remainder when no periods remain', () => {
    const bucket = { type: 'vault' as const, targetAmountCents: 100_000, targetDate: '2026-04-01', currentCents: 40_000 }
    expect(computeOccurrenceAmount(bucket, dueDate, 0)).toBe(60_000)
  })

  it('treats vaults without a target date like regular buckets', () => {
    const bucket = { type: 'vault' as const, fundingMode: 'set_aside' as const, targetAmountCents: 10_000, targetDate: null, currentCents: 0 }
    expect(computeOccurrenceAmount(bucket, dueDate, 4)).toBe(10_000)
  })

  it('rejects non-integer cents', () => {
    expect(() =>
      computeOccurrenceAmount({ type: 'expense', targetAmountCents: 10.5, currentCents: 0 }, dueDate, 1),
    ).toThrow()
  })
})

describe('computeBucketDrawdown', () => {
  it('applies the full spend when the bucket can cover it', () => {
    // Funded $200 → spend $50 → bucket balance $150.
    const drawdown = computeBucketDrawdown(-5_000, 20_000)
    expect(drawdown).toBe(-5_000)
    expect(20_000 + drawdown).toBe(15_000)
  })

  it('clamps the bucket at zero and spills the remainder to FTS', () => {
    // Bucket holds $30, spend $50 → draw $30, $20 spills to FTS implicitly.
    const drawdown = computeBucketDrawdown(-5_000, 3_000)
    expect(drawdown).toBe(-3_000)
    expect(3_000 + drawdown).toBe(0)
    expect(5_000 - 3_000).toBe(2_000) // spilled
  })

  it('draws nothing from an empty bucket', () => {
    expect(computeBucketDrawdown(-5_000, 0)).toBe(0)
  })

  it('is exact at the break-even boundary', () => {
    expect(computeBucketDrawdown(-3_000, 3_000)).toBe(-3_000)
  })
})
