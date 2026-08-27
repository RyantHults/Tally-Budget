import type { ExpenseDueFrequency } from './domain.js'
export type { ExpenseDueFrequency } from './domain.js'

/**
 * Funding engine (plan §6) — pure, timezone-free date math on YYYY-MM-DD strings.
 *
 * Recurrence rules are stored strings:
 *   'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly'
 *   'semimonthly:<A>,<B>' — A and B are each 1–31 or 'eom', A ≠ B.
 *     e.g. 'semimonthly:15,eom' (15th + end-of-month)
 *          'semimonthly:1,15'   (classic start+mid)
 *          'semimonthly:10,eom' (user's date + end-of-month)
 *          'semimonthly:1,20'   (start of month + date)
 *
 * The anchor date is the FIRST occurrence; all expansions derive their phase
 * from it. Month-end anchors clamp to short months (anchor on the 31st → Feb
 * gets the 28th/29th) without losing phase — March returns to the 31st.
 */

export type RecurrenceRule = string

// ---- Rule validation ----

const BASIC_RULES = new Set(['daily', 'weekly', 'biweekly', 'monthly', 'yearly'])
const SEMIMONTHLY_RE = /^semimonthly:(\d{1,2}|eom),(\d{1,2}|eom)$/

/**
 * Returns true when `rule` is a well-formed recurrence rule that expandSchedule
 * can handle.  Validates both the basic anchor-based frequencies and the
 * parameterised `semimonthly:A,B` grammar.
 */
export function isValidRecurrenceRule(rule: string): boolean {
  const trimmed = rule.trim().toLowerCase()
  if (BASIC_RULES.has(trimmed)) return true

  const m = SEMIMONTHLY_RE.exec(trimmed)
  if (!m) return false

  const [, rawA, rawB] = m
  // A ≠ B
  if (rawA === rawB) return false

  // Numeric days must be 1–31
  const a = Number(rawA)
  const b = Number(rawB)
  if (Number.isFinite(a) && (a < 1 || a > 31)) return false
  if (Number.isFinite(b) && (b < 1 || b > 31)) return false

  return true
}

// ---- Internal helpers ----

const YMDD = /^(\d{4})-(\d{2})-(\d{2})$/
/** Hard stop for pathological anchors (e.g. year 1000) — ~274 years of daily ticks. */
const MAX_ITERATIONS = 100_000

export interface Ymd {
  year: number
  month: number
  day: number
}

export function parseYmd(value: string): Ymd {
  const m = YMDD.exec(value)
  if (!m) throw new Error(`Invalid YYYY-MM-DD date: ${JSON.stringify(value)}`)
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`Invalid calendar date: ${JSON.stringify(value)}`)
  }
  return { year, month, day }
}

export function formatYmd({ year, month, day }: Ymd): string {
  return (
    String(year).padStart(4, '0') +
    '-' +
    String(month).padStart(2, '0') +
    '-' +
    String(day).padStart(2, '0')
  )
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31
    case 4:
    case 6:
    case 9:
    case 11:
      return 30
    case 2:
      return isLeapYear(year) ? 29 : 28
    default:
      throw new Error(`Invalid month: ${month}`)
  }
}

/** Timezone-free day arithmetic via UTC — avoids DST/local-offset surprises. */
export function addDaysYmd(value: string, days: number): string {
  const { year, month, day } = parseYmd(value)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return formatYmd({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  })
}

export function ymdToUtcDate(value: string): Date {
  const { year, month, day } = parseYmd(value)
  return new Date(Date.UTC(year, month - 1, day))
}

function shiftMonths(year: number, month: number, months: number): Ymd {
  const total = year * 12 + (month - 1) + months
  return { year: Math.floor(total / 12), month: (total % 12) + 1, day: 1 }
}

function assertAlive(iterations: number, rule: string): void {
  if (iterations > MAX_ITERATIONS) {
    throw new Error(`Recurrence expansion exceeded bounds for rule "${rule}"`)
  }
}

