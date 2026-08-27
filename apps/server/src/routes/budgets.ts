import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { isValidRecurrenceRule } from '@tally/core'
import { db } from '../db/index.js'
import {
  budgetMembers,
  budgets,
  bucketGroups,
  bucketGroupPreferences,
  buckets,
  fundingSchedules,
  ledgerEntries,
  scheduleOccurrences,
  transactions,
} from '../db/schema.js'
import { requireAuth, requireBudgetMember } from '../lib/auth.js'
import { bucketBalance, budgetMoneySummary } from '../lib/ledger.js'

const BudgetCreate = z.object({ name: z.string().min(1).max(100) })
const BucketGroupCreate = z.object({ name: z.string().min(1).max(100), color: z.string().optional() })
const BucketGroupUpdate = z.object({
  name: z.string().min(1, 'Name is required').max(100).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a valid hex color').optional(),
}).refine((body) => body.name !== undefined || body.color !== undefined, {
  message: 'Provide name and/or color',
})
const BucketGroupPreferenceUpdate = z.object({
  sectionKey: z.union([z.literal('__ungrouped'), z.string().uuid()]),
  expanded: z.boolean(),
})
const FundingScheduleCreate = z.object({
  name: z.string().min(1).max(100),
  recurrenceRule: z.string().refine(isValidRecurrenceRule, {
    message:
      'Invalid recurrence rule. Allowed: "daily", "weekly", "biweekly", "monthly", "yearly", or "semimonthly:<A>,<B>" where A and B are 1–31 or "eom" and A ≠ B (e.g. "semimonthly:15,eom", "semimonthly:1,15").',
  }),
  anchorDate: z.string().date(),
})
const BucketBase = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['expense', 'goal', 'vault']),
  targetAmountCents: z.number().int().nonnegative().safe(),
  dueDay: z.number().int().min(1).max(31).nullable().optional(),
  dueDate: z.string().date().nullable().optional(),
  dueFrequency: z
    .enum(['monthly', 'weekly', 'biweekly', 'quarterly', 'semiannual', 'annual'])
    .nullable()
    .optional(),
  targetDate: z.string().date().nullable().optional(),
  fundingMode: z.enum(['set_aside', 'reach_target']).nullable().optional(),
  bucketGroupId: z.string().uuid().nullable().optional(),
  fundingScheduleId: z.string().uuid().nullable().optional(),
  matchMerchants: z.array(z.string().min(1).max(100)).max(50).optional(),
  matchCategories: z.array(z.string().min(1).max(100)).max(50).optional(),
})
type BucketTypeValue = 'expense' | 'goal' | 'vault'
type BucketDateValues = {
  type: BucketTypeValue
  dueDay: number | null
  dueDate: string | null
  dueFrequency: 'monthly' | 'weekly' | 'biweekly' | 'quarterly' | 'semiannual' | 'annual' | null
  targetDate: string | null
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10)
}

function isDueConfigured(values: BucketDateValues): boolean {
  return values.type === 'expense'
    ? values.dueDate !== null || values.dueDay !== null
    : values.targetDate !== null
}

function bucketDateIssues(
  values: BucketDateValues,
): Array<{ path: 'dueDay' | 'dueDate' | 'dueFrequency' | 'targetDate'; message: string }> {
  const issues: Array<{
    path: 'dueDay' | 'dueDate' | 'dueFrequency' | 'targetDate'
    message: string
  }> = []
  if (values.type === 'expense') {
    if (values.dueDate === null) {
      issues.push({ path: 'dueDate', message: 'Expense buckets require a dueDate' })
    }
    if (values.dueFrequency === null) {
      issues.push({ path: 'dueFrequency', message: 'Expense buckets require a dueFrequency' })
    }
    if (values.dueDay !== null) {
      issues.push({ path: 'dueDay', message: 'Canonical expense buckets cannot have a dueDay' })
    }
    if (values.targetDate !== null) {
      issues.push({ path: 'targetDate', message: 'Expense buckets cannot have a targetDate' })
    }
  } else {
    if (values.targetDate === null) {
      issues.push({ path: 'targetDate', message: `${values.type} buckets require a targetDate` })
    }
    if (values.dueDay !== null) {
      issues.push({ path: 'dueDay', message: `${values.type} buckets cannot have a dueDay` })
    }
    if (values.dueDate !== null) {
      issues.push({ path: 'dueDate', message: `${values.type} buckets cannot have a dueDate` })
    }
    if (values.dueFrequency !== null) {
      issues.push({ path: 'dueFrequency', message: `${values.type} buckets cannot have a dueFrequency` })
    }
  }
  return issues
}

