import { and, asc, eq, gt, lt, lte, sql } from 'drizzle-orm'
import {
  applicableDeadline,
  computeOccurrenceAmount,
  countScheduledOccurrences,
  expandSchedule,
  planDueDateFunding,
  type ExpenseDueFrequency,
  type DueRule,
  ymdToUtcDate,
} from '@tally/core'
import { db } from '../db/index.js'
import {
  buckets,
  budgets,
  fundingSchedules,
  ledgerEntries,
  scheduleOccurrences,
} from '../db/schema.js'
import { bucketBalance, type DbExecutor } from './ledger.js'

/**
 * Occurrence generation + idempotent funding sweeps (plan §6).
 *
 * Idempotency backbone: occurrences are UNIQUE(bucket_id, due_date) and
 * generation is onConflictDoNothing — regeneration can never double-fund.
 * Sweeps recompute amounts at apply-time from the CURRENT ledger balance
 * (vault math self-corrects), append kind='funding' entries keyed by
 * occurrence id (unique per (sourceType, sourceId, kind)), then flip the
 * occurrence to 'applied'. Missed ticks apply on the next run (catch-up).
 */

const HORIZON_DAYS = 60

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10)
}

function addDaysYmd(value: string, days: number): string {
  const d = ymdToUtcDate(value)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function effectiveFundingStart(anchorDate: string, fundingStartsOn: string | null): string {
  return fundingStartsOn !== null && fundingStartsOn > anchorDate ? fundingStartsOn : anchorDate
}

function dueRuleForBucket(
  type: 'expense' | 'goal' | 'vault',
  dueDate: string | null,
  dueFrequency: ExpenseDueFrequency | null,
  dueDay: number | null,
  targetDate: string | null,
): DueRule | null {
  if (type === 'expense' && dueDate !== null && dueFrequency !== null) {
    return { kind: 'recurring', frequency: dueFrequency, anchorDate: dueDate }
  }
  if (type === 'expense' && dueDay !== null) return { kind: 'legacy_monthly', dueDay }
  if ((type === 'goal' || type === 'vault') && targetDate !== null) {
    return { kind: 'once', targetDate }
  }
  return null
}

/** Due dates whose cycle has no eligible scheduled recurrence date. */
function recurringCheckpointDates(
  recurrenceRule: string,
  anchorDate: string,
  effectiveStart: string,
  dueRule: Exclude<DueRule, { kind: 'once' }>,
  throughDate: string,
): string[] {
  if (effectiveStart > throughDate) return []

  const checkpoints: string[] = []
  let cycleStart = effectiveStart
  let deadline = applicableDeadline(dueRule, cycleStart)
  while (deadline !== null && deadline <= throughDate) {
    if (countScheduledOccurrences(recurrenceRule, anchorDate, cycleStart, deadline) === 0) {
      checkpoints.push(deadline)
    }
    cycleStart = addDaysYmd(deadline, 1)
    deadline = applicableDeadline(dueRule, cycleStart)
  }
  return checkpoints
}

export interface GenerateOccurrencesResult {
  inserted: number
  bucketsProcessed: number
}

/**
 * Expand every fundable bucket's schedule from its anchor to now+60d and insert
 * missing occurrences. Amounts are advisory at generation time (computed from
 * the current ledger balance); the sweep recomputes authoritatively at apply-time.
 */
export async function generateOccurrences(budgetId: string): Promise<GenerateOccurrencesResult> {
  const rows = await db
    .select({
      bucketId: buckets.id,
      type: buckets.type,
      targetAmountCents: buckets.targetAmountCents,
      dueDate: buckets.dueDate,
      dueFrequency: buckets.dueFrequency,
      dueDay: buckets.dueDay,
      fundingStartsOn: buckets.fundingStartsOn,
      targetDate: buckets.targetDate,
      fundingMode: buckets.fundingMode,
      scheduleId: fundingSchedules.id,
      recurrenceRule: fundingSchedules.recurrenceRule,
      anchorDate: fundingSchedules.anchorDate,
    })
    .from(buckets)
    .innerJoin(fundingSchedules, eq(buckets.fundingScheduleId, fundingSchedules.id))
    .where(eq(buckets.budgetId, budgetId))

  const today = todayYmd()
  const horizon = addDaysYmd(today, HORIZON_DAYS)

  let inserted = 0
  for (const row of rows) {
    const dueRule = dueRuleForBucket(
      row.type,
      row.dueDate,
      row.dueFrequency,
      row.dueDay,
      row.targetDate,
    )
    const effectiveStart = dueRule
      ? effectiveFundingStart(row.anchorDate, row.fundingStartsOn)
      : row.anchorDate
    let generationEnd = horizon
    if (dueRule) {
      await db
        .delete(scheduleOccurrences)
        .where(
          and(
            eq(scheduleOccurrences.bucketId, row.bucketId),
            eq(scheduleOccurrences.status, 'pending'),
            lt(scheduleOccurrences.dueDate, effectiveStart),
          ),
        )
    }
    if (dueRule?.kind === 'once') {
      const targetDate = row.targetDate!
      if (targetDate < generationEnd) generationEnd = targetDate
      await db
        .delete(scheduleOccurrences)
        .where(
          and(
            eq(scheduleOccurrences.bucketId, row.bucketId),
            eq(scheduleOccurrences.status, 'pending'),
            gt(scheduleOccurrences.dueDate, targetDate),
          ),
        )
    }

    const dates = expandSchedule(row.recurrenceRule, row.anchorDate, effectiveStart, generationEnd).map(
      (date) => date.toISOString().slice(0, 10),
    )
    const checkpointDates =
      dueRule?.kind === 'once'
        ? effectiveStart <= row.targetDate! &&
          countScheduledOccurrences(row.recurrenceRule, row.anchorDate, effectiveStart, row.targetDate!) === 0
          ? [row.targetDate!]
          : []
        : dueRule
          ? recurringCheckpointDates(
              row.recurrenceRule,
              row.anchorDate,
              effectiveStart,
              dueRule,
              horizon,
            )
          : []
    const uniqueDates = [...new Set([...dates, ...checkpointDates])].sort()
    if (uniqueDates.length === 0) continue

    // Advisory amounts use one balance snapshot; apply-time recomputes anyway.
    const currentCents = await bucketBalance(row.bucketId)
    const values = uniqueDates.map((date, index) => ({
      bucketId: row.bucketId,
      scheduleId: row.scheduleId,
      dueDate: date,
      amountCents: dueRule
        ? (planDueDateFunding({
            recurrenceRule: row.recurrenceRule,
            anchorDate: row.anchorDate,
            occurrenceDate: date,
            dueRule,
            fundingMode: row.fundingMode ?? 'reach_target',
            fundingStartsOn: row.fundingStartsOn,
            targetAmountCents: row.targetAmountCents,
            currentBalanceCents: currentCents,
          })?.amountCents ?? 0)
        : computeOccurrenceAmount(
            {
              type: row.type,
              fundingMode: row.fundingMode,
              targetAmountCents: row.targetAmountCents,
              targetDate: row.targetDate,
              currentCents,
            },
            date,
            uniqueDates.length - index, // periods remaining in this horizon, including this tick
          ),
    }))
    for (let i = 0; i < values.length; i += 250) {
      const chunk = values.slice(i, i + 250)
      const result = await db
        .insert(scheduleOccurrences)
        .values(chunk)
        .onConflictDoNothing({
          target: [scheduleOccurrences.bucketId, scheduleOccurrences.dueDate],
        })
        .returning({ id: scheduleOccurrences.id })
      inserted += result.length
    }
  }
  return { inserted, bucketsProcessed: rows.length }
}

export interface SweepOutcome {
  applied: number
  skipped: number
  fundedCents: number
}

async function countPendingOccurrences(executor: DbExecutor, bucketId: string): Promise<number> {
  const rows = await executor
    .select({ total: sql<string>`count(*)` })
    .from(scheduleOccurrences)
    .where(and(eq(scheduleOccurrences.bucketId, bucketId), eq(scheduleOccurrences.status, 'pending')))
  return Number(rows[0]?.total ?? 0)
}

/**
 * Apply all due pending occurrences for one budget, in due-date order, inside a
 * single transaction. FTS is allowed to go negative here (automatic process,
 * plan §1) — zero-amount occurrences are marked 'skipped' instead of applied.
 */
export async function applyDueOccurrences(
  budgetId: string,
  log: { info(msg: string): void },
): Promise<SweepOutcome> {
  const today = todayYmd()
  const outcome: SweepOutcome = { applied: 0, skipped: 0, fundedCents: 0 }

  await db.transaction(async (tx) => {
    // Claim in order with FOR UPDATE SKIP LOCKED so concurrent sweeps divide work.
    const due = await tx
      .select({
        id: scheduleOccurrences.id,
        bucketId: scheduleOccurrences.bucketId,
        dueDate: scheduleOccurrences.dueDate,
        type: buckets.type,
        fundingMode: buckets.fundingMode,
        targetAmountCents: buckets.targetAmountCents,
        canonicalDueDate: buckets.dueDate,
        canonicalDueFrequency: buckets.dueFrequency,
        dueDay: buckets.dueDay,
        fundingStartsOn: buckets.fundingStartsOn,
        targetDate: buckets.targetDate,
        recurrenceRule: fundingSchedules.recurrenceRule,
        anchorDate: fundingSchedules.anchorDate,
      })
      .from(scheduleOccurrences)
      .innerJoin(buckets, eq(scheduleOccurrences.bucketId, buckets.id))
      .innerJoin(fundingSchedules, eq(scheduleOccurrences.scheduleId, fundingSchedules.id))
      .where(
        and(
          eq(buckets.budgetId, budgetId),
          eq(scheduleOccurrences.status, 'pending'),
          lte(scheduleOccurrences.dueDate, today),
        ),
      )
      .orderBy(asc(scheduleOccurrences.dueDate), asc(scheduleOccurrences.id))
      .for('update', { skipLocked: true })

    for (const occ of due) {
      const currentCents = await bucketBalance(occ.bucketId, tx)
      const dueRule = dueRuleForBucket(
        occ.type,
        occ.canonicalDueDate,
        occ.canonicalDueFrequency,
        occ.dueDay,
        occ.targetDate,
      )
      const amountCents = dueRule
        ? (planDueDateFunding({
            recurrenceRule: occ.recurrenceRule,
            anchorDate: occ.anchorDate,
            occurrenceDate: occ.dueDate,
            dueRule,
            fundingMode: occ.fundingMode ?? 'reach_target',
            fundingStartsOn: occ.fundingStartsOn,
            targetAmountCents: occ.targetAmountCents,
            currentBalanceCents: currentCents,
          })?.amountCents ?? 0)
        : computeOccurrenceAmount(
            {
              type: occ.type,
              fundingMode: occ.fundingMode,
              targetAmountCents: occ.targetAmountCents,
              targetDate: occ.targetDate,
              currentCents,
            },
            occ.dueDate,
            await countPendingOccurrences(tx, occ.bucketId),
          )

      if (amountCents <= 0) {
        const updated = await tx
          .update(scheduleOccurrences)
          .set({ amountCents, status: 'skipped' })
          .where(and(eq(scheduleOccurrences.id, occ.id), eq(scheduleOccurrences.status, 'pending')))
          .returning({ id: scheduleOccurrences.id })
        if (updated.length > 0) outcome.skipped++
        continue
      }

      // Unique (sourceType, sourceId, kind) makes replays harmless no-ops.
      await tx
        .insert(ledgerEntries)
        .values({
          budgetId,
          bucketId: occ.bucketId,
          kind: 'funding',
          amountCents,
          sourceType: 'occurrence',
          sourceId: occ.id,
        })
        .onConflictDoNothing()
      const updated = await tx
        .update(scheduleOccurrences)
        .set({ amountCents, status: 'applied', appliedAt: new Date() })
        .where(and(eq(scheduleOccurrences.id, occ.id), eq(scheduleOccurrences.status, 'pending')))
        .returning({ id: scheduleOccurrences.id })
      if (updated.length > 0) {
        outcome.applied++
        outcome.fundedCents += amountCents
      }
    }
  })

  if (outcome.applied > 0 || outcome.skipped > 0) {
    log.info(
      `Funding sweep for budget ${budgetId}: ${outcome.applied} applied ` +
        `(${outcome.fundedCents} cents), ${outcome.skipped} skipped`,
    )
  }
  return outcome
}

/** Full sweep pass: regenerate occurrences for every budget, then apply due ones. */
export async function runFundingSweeps(log: { info(msg: string): void }): Promise<void> {
  const allBudgets = await db.select({ id: budgets.id }).from(budgets)
  for (const budget of allBudgets) {
    await generateOccurrences(budget.id)
    await applyDueOccurrences(budget.id, log)
  }
}