/**
 * Expand a recurrence into its occurrence dates within [fromDate, toDate]
 * (inclusive), ascending. The anchor is the first occurrence ever — dates
 * before fromDate participate in phase derivation but are filtered out.
 * Returns UTC-midnight Date objects; string comparisons on YYYY-MM-DD are
 * order-safe throughout.
 */
export function expandSchedule(
  ruleRaw: string,
  anchorDate: string,
  fromDate: string,
  toDate: string,
): Date[] {
  const rule = ruleRaw.trim().toLowerCase()
  parseYmd(anchorDate)
  parseYmd(fromDate)
  parseYmd(toDate)
  if (anchorDate > toDate) return []

  const out: string[] = []

  switch (rule) {
    case 'daily':
    case 'weekly':
    case 'biweekly': {
      const step = rule === 'daily' ? 1 : rule === 'weekly' ? 7 : 14
      let cursor = anchorDate
      let iterations = 0
      while (cursor <= toDate) {
        assertAlive(++iterations, rule)
        if (cursor >= fromDate) out.push(cursor)
        cursor = addDaysYmd(cursor, step)
      }
      break
    }

    case 'monthly': {
      const anchor = parseYmd(anchorDate)
      let months = 0
      let iterations = 0
      for (;;) {
        assertAlive(++iterations, rule)
        const shifted = shiftMonths(anchor.year, anchor.month, months++)
        // Month-end anchors clamp to the short month without losing phase.
        const day = Math.min(anchor.day, daysInMonth(shifted.year, shifted.month))
        const cursor = formatYmd({ ...shifted, day })
        if (cursor > toDate) break
        if (cursor >= fromDate) out.push(cursor)
      }
      break
    }

    case 'yearly': {
      const anchor = parseYmd(anchorDate)
      let years = 0
      let iterations = 0
      for (;;) {
        assertAlive(++iterations, rule)
        const year = anchor.year + years++
        // Feb 29 anchors land on Feb 28 in common years.
        const month = anchor.month
        const day = Math.min(anchor.day, daysInMonth(year, month))
        const cursor = formatYmd({ year, month, day })
        if (cursor > toDate) break
        if (cursor >= fromDate) out.push(cursor)
      }
      break
    }

    case '1st-and-15th':
    case 'semimonthly': {
      // Legacy alias — always 1st and 15th.
      const anchor = parseYmd(anchorDate)
      let { year, month } = anchor
      let iterations = 0
      for (;;) {
        assertAlive(++iterations, rule)
        let exhausted = true
        for (const day of [1, 15]) {
          const cursor = formatYmd({ year, month, day })
          if (cursor > toDate) continue
          exhausted = false
          if (cursor >= anchorDate && cursor >= fromDate) out.push(cursor)
        }
        if (exhausted) break
        const next = shiftMonths(year, month, 1)
        year = next.year
        month = next.month
      }
      break
    }

    default: {
      // Parameterised semimonthly: semimonthly:<A>,<B>
      const smMatch = SEMIMONTHLY_RE.exec(rule)
      if (!smMatch) throw new Error(`Unsupported recurrence rule: ${JSON.stringify(ruleRaw)}`)

      const [, rawA, rawB] = smMatch
      const anchor = parseYmd(anchorDate)
      let { year, month } = anchor
      let iterations = 0
      for (;;) {
        assertAlive(++iterations, rule)
        let exhausted = true

        // Resolve both days for this month.
        const dayA = rawA === 'eom' ? daysInMonth(year, month) : Math.min(Number(rawA), daysInMonth(year, month))
        const dayB = rawB === 'eom' ? daysInMonth(year, month) : Math.min(Number(rawB), daysInMonth(year, month))

        // Emit in ascending order, dedup when both collapse to same date.
        const days = dayA === dayB ? [dayA] : [Math.min(dayA, dayB), Math.max(dayA, dayB)]
        for (const day of days) {
          const cursor = formatYmd({ year, month, day })
          if (cursor > toDate) continue
          exhausted = false
          if (cursor >= anchorDate && cursor >= fromDate) out.push(cursor)
        }
        if (exhausted) break
        const next = shiftMonths(year, month, 1)
        year = next.year
        month = next.month
      }
      break
    }
  }

  return out.map(ymdToUtcDate)
}