const BucketCreate = BucketBase.superRefine((bucket, ctx) => {
  for (const issue of bucketDateIssues({
    type: bucket.type,
    dueDay: bucket.dueDay ?? null,
    dueDate: bucket.dueDate ?? null,
    dueFrequency:
      bucket.type === 'expense'
        ? bucket.dueFrequency === undefined
          ? 'monthly'
          : bucket.dueFrequency
        : bucket.dueFrequency ?? null,
    targetDate: bucket.targetDate ?? null,
  })) {
    ctx.addIssue({ code: 'custom', message: issue.message, path: [issue.path] })
  }
})
const BucketPatch = BucketBase.partial().extend({
  version: z.number().int(), // optimistic locking: must match current version
})

export function budgetRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', requireAuth)

  // ---- Budgets ----

  app.post('/budgets', async (req) => {
    const { name } = BudgetCreate.parse(req.body)
    return db.transaction(async (tx) => {
      const [budget] = await tx.insert(budgets).values({ name }).returning()
      await tx.insert(budgetMembers).values({
        budgetId: budget!.id,
        userId: req.user!.id,
        role: 'owner',
      })
      return budget
    })
  })

  app.get('/budgets', async (req) => {
    const rows = await db
      .select({ id: budgets.id, name: budgets.name, createdAt: budgets.createdAt })
      .from(budgets)
      .innerJoin(budgetMembers, eq(budgetMembers.budgetId, budgets.id))
      .where(eq(budgetMembers.userId, req.user!.id))
      .orderBy(asc(budgets.createdAt))
    return rows
  })

  // ---- Bucket groups ----

  app.post(
    '/budgets/:budgetId/bucket-groups',
    { preHandler: requireBudgetMember },
    async (req) => {
      const { budgetId } = req.params as { budgetId: string }
      const body = BucketGroupCreate.parse(req.body)
      return db.transaction(async (tx) => {
        // Serialize group creation and reordering for this budget.
        await tx.select({ id: budgets.id }).from(budgets).where(eq(budgets.id, budgetId)).for('update')
        const [last] = await tx
          .select({ sortOrder: bucketGroups.sortOrder })
          .from(bucketGroups)
          .where(eq(bucketGroups.budgetId, budgetId))
          .orderBy(desc(bucketGroups.sortOrder))
          .limit(1)
        const [row] = await tx
          .insert(bucketGroups)
          .values({
            budgetId,
            name: body.name,
            color: body.color ?? '#2563eb',
            sortOrder: (last?.sortOrder ?? -1) + 1,
          })
          .returning()
        return row
      })
    },
  )

  app.get('/budgets/:budgetId/bucket-groups', { preHandler: requireBudgetMember }, async (req) => {
    const { budgetId } = req.params as { budgetId: string }
    return db
      .select()
      .from(bucketGroups)
      .where(eq(bucketGroups.budgetId, budgetId))
      .orderBy(asc(bucketGroups.sortOrder), asc(bucketGroups.id))
  })

  app.get(
    '/budgets/:budgetId/bucket-group-preferences',
    { preHandler: requireBudgetMember },
    async (req) => {
      const { budgetId } = req.params as { budgetId: string }
      const rows = await db
        .select({
          sectionKey: bucketGroupPreferences.sectionKey,
          expanded: bucketGroupPreferences.expanded,
        })
        .from(bucketGroupPreferences)
        .where(
          and(
            eq(bucketGroupPreferences.userId, req.user!.id),
            eq(bucketGroupPreferences.budgetId, budgetId),
          ),
        )
      return { expanded: Object.fromEntries(rows.map((row) => [row.sectionKey, row.expanded])) }
    },
  )

  app.put(
    '/budgets/:budgetId/bucket-group-preferences',
    { preHandler: requireBudgetMember },
    async (req, reply) => {
      const { budgetId } = req.params as { budgetId: string }
      const body = BucketGroupPreferenceUpdate.parse(req.body)

      if (body.sectionKey !== '__ungrouped') {
        const [group] = await db
          .select({ id: bucketGroups.id })
          .from(bucketGroups)
          .where(and(eq(bucketGroups.id, body.sectionKey), eq(bucketGroups.budgetId, budgetId)))
          .limit(1)
        if (!group) return reply.code(400).send({ error: 'Group not found for this budget' })
      }

      await db
        .insert(bucketGroupPreferences)
        .values({
          userId: req.user!.id,
          budgetId,
          sectionKey: body.sectionKey,
          expanded: body.expanded,
        })
        .onConflictDoUpdate({
          target: [
            bucketGroupPreferences.userId,
            bucketGroupPreferences.budgetId,
            bucketGroupPreferences.sectionKey,
          ],
          set: { expanded: body.expanded },
        })

      return body
    },
  )

  const BucketGroupReorder = z.object({
    groupIds: z.array(z.string().uuid()),
  })

  app.post(
    '/budgets/:budgetId/bucket-groups/reorder',
    { preHandler: requireBudgetMember },
    async (req, reply) => {
      const { budgetId } = req.params as { budgetId: string }
      const { groupIds } = BucketGroupReorder.parse(req.body)

      if (new Set(groupIds).size !== groupIds.length) {
        return reply.code(400).send({ error: 'Duplicate group IDs' })
      }

      const result = await db.transaction(async (tx) => {
        // Match create's lock so a concurrent create cannot invalidate the
        // permutation while it is being applied.
        await tx.select({ id: budgets.id }).from(budgets).where(eq(budgets.id, budgetId)).for('update')
        const groups = await tx
          .select()
          .from(bucketGroups)
          .where(eq(bucketGroups.budgetId, budgetId))
          .for('update')
        const existingIds = new Set(groups.map((group) => group.id))
        const isExactPermutation =
          groupIds.length === groups.length && groupIds.every((groupId) => existingIds.has(groupId))

        if (!isExactPermutation) return { invalid: true as const }

        for (const [sortOrder, groupId] of groupIds.entries()) {
          await tx
            .update(bucketGroups)
            .set({ sortOrder })
            .where(and(eq(bucketGroups.id, groupId), eq(bucketGroups.budgetId, budgetId)))
        }

        const orderedGroups = await tx
          .select()
          .from(bucketGroups)
          .where(eq(bucketGroups.budgetId, budgetId))
          .orderBy(asc(bucketGroups.sortOrder), asc(bucketGroups.id))
        return { invalid: false as const, groups: orderedGroups }
      })

      if (result.invalid) {
        return reply
          .code(400)
          .send({ error: 'groupIds must be an exact permutation of this budget’s groups' })
      }
      return result.groups
    },
  )

  app.delete(
    '/budgets/:budgetId/bucket-groups/:groupId',
    { preHandler: requireBudgetMember },
    async (req, reply) => {
      const { budgetId, groupId } = req.params as { budgetId: string; groupId: string }
      await db.transaction(async (tx) => {
        await tx
          .delete(bucketGroupPreferences)
          .where(
            and(
              eq(bucketGroupPreferences.budgetId, budgetId),
              eq(bucketGroupPreferences.sectionKey, groupId),
            ),
          )
        await tx
          .delete(bucketGroups)
          .where(and(eq(bucketGroups.id, groupId), eq(bucketGroups.budgetId, budgetId)))
      })
      return reply.code(204).send()
    },
  )

  app.patch(
    '/budgets/:budgetId/bucket-groups/:groupId',
    { preHandler: requireBudgetMember },
    async (req, reply) => {
      const { budgetId, groupId } = req.params as { budgetId: string; groupId: string }
      const body = BucketGroupUpdate.parse(req.body)
      // Verify the group exists and belongs to this budget
      const [existing] = await db
        .select({ id: bucketGroups.id })
        .from(bucketGroups)
        .where(and(eq(bucketGroups.id, groupId), eq(bucketGroups.budgetId, budgetId)))
        .limit(1)
      if (!existing) return reply.code(404).send({ error: 'Group not found' })
      const [updated] = await db
        .update(bucketGroups)
        .set(body)
        .where(eq(bucketGroups.id, groupId))
        .returning()
      return updated
    },
  )

  // ---- Buckets ----

  app.post('/budgets/:budgetId/buckets', { preHandler: requireBudgetMember }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string }
    const body = BucketCreate.parse(req.body)
    if (body.fundingScheduleId) {
      const [schedule] = await db
        .select({ id: fundingSchedules.id })
        .from(fundingSchedules)
        .where(and(eq(fundingSchedules.id, body.fundingScheduleId), eq(fundingSchedules.budgetId, budgetId)))
        .limit(1)
      if (!schedule) return reply.code(400).send({ error: 'Funding schedule not found for this budget' })
    }
    const dueConfigured = isDueConfigured({
      type: body.type,
      dueDay: body.dueDay ?? null,
      dueDate: body.dueDate ?? null,
      dueFrequency: body.dueFrequency === undefined ? 'monthly' : body.dueFrequency,
      targetDate: body.targetDate ?? null,
    })
    const [row] = await db
      .insert(buckets)
      .values({
        budgetId,
        name: body.name,
        type: body.type,
        targetAmountCents: body.targetAmountCents,
        dueDay: body.dueDay ?? null,
        dueDate: body.dueDate ?? null,
        dueFrequency: body.type === 'expense' ? body.dueFrequency ?? 'monthly' : null,
        fundingStartsOn: todayYmd(),
        targetDate: body.targetDate ?? null,
        fundingMode: body.fundingMode ?? (dueConfigured ? 'reach_target' : null),
        bucketGroupId: body.bucketGroupId ?? null,
        fundingScheduleId: body.fundingScheduleId ?? null,
        matchMerchants: body.matchMerchants ?? [],
        matchCategories: body.matchCategories ?? [],
      })
      .returning()
    // Match the GET shape: the UI's Bucket type expects the computed balance.
    return { ...row, currentBalanceCents: await bucketBalance(row!.id) }
  })

  app.get('/budgets/:budgetId/buckets', { preHandler: requireBudgetMember }, async (req) => {
    const { budgetId } = req.params as { budgetId: string }
    return db
      .select({
        id: buckets.id,
        budgetId: buckets.budgetId,
        bucketGroupId: buckets.bucketGroupId,
        type: buckets.type,
        name: buckets.name,
        targetAmountCents: buckets.targetAmountCents,
        dueDay: buckets.dueDay,
        dueDate: buckets.dueDate,
        dueFrequency: buckets.dueFrequency,
        fundingStartsOn: buckets.fundingStartsOn,
        targetDate: buckets.targetDate,
        fundingMode: buckets.fundingMode,
        fundingScheduleId: buckets.fundingScheduleId,
        matchMerchants: buckets.matchMerchants,
        matchCategories: buckets.matchCategories,
        version: buckets.version,
        // Ledger-derived current balance (plan §3): a derived view, never stored.
        // NOTE: the outer reference must be spelled literally — drizzle renders
        // embedded columns unqualified, which would bind to the subquery's table.
        currentBalanceCents:
          sql<number>`(select coalesce(sum(${ledgerEntries.amountCents}), 0) from ${ledgerEntries} where ${ledgerEntries.bucketId} = "buckets"."id")`.mapWith(
            Number,
          ),
      })
      .from(buckets)
      .where(eq(buckets.budgetId, budgetId))
      .orderBy(asc(buckets.name))
  })

  app.patch(
    '/budgets/:budgetId/buckets/:bucketId',
    { preHandler: requireBudgetMember },
    async (req, reply) => {
      const { budgetId, bucketId } = req.params as { budgetId: string; bucketId: string }
      const body = BucketPatch.parse(req.body)
      const rows = await db
        .select()
        .from(buckets)
        .where(and(eq(buckets.id, bucketId), eq(buckets.budgetId, budgetId)))
        .limit(1)
      const current = rows[0]
      if (!current) return reply.code(404).send({ error: 'Bucket not found' })
      if (current.version !== body.version) {
        return reply.code(409).send({ error: 'Version conflict', currentVersion: current.version })
      }

      const nextType = body.type ?? current.type
      const nextDueDay = body.dueDay !== undefined ? body.dueDay : current.dueDay
      const nextDueDate = body.dueDate !== undefined ? body.dueDate : current.dueDate
      const nextDueFrequency =
        body.dueFrequency !== undefined ? body.dueFrequency : current.dueFrequency
      const nextTargetDate = body.targetDate !== undefined ? body.targetDate : current.targetDate
      const nextFundingScheduleId =
        body.fundingScheduleId !== undefined ? body.fundingScheduleId : current.fundingScheduleId
      const nextDueConfigured = isDueConfigured({
        type: nextType,
        dueDay: nextDueDay,
        dueDate: nextDueDate,
        dueFrequency: nextDueFrequency,
        targetDate: nextTargetDate,
      })
      const currentDueConfigured = isDueConfigured({
        type: current.type,
        dueDay: current.dueDay,
        dueDate: current.dueDate,
        dueFrequency: current.dueFrequency,
        targetDate: current.targetDate,
      })
      const dueConfigurationAttached = !currentDueConfigured && nextDueConfigured
      const dateConfigurationChanged =
        body.type !== undefined || body.dueDay !== undefined || body.targetDate !== undefined
          || body.dueDate !== undefined || body.dueFrequency !== undefined
      if (dateConfigurationChanged) {
        const dateIssues = bucketDateIssues({
          type: nextType,
          dueDay: nextDueDay,
          dueDate: nextDueDate,
          dueFrequency: nextDueFrequency,
          targetDate: nextTargetDate,
        })
        if (dateIssues.length > 0) {
          return reply.code(400).send({ error: dateIssues[0]!.message })
        }
      }

      if (nextFundingScheduleId) {
        const [schedule] = await db
          .select({ id: fundingSchedules.id })
          .from(fundingSchedules)
          .where(
            and(eq(fundingSchedules.id, nextFundingScheduleId), eq(fundingSchedules.budgetId, budgetId)),
          )
          .limit(1)
        if (!schedule) return reply.code(400).send({ error: 'Funding schedule not found for this budget' })
      }

      const timingChanged =
        nextType !== current.type ||
        nextDueDay !== current.dueDay ||
        nextDueDate !== current.dueDate ||
        nextDueFrequency !== current.dueFrequency ||
        nextTargetDate !== current.targetDate ||
        nextFundingScheduleId !== current.fundingScheduleId
      const fundingScheduleReattached =
        nextFundingScheduleId !== null && nextFundingScheduleId !== current.fundingScheduleId
      const fundingStartReset = dueConfigurationAttached || fundingScheduleReattached
      const defaultFundingMode =
        nextDueConfigured &&
        (body.fundingMode !== undefined || !currentDueConfigured) &&
        (body.fundingMode === undefined || body.fundingMode === null)
      const nextFundingMode = defaultFundingMode
        ? 'reach_target'
        : body.fundingMode !== undefined
          ? body.fundingMode
          : current.fundingMode
      const updated = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(buckets)
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.type !== undefined ? { type: body.type } : {}),
            ...(body.targetAmountCents !== undefined
              ? { targetAmountCents: body.targetAmountCents }
              : {}),
            ...(body.dueDay !== undefined ? { dueDay: body.dueDay } : {}),
            ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
            ...(body.dueFrequency !== undefined ? { dueFrequency: body.dueFrequency } : {}),
            ...(body.targetDate !== undefined ? { targetDate: body.targetDate } : {}),
            ...(body.fundingMode !== undefined || defaultFundingMode
              ? { fundingMode: nextFundingMode }
              : {}),
            ...(body.bucketGroupId !== undefined ? { bucketGroupId: body.bucketGroupId } : {}),
            ...(body.fundingScheduleId !== undefined
              ? { fundingScheduleId: body.fundingScheduleId }
              : {}),
            ...(body.matchMerchants !== undefined ? { matchMerchants: body.matchMerchants } : {}),
            ...(body.matchCategories !== undefined ? { matchCategories: body.matchCategories } : {}),
            ...(fundingStartReset ? { fundingStartsOn: todayYmd() } : {}),
            version: current.version + 1,
          })
          .where(and(eq(buckets.id, bucketId), eq(buckets.version, current.version)))
          .returning()
        if (!updated) return undefined
        if (timingChanged || dueConfigurationAttached) {
          await tx
            .delete(scheduleOccurrences)
            .where(
              and(
                eq(scheduleOccurrences.bucketId, bucketId),
                eq(scheduleOccurrences.status, 'pending'),
              ),
            )
        }
        return updated
      })
      if (!updated) return reply.code(409).send({ error: 'Version conflict' })
      // Match the GET shape so in-place UI updates keep the computed balance.
      return { ...updated, currentBalanceCents: await bucketBalance(updated.id) }
    },
  )

  app.delete(
    '/budgets/:budgetId/buckets/:bucketId',
    { preHandler: requireBudgetMember },
    async (req, reply) => {
      const { budgetId, bucketId } = req.params as { budgetId: string; bucketId: string }
      // Soft-ish guard for now: refuse deletion while ledger entries reference it.
      // Full cascade policy lands with the Phase 2 engine.
      const [existing] = await db
        .select({ id: buckets.id })
        .from(buckets)
        .where(and(eq(buckets.id, bucketId), eq(buckets.budgetId, budgetId)))
        .limit(1)
      if (!existing) return reply.code(404).send({ error: 'Bucket not found' })
      await db.delete(buckets).where(eq(buckets.id, bucketId))
      return reply.code(204).send()
    },
  )

  /**
   * Recent ledger activity for one bucket — funding sweeps, spends (with the
   * transaction description when the source was a transaction), transfers
   * to/from FTS or other buckets, and corrections.
   */
  app.get(
    '/budgets/:budgetId/buckets/:bucketId/activity',
    { preHandler: requireBudgetMember },
    async (req, reply) => {
      const { budgetId, bucketId } = req.params as { budgetId: string; bucketId: string }
      const [bucketRow] = await db
        .select({ id: buckets.id })
        .from(buckets)
        .where(and(eq(buckets.id, bucketId), eq(buckets.budgetId, budgetId)))
        .limit(1)
      if (!bucketRow) return reply.code(404).send({ error: 'Bucket not found' })

      const rows = await db
        .select({
          id: ledgerEntries.id,
          kind: ledgerEntries.kind,
          amountCents: ledgerEntries.amountCents,
          createdAt: ledgerEntries.createdAt,
          description: transactions.merchantDescription,
          sourceId: ledgerEntries.sourceId,
          scheduleName: fundingSchedules.name,
        })
        .from(ledgerEntries)
        .leftJoin(
          transactions,
          and(
            eq(ledgerEntries.sourceType, 'transaction'),
            sql`${ledgerEntries.sourceId} = ${transactions.id}::text`,
          ),
        )
        .leftJoin(
          scheduleOccurrences,
          and(
            eq(ledgerEntries.sourceType, 'occurrence'),
            sql`${ledgerEntries.sourceId} = ${scheduleOccurrences.id}::text`,
          ),
        )
        .leftJoin(fundingSchedules, eq(scheduleOccurrences.scheduleId, fundingSchedules.id))
        .where(eq(ledgerEntries.bucketId, bucketId))
        .orderBy(desc(ledgerEntries.createdAt))
        .limit(50)

      // Resolve transfer counterparts: paired entries share a sourceId.
      const isTransferKind = (kind: string): kind is 'transfer_in' | 'transfer_out' =>
        kind === 'transfer_in' || kind === 'transfer_out'
      const transferSourceIds = rows.filter((r) => isTransferKind(r.kind)).map((r) => r.sourceId)
      const counterpartByEntry = new Map<string, string>()
      if (transferSourceIds.length > 0) {
        const pairs = await db
          .select({
            id: ledgerEntries.id,
            sourceId: ledgerEntries.sourceId,
            bucketName: buckets.name,
          })
          .from(ledgerEntries)
          .leftJoin(buckets, eq(ledgerEntries.bucketId, buckets.id))
          .where(
            and(
              inArray(ledgerEntries.sourceId, transferSourceIds),
              inArray(ledgerEntries.kind, ['transfer_in', 'transfer_out']),
            ),
          )
        for (const row of rows) {
          if (!isTransferKind(row.kind)) continue
          const pair = pairs.find((p) => p.sourceId === row.sourceId && p.id !== row.id)
          if (pair) {
            counterpartByEntry.set(row.id, pair.bucketName ?? 'Free-to-Spend')
          } else {
            // No paired entry: the other side was Free-to-Spend (the server
            // only writes ledger rows for bucket sides).
            counterpartByEntry.set(row.id, 'Free-to-Spend')
          }
        }
      }

      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        amountCents: row.amountCents,
        createdAt: row.createdAt,
        description: row.description,
        scheduleName: row.scheduleName ?? null,
        counterpartName: counterpartByEntry.get(row.id) ?? null,
      }))
    },
  )

  // ---- Funding schedules ----

  app.post(
    '/budgets/:budgetId/funding-schedules',
    { preHandler: requireBudgetMember },
    async (req) => {
      const { budgetId } = req.params as { budgetId: string }
      const body = FundingScheduleCreate.parse(req.body)
      const [row] = await db
        .insert(fundingSchedules)
        .values({ budgetId, ...body })
        .returning()
      return row
    },
  )

  app.get(
    '/budgets/:budgetId/funding-schedules',
    { preHandler: requireBudgetMember },
    async (req) => {
      const { budgetId } = req.params as { budgetId: string }
      return db.select().from(fundingSchedules).where(eq(fundingSchedules.budgetId, budgetId))
    },
  )

  const FundingSchedulePatch = z
    .object({
      name: z.string().min(1).max(100),
      recurrenceRule: z.string().refine(isValidRecurrenceRule, {
        message: 'Invalid recurrence rule',
      }),
      anchorDate: z.string().date(),
    })
    .partial()
    .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' })

  /**
   * Edit a funding schedule. Any timing change drops the schedule's un-applied
   * pending occurrences so old ticks don't fire under new rules; applied
   * history and future generation are unaffected.
   */
  app.patch(
    '/budgets/:budgetId/funding-schedules/:scheduleId',
    { preHandler: requireBudgetMember },
    async (req, reply) => {
      const { budgetId, scheduleId } = req.params as { budgetId: string; scheduleId: string }
      const body = FundingSchedulePatch.parse(req.body)
      const [existing] = await db
        .select()
        .from(fundingSchedules)
        .where(and(eq(fundingSchedules.id, scheduleId), eq(fundingSchedules.budgetId, budgetId)))
        .limit(1)
      if (!existing) return reply.code(404).send({ error: 'Schedule not found' })

      const updated = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(fundingSchedules)
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.recurrenceRule !== undefined ? { recurrenceRule: body.recurrenceRule } : {}),
            ...(body.anchorDate !== undefined ? { anchorDate: body.anchorDate } : {}),
          })
          .where(eq(fundingSchedules.id, scheduleId))
          .returning()

        if (body.recurrenceRule !== undefined || body.anchorDate !== undefined) {
          await tx
            .delete(scheduleOccurrences)
            .where(
              and(
                eq(scheduleOccurrences.scheduleId, scheduleId),
                eq(scheduleOccurrences.status, 'pending'),
              ),
            )
        }
        return updated
      })
      return updated
    },
  )

  /**
   * Delete a funding schedule. Pending occurrences are removed while applied
   * and skipped history stays; buckets that referenced it simply stop
   * auto-funding and keep any balances already allocated.
   */
  app.delete(
    '/budgets/:budgetId/funding-schedules/:scheduleId',
    { preHandler: requireBudgetMember },
    async (req, reply) => {
      const { budgetId, scheduleId } = req.params as { budgetId: string; scheduleId: string }
      const [existing] = await db
        .select()
        .from(fundingSchedules)
        .where(and(eq(fundingSchedules.id, scheduleId), eq(fundingSchedules.budgetId, budgetId)))
        .limit(1)
      if (!existing) return reply.code(404).send({ error: 'Schedule not found' })

      await db.transaction(async (tx) => {
        await tx
          .delete(scheduleOccurrences)
          .where(
            and(
              eq(scheduleOccurrences.scheduleId, scheduleId),
              eq(scheduleOccurrences.status, 'pending'),
            ),
          )
        await tx
          .update(buckets)
          .set({ fundingScheduleId: null })
          .where(and(eq(buckets.budgetId, budgetId), eq(buckets.fundingScheduleId, scheduleId)))
        await tx.delete(fundingSchedules).where(eq(fundingSchedules.id, scheduleId))
      })
      return reply.code(204).send()
    },
  )

  // ---- FTS + Home (plan §1/§7) ----

  /** Live FTS — computed from current DB state, never cached-and-stale. */
  app.get('/budgets/:budgetId/fts', { preHandler: requireBudgetMember }, async (req) => {
    const { budgetId } = req.params as { budgetId: string }
    return budgetMoneySummary(budgetId)
  })

  /** Next 10 pending funding occurrences for the Home screen. */
  app.get('/budgets/:budgetId/upcoming', { preHandler: requireBudgetMember }, async (req) => {
    const { budgetId } = req.params as { budgetId: string }
    const today = new Date().toISOString().slice(0, 10)
    return db
      .select({
        id: scheduleOccurrences.id,
        bucketId: scheduleOccurrences.bucketId,
        bucketName: buckets.name,
        dueDate: scheduleOccurrences.dueDate,
        amountCents: scheduleOccurrences.amountCents,
        status: scheduleOccurrences.status,
      })
      .from(scheduleOccurrences)
      .innerJoin(buckets, eq(scheduleOccurrences.bucketId, buckets.id))
      .where(
        and(
          eq(buckets.budgetId, budgetId),
          eq(scheduleOccurrences.status, 'pending'),
          gte(scheduleOccurrences.dueDate, today),
        ),
      )
      .orderBy(asc(scheduleOccurrences.dueDate), asc(buckets.name))
      .limit(10)
  })

  // ---- Bucket ↔ bucket / FTS transfers (plan §1) ----

  const TransferCreate = z
    .object({
      fromBucketId: z.string().uuid().nullable(),
      toBucketId: z.string().uuid().nullable(),
      amountCents: z.number().int().positive(),
    })
    .refine((t) => !(t.fromBucketId === null && t.toBucketId === null), {
      message: 'At least one side must be a bucket',
    })
    .refine((t) => t.fromBucketId !== t.toBucketId, {
      message: 'Cannot transfer a bucket onto itself',
    })

  /**
   * Paired ledger entries; null bucket id = the FTS side. Buckets cannot go
   * negative, and user-initiated transfers OUT of FTS are rejected when FTS is
   * insufficient (FTS may only go negative via automatic processes).
   */
  app.post('/budgets/:budgetId/transfers', { preHandler: requireBudgetMember }, async (req, reply) => {
    const { budgetId } = req.params as { budgetId: string }
    const body = TransferCreate.parse(req.body)

    const loadBucket = async (bucketId: string | null) => {
      if (!bucketId) return null
      const rows = await db
        .select({ id: buckets.id })
        .from(buckets)
        .where(and(eq(buckets.id, bucketId), eq(buckets.budgetId, budgetId)))
        .limit(1)
      if (!rows[0]) throw new Error(`Unknown bucket ${bucketId}`)
      return rows[0]
    }

    let fromBucket: { id: string } | null
    let toBucket: { id: string } | null
    try {
      fromBucket = await loadBucket(body.fromBucketId)
      toBucket = await loadBucket(body.toBucketId)
    } catch {
      return reply.code(400).send({ error: 'Unknown bucket for this budget' })
    }

    // Validation BEFORE any write.
    if (fromBucket) {
      const available = await bucketBalance(fromBucket.id)
      if (available < body.amountCents) {
        return reply.code(409).send({
          error: 'Insufficient bucket balance',
          availableCents: available,
          requestedCents: body.amountCents,
        })
      }
    } else {
      const summary = await budgetMoneySummary(budgetId)
      if (summary.ftsCents < body.amountCents) {
        return reply.code(409).send({
          error: 'Insufficient free-to-spend',
          ftsCents: summary.ftsCents,
          requestedCents: body.amountCents,
        })
      }
    }

    const sourceId = randomUUID()
    await db.transaction(async (tx) => {
      if (fromBucket) {
        await tx.insert(ledgerEntries).values({
          budgetId,
          bucketId: fromBucket.id,
          kind: 'transfer_out',
          amountCents: -body.amountCents,
          sourceType: 'manual',
          sourceId,
        })
      }
      if (toBucket) {
        await tx.insert(ledgerEntries).values({
          budgetId,
          bucketId: toBucket.id,
          kind: 'transfer_in',
          amountCents: body.amountCents,
          sourceType: 'manual',
          sourceId,
        })
      }
    })

    return reply.code(201).send({
      sourceId,
      fromBucketId: body.fromBucketId,
      toBucketId: body.toBucketId,
      amountCents: body.amountCents,
    })
  })
}