// ---- Due-date funding planning ----

/** Calendar cadence used by canonical recurring expense due dates. */
const EXPENSE_DUE_FREQUENCIES: ReadonlySet<ExpenseDueFrequency> = new Set([
  'monthly',
  'weekly',
  'biweekly',
  'quarterly',
  'semiannual',
  'annual',
])

/**
 * A bucket's deadline rule. Canonical recurring rules carry their own anchor;
 * legacy monthly rules retain the old day-of-month behavior.
 */
export type DueRule =
  | { kind: 'recurring'; frequency: ExpenseDueFrequency; anchorDate: string }
  | { kind: 'legacy_monthly'; dueDay: number }
  | { kind: 'once'; targetDate: string }

export type DueDateFundingMode = 'set_aside' | 'reach_target'

export interface DueDateFundingInput {
  recurrenceRule: RecurrenceRule
  anchorDate: string
  occurrenceDate: string
  dueRule: DueRule
  fundingMode: DueDateFundingMode
  /** First eligible date; omitted/null means the recurrence anchor. */
  fundingStartsOn?: string | null
  targetAmountCents: number
  currentBalanceCents: number
}

export interface DueDateFundingPlan {
  deadline: string
  cycleOccurrenceCount: number
  remainingOccurrenceCount: number
  amountCents: number
}

/** Ineligible occurrences have no plan. */
export type DueDateFundingResult = DueDateFundingPlan | null

function validateDueRule(dueRule: DueRule): void {
  if (dueRule.kind === 'recurring') {
    if (!EXPENSE_DUE_FREQUENCIES.has(dueRule.frequency)) {
      throw new Error(`Unsupported expense due frequency: ${JSON.stringify(dueRule.frequency)}`)
    }
    parseYmd(dueRule.anchorDate)
    return
  }

  if (dueRule.kind === 'legacy_monthly') {
    if (!Number.isInteger(dueRule.dueDay) || dueRule.dueDay < 1 || dueRule.dueDay > 31) {
      throw new Error(`Monthly dueDay must be an integer from 1 through 31, got ${dueRule.dueDay}`)
    }
    return
  }

  if (dueRule.kind === 'once') {
    parseYmd(dueRule.targetDate)
    return
  }

  throw new Error(`Unsupported due rule: ${JSON.stringify(dueRule)}`)
}

function validateDueDateFundingMode(fundingMode: DueDateFundingMode): void {
  if (fundingMode !== 'set_aside' && fundingMode !== 'reach_target') {
    throw new Error(`Unsupported due-date funding mode: ${JSON.stringify(fundingMode)}`)
  }
}

type RecurringDueRule = Extract<DueRule, { kind: 'recurring' }>
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

function calendarMonthsForFrequency(frequency: ExpenseDueFrequency): number {
  switch (frequency) {
    case 'monthly':
      return 1
    case 'quarterly':
      return 3
    case 'semiannual':
      return 6
    case 'annual':
      return 12
    default:
      throw new Error(`Frequency is not calendar-based: ${frequency}`)
  }
}

function recurringDeadlineAt(dueRule: RecurringDueRule, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Recurring due-date index must be a non-negative integer, got ${index}`)
  }

  if (dueRule.frequency === 'weekly' || dueRule.frequency === 'biweekly') {
    const step = dueRule.frequency === 'weekly' ? 7 : 14
    return addDaysYmd(dueRule.anchorDate, index * step)
  }

  const anchor = parseYmd(dueRule.anchorDate)
  const shifted = shiftMonths(anchor.year, anchor.month, index * calendarMonthsForFrequency(dueRule.frequency))
  return formatYmd({
    ...shifted,
    day: Math.min(anchor.day, daysInMonth(shifted.year, shifted.month)),
  })
}

function daysBetweenYmd(fromDate: string, toDate: string): number {
  return Math.round((ymdToUtcDate(toDate).getTime() - ymdToUtcDate(fromDate).getTime()) / MILLISECONDS_PER_DAY)
}

function recurringDeadlineOnOrAfter(dueRule: RecurringDueRule, occurrenceDate: string): string {
  if (occurrenceDate <= dueRule.anchorDate) return dueRule.anchorDate

  if (dueRule.frequency === 'weekly' || dueRule.frequency === 'biweekly') {
    const step = dueRule.frequency === 'weekly' ? 7 : 14
    let index = Math.ceil(daysBetweenYmd(dueRule.anchorDate, occurrenceDate) / step)
    let candidate = recurringDeadlineAt(dueRule, index)
    if (candidate < occurrenceDate) candidate = recurringDeadlineAt(dueRule, ++index)
    return candidate
  }

  const anchor = parseYmd(dueRule.anchorDate)
  const occurrence = parseYmd(occurrenceDate)
  const monthDelta = (occurrence.year - anchor.year) * 12 + occurrence.month - anchor.month
  const months = calendarMonthsForFrequency(dueRule.frequency)
  let index = Math.ceil(monthDelta / months)
  let candidate = recurringDeadlineAt(dueRule, index)
  if (candidate < occurrenceDate) candidate = recurringDeadlineAt(dueRule, ++index)
  return candidate
}

function recurringDeadlineIndex(dueRule: RecurringDueRule, deadline: string): number {
  if (deadline < dueRule.anchorDate) return -1

  let index: number
  if (dueRule.frequency === 'weekly' || dueRule.frequency === 'biweekly') {
    const step = dueRule.frequency === 'weekly' ? 7 : 14
    const elapsed = daysBetweenYmd(dueRule.anchorDate, deadline)
    if (elapsed % step !== 0) return -1
    index = elapsed / step
  } else {
    const anchor = parseYmd(dueRule.anchorDate)
    const date = parseYmd(deadline)
    const monthDelta = (date.year - anchor.year) * 12 + date.month - anchor.month
    const months = calendarMonthsForFrequency(dueRule.frequency)
    if (monthDelta < 0 || monthDelta % months !== 0) return -1
    index = monthDelta / months
  }

  return recurringDeadlineAt(dueRule, index) === deadline ? index : -1
}

function previousRecurringDeadline(dueRule: RecurringDueRule, deadline: string): string | null {
  const index = recurringDeadlineIndex(dueRule, deadline)
  return index <= 0 ? null : recurringDeadlineAt(dueRule, index - 1)
}

/**
 * Resolve the deadline applicable to an occurrence date.
 *
 * Recurring deadlines are the first due-cadence date on or after the
 * occurrence. Calendar cadences clamp their original anchor day independently
 * in each resulting month; weekly cadences preserve the due-rule weekday.
 * Legacy monthly rules retain their independently clamped day-of-month and
 * next-month rollover behavior.
 */
export function applicableDeadline(dueRule: DueRule, occurrenceDate: string): string | null {
  parseYmd(occurrenceDate)
  validateDueRule(dueRule)

  if (dueRule.kind === 'once') {
    return occurrenceDate <= dueRule.targetDate ? dueRule.targetDate : null
  }

  if (dueRule.kind === 'recurring') {
    return recurringDeadlineOnOrAfter(dueRule, occurrenceDate)
  }

  const occurrence = parseYmd(occurrenceDate)
  const currentDeadline = formatYmd({
    year: occurrence.year,
    month: occurrence.month,
    day: Math.min(dueRule.dueDay, daysInMonth(occurrence.year, occurrence.month)),
  })
  if (occurrenceDate <= currentDeadline) return currentDeadline

  const nextMonth = shiftMonths(occurrence.year, occurrence.month, 1)
  return formatYmd({
    ...nextMonth,
    day: Math.min(dueRule.dueDay, daysInMonth(nextMonth.year, nextMonth.month)),
  })
}

/**
 * Count recurrence dates in the inclusive range [fromDate, throughDate].
 * This delegates to the pure schedule expander instead of any materialized
 * occurrence horizon.
 */
export function countScheduledOccurrences(
  recurrenceRule: RecurrenceRule,
  anchorDate: string,
  fromDate: string,
  throughDate: string,
): number {
  return expandSchedule(recurrenceRule, anchorDate, fromDate, throughDate).length
}

function isScheduledOccurrence(recurrenceRule: RecurrenceRule, anchorDate: string, occurrenceDate: string): boolean {
  return countScheduledOccurrences(recurrenceRule, anchorDate, occurrenceDate, occurrenceDate) > 0
}

function validateFundingCents(targetAmountCents: number, currentBalanceCents: number): void {
  for (const value of [targetAmountCents, currentBalanceCents]) {
    if (!Number.isInteger(value)) {
      throw new Error(`planDueDateFunding expects integer cents, got ${value}`)
    }
  }
}

interface FundingCycle {
  startDate: string
  deadline: string
}

function effectiveFundingStart(anchorDate: string, fundingStartsOn: string | null | undefined): string {
  if (fundingStartsOn === undefined || fundingStartsOn === null) return anchorDate
  parseYmd(fundingStartsOn)
  return fundingStartsOn > anchorDate ? fundingStartsOn : anchorDate
}

function previousLegacyMonthlyDeadline(dueDay: number, deadline: string): string {
  const { year, month } = parseYmd(deadline)
  const previousMonth = shiftMonths(year, month, -1)
  return formatYmd({
    ...previousMonth,
    day: Math.min(dueDay, daysInMonth(previousMonth.year, previousMonth.month)),
  })
}

function fundingCycle(
  dueRule: DueRule,
  effectiveStart: string,
  occurrenceDate: string,
): FundingCycle | null {
  if (dueRule.kind === 'once') {
    if (effectiveStart > dueRule.targetDate) return null
    return { startDate: effectiveStart, deadline: dueRule.targetDate }
  }

  const firstDeadline = applicableDeadline(dueRule, effectiveStart)
  const deadline = applicableDeadline(dueRule, occurrenceDate)
  if (firstDeadline === null || deadline === null || deadline < firstDeadline) return null

  let previousDeadline: string | null
  if (dueRule.kind === 'recurring') {
    previousDeadline = previousRecurringDeadline(dueRule, deadline)
  } else {
    previousDeadline = previousLegacyMonthlyDeadline(dueRule.dueDay, deadline)
  }

  return {
    startDate: deadline === firstDeadline ? effectiveStart : previousDeadline ? addDaysYmd(previousDeadline, 1) : effectiveStart,
    deadline,
  }
}

/**
 * Plan one due-date-aware funding application from live bucket state.
 *
 * set_aside allocates a fixed amount across every scheduled occurrence in the
 * whole cycle. reach_target instead allocates the live remaining gap across
 * occurrences from the current one through the deadline.
 *
 * Normal applications must be actual schedule dates. An unscheduled date is
 * accepted only as a deadline checkpoint when the entire cycle has no
 * eligible schedule date. If a checkpoint shares a date with a scheduled
 * occurrence, the schedule date wins and is counted exactly once.
 */
export function planDueDateFunding(input: DueDateFundingInput): DueDateFundingResult {
  validateDueDateFundingMode(input.fundingMode)
  validateFundingCents(input.targetAmountCents, input.currentBalanceCents)

  parseYmd(input.anchorDate)
  parseYmd(input.occurrenceDate)
  const startDate = effectiveFundingStart(input.anchorDate, input.fundingStartsOn)
  const deadline = applicableDeadline(input.dueRule, input.occurrenceDate)
  if (deadline === null) return null
  if (input.occurrenceDate < startDate) return null

  const cycle = fundingCycle(input.dueRule, startDate, input.occurrenceDate)
  if (cycle === null) return null

  const cycleOccurrenceCount = countScheduledOccurrences(
    input.recurrenceRule,
    input.anchorDate,
    cycle.startDate,
    cycle.deadline,
  )
  const scheduled = isScheduledOccurrence(input.recurrenceRule, input.anchorDate, input.occurrenceDate)
  const remainingOccurrenceCount = scheduled
    ? countScheduledOccurrences(input.recurrenceRule, input.anchorDate, input.occurrenceDate, deadline)
    : 0

  // A terminal checkpoint is valid only for a genuinely empty cycle. Any
  // unscheduled non-deadline date, or a checkpoint for a non-empty cycle, is
  // ineligible.
  if (!scheduled && (input.occurrenceDate !== deadline || cycleOccurrenceCount !== 0)) return null

  const gap = Math.max(input.targetAmountCents - input.currentBalanceCents, 0)
  const amountCents = !scheduled
    ? input.fundingMode === 'set_aside'
      ? input.targetAmountCents
      : gap
    : input.fundingMode === 'set_aside'
      ? Math.ceil(input.targetAmountCents / cycleOccurrenceCount)
      : Math.ceil(gap / remainingOccurrenceCount)

  return {
    deadline,
    cycleOccurrenceCount,
    remainingOccurrenceCount,
    amountCents,
  }
}

export type FundingModeInput = 'set_aside' | 'reach_target' | null | undefined

export interface FundingBucketInput {
  type: 'expense' | 'goal' | 'vault'
  fundingMode?: FundingModeInput
  targetAmountCents: number
  targetDate?: string | null
  currentCents: number
}

/**
 * Amount to fund for one occurrence, computed from CURRENT state.
 *
 * - Vault with a target date (plan §6): ceil((target − current) / periodsRemaining),
 *   floored at 0 once filled/overfilled. periodsRemaining < 1 (final tick or
 *   unknown horizon) funds the entire remainder.
 * - reach_target: tops up to target, pauses (0) once filled.
 * - set_aside (default): fixed target amount every period, indefinitely.
 */
export function computeOccurrenceAmount(
  bucket: FundingBucketInput,
  _dueDate: string,
  periodsRemaining: number,
): number {
  for (const v of [bucket.targetAmountCents, bucket.currentCents]) {
    if (!Number.isInteger(v)) throw new Error(`computeOccurrenceAmount expects integer cents, got ${v}`)
  }
  if (!Number.isInteger(periodsRemaining)) {
    throw new Error(`periodsRemaining must be an integer, got ${periodsRemaining}`)
  }

  if (bucket.type === 'vault' && bucket.targetDate) {
    const remaining = Math.max(0, bucket.targetAmountCents - bucket.currentCents)
    if (remaining === 0) return 0
    if (periodsRemaining < 1) return remaining
    return Math.ceil(remaining / periodsRemaining)
  }

  if (bucket.fundingMode === 'reach_target') {
    return Math.max(0, bucket.targetAmountCents - bucket.currentCents)
  }

  return bucket.targetAmountCents
}

/**
 * Ledger drawdown applied to a bucket for a posted spend (plan §1/§4 step 5):
 * the bucket draws toward zero but NEVER below it — the remainder spills to FTS
 * implicitly (FTS is derived, no entry needed). txnAmountCents is signed
 * (negative = spend); the returned entry amount is likewise signed.
 */
export function computeBucketDrawdown(txnAmountCents: number, bucketBalanceCents: number): number {
  for (const v of [txnAmountCents, bucketBalanceCents]) {
    if (!Number.isInteger(v)) throw new Error(`computeBucketDrawdown expects integer cents, got ${v}`)
  }
  const drawdown = Math.max(txnAmountCents, -Math.max(0, bucketBalanceCents))
  return drawdown === 0 ? 0 : drawdown // normalize -0
}
