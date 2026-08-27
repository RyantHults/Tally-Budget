import { and, asc, desc, eq, ilike, inArray, isNull } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AccountType } from '@tally/core'
import { descriptorSimilarity } from '@tally/core'
import { db } from '../db/index.js'
import {
  accounts,
  buckets,
  categories,
  categoryMappings,
  connections,
  creditCardConfigs,
  providerAccounts,
  providerCredentials,
  transactions,
} from '../db/schema.js'
import { isBudgetMember, requireBudgetMember } from '../lib/auth.js'
import { decryptPayload, encryptPayload } from '../lib/crypto.js'
import {
  claimSetupToken,
  fetchAccounts,
  SimplefinError,
  type SimplefinFetchResult,
} from '../lib/simplefin.js'
import { reassignTransactionRouting } from '../lib/spend-routing.js'
import { enqueueSimplefinSync } from '../jobs/index.js'
import { bucketBalance } from '../lib/ledger.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ClaimBody = z.object({
  setupToken: z.string().min(1),
  budgetId: z.string().uuid(),
})

const LinkBody = z.object({
  budgetId: z.string().uuid(),
  providerAccountIds: z.array(z.string().min(1)).min(1, 'At least one account ID is required'),
})

const AccountPatch = z.object({
  name: z.string().min(1).max(200).optional(),
  status: z.enum(['active', 'archived']).optional(),
  type: z.enum(['checking', 'savings', 'cd', 'credit_card']).optional(),
})

const TransactionListQuery = z.object({
  accountId: z.string().uuid().optional(),
  status: z.enum(['pending', 'posted', 'superseded']).optional(),
  needsReview: z.coerce.boolean().optional(),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

const TransactionPatch = z
  .object({
    categoryId: z.string().uuid().nullable().optional(),
    bucketId: z.string().uuid().nullable().optional(),
  })
  .refine((body) => body.categoryId !== undefined || body.bucketId !== undefined, {
    message: 'Provide categoryId and/or bucketId',
  })

/**
 * Require that the authenticated user is a member of the budget identified
 * by `budgetId` in the request body. Generic: works with any body shape that
 * contains a `budgetId` field.
 */
async function requireBudgetMemberFromBody(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user) {
    await reply.code(401).send({ error: 'Not authenticated' })
    return
  }
  const body = req.body as Record<string, unknown> | undefined
  const budgetId = typeof body?.budgetId === 'string' ? body.budgetId : null
  if (!budgetId || !UUID_RE.test(budgetId)) {
    await reply.code(400).send({ error: 'A valid budgetId is required' })
    return
  }
  if (!(await isBudgetMember(req.user.id, budgetId))) {
    await reply.code(403).send({ error: 'Not a member of this budget' })
  }
}

/** Infer our account taxonomy from the institution's account name (best effort). */
function inferAccountType(name: string): AccountType {
  if (/credit|card|visa|master|amex/i.test(name)) return 'credit_card'
  if (/sav/i.test(name)) return 'savings'
  if (/\bcd\b|certificate/i.test(name)) return 'cd'
  return 'checking'
}

type DiscoveryPayload = SimplefinFetchResult

/**
 * Upsert Connection + provider_accounts rows from a discovery payload, then
 * auto-link every still-unlinked provider account into the given budget
 * (default-all: linking is never gated behind a selection step).
 * Returns how many provider accounts ended up linked.
 *
 * NOTE: some institutions/upstreams return accounts without a populated
 * top-level connections[] list — so we derive connections from the accounts'
 * own connectionId values and only use the payload's connections[] for names.
 */
async function persistDiscoveryAndLink(discovered: DiscoveryPayload, budgetId: string): Promise<number> {
  const nameByConn = new Map(discovered.connections.map((c) => [c.connectionId, c]))
  const connIdsInOrder = [...new Set(discovered.accounts.map((a) => a.connectionId))]
  let linkedCount = 0

  for (const connectionId of connIdsInOrder) {
    const meta = nameByConn.get(connectionId)
    const orgName = meta?.orgName ?? meta?.name ?? 'SimpleFin connection'
    const [connRow] = await db
      .insert(connections)
      .values({
        providerName: 'simplefin',
        providerConnectionId: connectionId,
        orgName,
        status: 'active',
      })
      .onConflictDoUpdate({
        target: [connections.providerName, connections.providerConnectionId],
        set: { orgName },
      })
      .returning()
    if (!connRow) continue

    for (const acct of discovered.accounts.filter((a) => a.connectionId === connectionId)) {
      const inferredType = inferAccountType(acct.name)
      const [pa] = await db
        .insert(providerAccounts)
        .values({
          connectionId: connRow.id,
          providerAccountId: acct.id,
          name: acct.name,
          inferredType,
          balanceCents: acct.balanceCents,
          currency: acct.currency,
        })
        .onConflictDoUpdate({
          target: [providerAccounts.connectionId, providerAccounts.providerAccountId],
          set: { name: acct.name, inferredType, balanceCents: acct.balanceCents },
        })
        .returning()
      if (!pa) continue
      if (pa.linkedAccountId) {
        // Already linked — keep the local Account row fresh.
        await db
          .update(accounts)
          .set({
            name: pa.name,
            reportedBalanceCents: pa.balanceCents,
            reportedBalanceDate: acct.balanceDate ?? new Date(),
          })
          .where(eq(accounts.id, pa.linkedAccountId))
        linkedCount++
        continue
      }
      linkedCount += await linkProviderAccount(pa.id, {
        connectionId: connRow.id,
        providerAccountId: acct.id,
        name: acct.name,
        inferredType,
        balanceCents: acct.balanceCents,
        currency: acct.currency,
        balanceDate: acct.balanceDate ?? null,
      }, budgetId)
    }
  }
  return linkedCount
}

/**
 * Create (or reuse) the local Account row for a provider account within a
 * budget, point provider_accounts.linkedAccountId at it, and refresh its data.
 * Returns 1 when a link exists afterwards, 0 otherwise.
 */
async function linkProviderAccount(
  providerAccountRowId: string,
  pa: {
    connectionId: string
    providerAccountId: string
    name: string
    inferredType: AccountType
    balanceCents: number
    currency: string
    balanceDate: Date | null
  },
  budgetId: string,
): Promise<number> {
  const existing = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.budgetId, budgetId),
        eq(accounts.connectionId, pa.connectionId),
        eq(accounts.providerAccountId, pa.providerAccountId),
      ),
    )
    .limit(1)

  let accountId = existing[0]?.id
  if (!accountId) {
    const [created] = await db
      .insert(accounts)
      .values({
        budgetId,
        connectionId: pa.connectionId,
        providerAccountId: pa.providerAccountId,
        type: pa.inferredType,
        name: pa.name,
        reportedBalanceCents: pa.balanceCents,
        reportedBalanceDate: pa.balanceDate ?? new Date(),
        currency: pa.currency,
      })
      .returning({ id: accounts.id })
    accountId = created?.id
  } else {
    await db
      .update(accounts)
      .set({
        name: pa.name,
        reportedBalanceCents: pa.balanceCents,
        reportedBalanceDate: pa.balanceDate ?? new Date(),
      })
      .where(eq(accounts.id, accountId))
  }

  if (!accountId) return 0
  await db
    .update(providerAccounts)
    .set({ linkedAccountId: accountId })
    .where(eq(providerAccounts.id, providerAccountRowId))
  return 1
}

/** Refresh provider_accounts rows from a discovery payload without linking. */
export async function refreshDiscoveredAccounts(discovered: DiscoveryPayload): Promise<void> {
  const nameByConn = new Map(discovered.connections.map((c) => [c.connectionId, c]))
  const connIdsInOrder = [...new Set(discovered.accounts.map((a) => a.connectionId))]

  for (const connectionId of connIdsInOrder) {
    const meta = nameByConn.get(connectionId)
    const orgName = meta?.orgName ?? meta?.name ?? 'SimpleFin connection'
    const [connRow] = await db
      .insert(connections)
      .values({
        providerName: 'simplefin',
        providerConnectionId: connectionId,
        orgName,
        status: 'active',
      })
      .onConflictDoUpdate({
        target: [connections.providerName, connections.providerConnectionId],
        set: { orgName },
      })
      .returning()
    if (!connRow) continue
    for (const acct of discovered.accounts.filter((a) => a.connectionId === connectionId)) {
      await db
        .insert(providerAccounts)
        .values({
          connectionId: connRow.id,
          providerAccountId: acct.id,
          name: acct.name,
          inferredType: inferAccountType(acct.name),
          balanceCents: acct.balanceCents,
          currency: acct.currency,
        })
        .onConflictDoUpdate({
          target: [providerAccounts.connectionId, providerAccounts.providerAccountId],
          set: {
            name: acct.name,
            inferredType: inferAccountType(acct.name),
            balanceCents: acct.balanceCents,
          },
        })
    }
  }
}

export function integrationRoutes(app: FastifyInstance): void {
  // ---- SimpleFin claim flow (discover + select accounts) ----

  /**
   * Step 1 of the wizard: claim a setup token and discover accounts.
   *
   * POST /api/integrations/simplefin/claim  {setupToken}
   *
   * On success: stores the encrypted Access URL at instance level and returns
   * discovered USD accounts (balances-only, no Account rows created yet).
   *
   * On 403 (already-claimed): if a stored access URL exists, logs a warning
   * and reuses it (reusedExistingConnection: true). If none exists, fails with
   * the real SimpleFin error message.
   */
  app.post('/integrations/simplefin/claim', async (req, reply) => {
    const body = ClaimBody.parse(req.body)

    // Check for an existing stored credential first.
    const [existingCred] = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.providerName, 'simplefin'))
      .limit(1)

    let accessUrl: string
    let reusedExistingConnection = false

    try {
      accessUrl = await claimSetupToken(body.setupToken)
    } catch (err) {
      if (err instanceof SimplefinError && err.statusCode === 403 && existingCred) {
        // Token was already claimed but we have a stored access URL — reuse it.
        app.log.warn(
          `Setup token was already claimed, reusing stored SimpleFin access URL: ${err.message}`,
        )
        try {
          accessUrl = decryptPayload(existingCred.encryptedPayload)
        } catch (decErr) {
          return reply.code(500).send({
            error: `Token was already claimed but stored credential could not be decrypted: ${String(decErr)}`,
          })
        }
        reusedExistingConnection = true
      } else if (err instanceof SimplefinError && err.statusCode === 403) {
        // 403 but no stored credential — surface the real SimpleFin error.
        return reply.code(400).send({
          error: `SimpleFin rejected the setup token: ${err.message}`,
        })
      } else {
        // Other errors — pass through the real message.
        return reply.code(400).send({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Persist the encrypted access URL if this was a fresh claim (not reuse).
    if (!reusedExistingConnection) {
      const encryptedPayload = encryptPayload(accessUrl)
      await db
        .insert(providerCredentials)
        .values({ providerName: 'simplefin', encryptedPayload })
        .onConflictDoUpdate({
          target: providerCredentials.providerName,
          set: { encryptedPayload },
        })
    }

    // Discover accounts (balances-only, USD filter) and persist + auto-link all.
    let discovered
    try {
      discovered = await fetchAccounts(accessUrl, {
        balancesOnly: true,
        logger: app.log,
      })
    } catch (err) {
      return reply.code(502).send({
        error: `Failed to discover SimpleFin accounts: ${err instanceof Error ? err.message : String(err)}`,
      })
    }

    const linkedCount = await persistDiscoveryAndLink(discovered, body.budgetId)

    return {
      reusedExistingConnection,
      linkedCount,
      totalDiscovered: discovered.accounts.length,
    }
  })

  // ---- SimpleFin link flow (manage linked accounts from stored discovery) ----

  /**
   * Link already-discovered provider accounts into a budget. Works purely off
   * stored provider_accounts rows — never calls SimpleFin, so browsing and
   * adjusting on the Accounts page costs none of the daily API quota.
   *
   * POST /api/integrations/simplefin/link  {budgetId, providerAccountIds}
   */
  app.post(
    '/integrations/simplefin/link',
    { preHandler: requireBudgetMemberFromBody },
    async (req, reply) => {
      const body = LinkBody.parse(req.body)

      const rows = await db
        .select({ pa: providerAccounts })
        .from(providerAccounts)
        .innerJoin(connections, eq(providerAccounts.connectionId, connections.id))
        .where(
          and(
            eq(connections.providerName, 'simplefin'),
            inArray(providerAccounts.providerAccountId, body.providerAccountIds),
          ),
        )

      const requested = new Set(body.providerAccountIds)
      let accountsCreated = 0
      let accountsSkipped = 0

      for (const { pa } of rows) {
        if (!requested.has(pa.providerAccountId)) continue

        if (pa.linkedAccountId) {
          // Already linked — just refresh the local row.
          await db
            .update(accounts)
            .set({
              name: pa.name,
              reportedBalanceCents: pa.balanceCents,
              reportedBalanceDate: new Date(),
            })
            .where(eq(accounts.id, pa.linkedAccountId))
          accountsSkipped++
          continue
        }

        accountsCreated += await linkProviderAccount(pa.id, {
          connectionId: pa.connectionId,
          providerAccountId: pa.providerAccountId,
          name: pa.name,
          inferredType: pa.inferredType,
          balanceCents: pa.balanceCents,
          currency: pa.currency,
          balanceDate: null,
        }, body.budgetId)
      }

      return { accountsCreated, accountsSkipped }
    },
  )

  /**
   * Rename the institution label for a connection. SimpleFIN sometimes omits
   * institution metadata entirely, so users label connections themselves;
   * this also un-merges accounts that share the fallback label.
   */
  app.patch('/connections/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = z.object({ orgName: z.string().min(1).max(200) }).parse(req.body)
    const [updated] = await db
      .update(connections)
      .set({ orgName: body.orgName })
      .where(eq(connections.id, id))
      .returning()
    if (!updated) return reply.code(404).send({ error: 'Connection not found' })
    return updated
  })

  /** Enqueue a sync run; the worker polls SimpleFin outside the request cycle. */
  app.post('/integrations/simplefin/sync', async (_req, reply) => {
    const queued = await enqueueSimplefinSync()
    if (!queued) {
      return reply.code(503).send({ error: 'Job queue unavailable — try again shortly' })
    }
    return reply.code(202).send({ queued: true })
  })

  /**
   * All provider-side accounts discovered for this installation (refreshed at
   * claim time and on every sync), with their link status. Powers the
   * always-available per-connection manager on the Accounts page.
   */
  app.get('/budgets/:budgetId/discovered', { preHandler: requireBudgetMember }, async (req) => {
    const rows = await db
      .select({
        providerAccountId: providerAccounts.providerAccountId,
        name: providerAccounts.name,
        inferredType: providerAccounts.inferredType,
        balanceCents: providerAccounts.balanceCents,
        linkedAccountId: providerAccounts.linkedAccountId,
        connectionId: connections.id,
        connectionName: connections.orgName,
      })
      .from(providerAccounts)
      .innerJoin(connections, eq(providerAccounts.connectionId, connections.id))
      .where(eq(connections.providerName, 'simplefin'))
      .orderBy(asc(connections.orgName), asc(providerAccounts.name))

    return rows.map((r) => ({ ...r, linked: r.linkedAccountId !== null }))
  })

  // ---- Accounts ----

  /** Accounts with their connection health, grouped view data for the UI. */
  app.get('/budgets/:budgetId/accounts', { preHandler: requireBudgetMember }, async (req) => {
    const { budgetId } = req.params as { budgetId: string }
    return db
      .select({
        id: accounts.id,
        name: accounts.name,
        type: accounts.type,
        status: accounts.status,
        lastSeenAt: accounts.lastSeenAt,
        currency: accounts.currency,
        reportedBalanceCents: accounts.reportedBalanceCents,
        availableBalanceCents: accounts.availableBalanceCents,
        reportedBalanceDate: accounts.reportedBalanceDate,
        providerAccountId: accounts.providerAccountId,
        connectionId: connections.id,
        connectionName: connections.orgName,
        orgName: connections.orgName,
        lastSyncAt: connections.lastSyncAt,
        connectionStatus: connections.status,
      })
      .from(accounts)
      .leftJoin(connections, eq(accounts.connectionId, connections.id))
      .where(eq(accounts.budgetId, budgetId))
      .orderBy(asc(accounts.name))
  })

  /** Edit an account; membership enforced via the account's budget. */
  app.patch('/accounts/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = AccountPatch.parse(req.body)
    const [account] = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1)
    if (!account) return reply.code(404).send({ error: 'Account not found' })
    if (!(await isBudgetMember(req.user!.id, account.budgetId))) {
      return reply.code(403).send({ error: 'Not a member of this budget' })
    }
    const [updated] = await db
      .update(accounts)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.type !== undefined ? { type: body.type } : {}),
      })
      .where(eq(accounts.id, id))
      .returning()
    return updated
  })

  /**
   * Unlink (hard-delete) an account. Transactions cascade with it — the UI
   * warns before calling. provider_accounts.linkedAccountId clears via FK so
   * the account can be re-added from the discovered list later.
   */
  app.delete('/accounts/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [account] = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1)
    if (!account) return reply.code(404).send({ error: 'Account not found' })
    if (!(await isBudgetMember(req.user!.id, account.budgetId))) {
      return reply.code(403).send({ error: 'Not a member of this budget' })
    }
    await db.delete(accounts).where(eq(accounts.id, id))
    return reply.code(204).send()
  })

  // ---- Transactions ----

  const transactionColumns = {
    id: transactions.id,
    accountId: transactions.accountId,
    accountName: accounts.name,
    status: transactions.status,
    amountCents: transactions.amountCents,
    postedAt: transactions.postedAt,
    transactedAt: transactions.transactedAt,
    merchantDescription: transactions.merchantDescription,
    rawCategory: transactions.rawCategory,
    categoryId: transactions.categoryId,
    categoryName: categories.name,
    supersedesPendingId: transactions.supersedesPendingId,
    needsReview: transactions.needsReview,
  }

  app.get('/budgets/:budgetId/transactions', { preHandler: requireBudgetMember }, async (req) => {
    const { budgetId } = req.params as { budgetId: string }
    const query = TransactionListQuery.parse(req.query)
    const conditions = [eq(accounts.budgetId, budgetId)]
    if (query.accountId) conditions.push(eq(transactions.accountId, query.accountId))
    if (query.status) conditions.push(eq(transactions.status, query.status))
    if (query.needsReview) conditions.push(eq(transactions.needsReview, true))
    if (query.q) conditions.push(ilike(transactions.merchantDescription, `%${query.q}%`))
    return db
      .select(transactionColumns)
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(and(...conditions))
      .orderBy(desc(transactions.postedAt), desc(transactions.id))
      .limit(query.limit)
      .offset(query.offset)
  })

  /** Review queue: posted transactions still missing a category, oldest first. */
  app.get('/budgets/:budgetId/transactions/unknown', { preHandler: requireBudgetMember }, async (req) => {
    const { budgetId } = req.params as { budgetId: string }
    return db
      .select(transactionColumns)
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .where(
        and(
          eq(accounts.budgetId, budgetId),
          eq(transactions.status, 'posted'),
          isNull(transactions.categoryId),
        ),
      )
      .orderBy(asc(transactions.postedAt))
      .limit(100)
  })

  // ---- Categories ----

  app.get('/budgets/:budgetId/categories', { preHandler: requireBudgetMember }, async () => {
    return db.select().from(categories).orderBy(asc(categories.name))
  })

  /**
   * Categorize and/or reroute a transaction. Category choices persist as a
   * provider mapping; bucket reassignment appends compensating correction
   * entries (plan §4 step 7) — ledger history is never rewritten.
   */
  app.patch('/transactions/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = TransactionPatch.parse(req.body)
    const [txn] = await db.select().from(transactions).where(eq(transactions.id, id)).limit(1)
    if (!txn) return reply.code(404).send({ error: 'Transaction not found' })
    const [account] = await db
      .select({ budgetId: accounts.budgetId })
      .from(accounts)
      .where(eq(accounts.id, txn.accountId))
      .limit(1)
    if (!account || !(await isBudgetMember(req.user!.id, account.budgetId))) {
      return reply.code(403).send({ error: 'Not a member of this budget' })
    }

    // ---- Bucket reassignment ----
    if (body.bucketId !== undefined && body.bucketId !== (txn.bucketId ?? null)) {
      if (txn.transferLinkId) {
        return reply.code(400).send({ error: 'Transfer-linked transactions are excluded from bucket routing' })
      }
      if (body.bucketId !== null) {
        const [bucket] = await db
          .select({ id: buckets.id })
          .from(buckets)
          .where(and(eq(buckets.id, body.bucketId), eq(buckets.budgetId, account.budgetId)))
          .limit(1)
        if (!bucket) return reply.code(400).send({ error: 'Unknown bucket for this budget' })
      }
      await db.transaction(async (tx) => {
        await reassignTransactionRouting(tx, {
          budgetId: account.budgetId,
          transactionRowId: txn.id,
          txnAmountCents: txn.amountCents,
          oldBucketId: txn.bucketId ?? null,
          newBucketId: body.bucketId ?? null,
        })
      })
    }

    // ---- Category assignment + learned mapping ----
    let changed = false
    let recategorized = 0
    if (body.categoryId !== undefined && body.categoryId !== txn.categoryId) {
      if (body.categoryId !== null) {
        const [category] = await db
          .select({ id: categories.id })
          .from(categories)
          .where(eq(categories.id, body.categoryId))
          .limit(1)
        if (!category) return reply.code(400).send({ error: 'Unknown category' })
      }
      await db
        .update(transactions)
        .set({ categoryId: body.categoryId })
        .where(eq(transactions.id, id))

      if (body.categoryId !== null) {
        // Learn the mapping so future syncs auto-categorize similar descriptions.
        await db
          .insert(categoryMappings)
          .values({
            providerName: 'simplefin',
            rawValue: txn.merchantDescription.toLowerCase(),
            categoryId: body.categoryId,
          })
          .onConflictDoUpdate({
            target: [categoryMappings.providerName, categoryMappings.rawValue],
            set: { categoryId: body.categoryId },
          })

        // Retroactive backfill: recategorize other uncategorized posted transactions
        // in the same budget whose descriptions have similarity >= 0.6 with the
        // newly learned mapping's rawValue.
        const budgetId = account.budgetId
        const uncategorized = await db
          .select({ id: transactions.id, merchantDescription: transactions.merchantDescription })
          .from(transactions)
          .innerJoin(accounts, eq(transactions.accountId, accounts.id))
          .where(
            and(
              eq(accounts.budgetId, budgetId),
              eq(transactions.status, 'posted'),
              isNull(transactions.categoryId),
            ),
          )
        const toRecategorize: string[] = []
        for (const candidate of uncategorized) {
          if (candidate.id === id) continue // already updated
          const sim = descriptorSimilarity(candidate.merchantDescription, txn.merchantDescription)
          if (sim >= 0.6) toRecategorize.push(candidate.id)
        }
        if (toRecategorize.length > 0) {
          await db
            .update(transactions)
            .set({ categoryId: body.categoryId })
            .where(inArray(transactions.id, toRecategorize))
          recategorized = toRecategorize.length
        }
      }

      changed = true
    }
    if (body.bucketId !== undefined && body.bucketId !== (txn.bucketId ?? null)) {
      changed = true
    }

    if (!changed) return txn
    const [updated] = await db.select().from(transactions).where(eq(transactions.id, id)).limit(1)
    return { ...updated, recategorized }
  })

  // ---- Phase 3: Credit card config (plan §4 step 6) ----

  const CreditConfigBody = z.object({
    mode: z.enum(['free_to_spend', 'bucket']),
    payoffBucketId: z.string().uuid(),
  })

  /**
   * PUT /accounts/:id/credit-config — create or update a credit card config.
   * Only valid when account.type='credit_card'; payoff bucket must belong to
   * the same budget. Upserts on accountId (one config per card).
   */
  app.put('/accounts/:id/credit-config', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = CreditConfigBody.parse(req.body)

    const [account] = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1)
    if (!account) return reply.code(404).send({ error: 'Account not found' })
    if (!(await isBudgetMember(req.user!.id, account.budgetId))) {
      return reply.code(403).send({ error: 'Not a member of this budget' })
    }
    if (account.type !== 'credit_card') {
      return reply.code(400).send({ error: 'Credit card config is only valid for credit_card accounts' })
    }

    // Verify the payoff bucket belongs to the same budget.
    const [payoffBucket] = await db
      .select({ id: buckets.id })
      .from(buckets)
      .where(and(eq(buckets.id, body.payoffBucketId), eq(buckets.budgetId, account.budgetId)))
      .limit(1)
    if (!payoffBucket) {
      return reply.code(400).send({ error: 'Payoff bucket not found for this budget' })
    }

    // Upsert on accountId (unique constraint gives us ONE config per card).
    const [config] = await db
      .insert(creditCardConfigs)
      .values({
        accountId: id,
        mode: body.mode,
        payoffBucketId: body.payoffBucketId,
      })
      .onConflictDoUpdate({
        target: creditCardConfigs.accountId,
        set: { mode: body.mode, payoffBucketId: body.payoffBucketId },
      })
      .returning()

    // Fetch the payoff bucket's current balance for the response.
    const currentBalance = await bucketBalance(config!.payoffBucketId)

    return {
      id: config!.id,
      accountId: config!.accountId,
      mode: config!.mode,
      payoffBucketId: config!.payoffBucketId,
      payoffBucketName: payoffBucket.id,
      payoffBucketBalanceCents: currentBalance,
    }
  })

  /**
   * DELETE /accounts/:id/credit-config — remove a card's credit config.
   * Subsequent charges will behave as today (normal matching; no sweep).
   */
  app.delete('/accounts/:id/credit-config', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [account] = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1)
    if (!account) return reply.code(404).send({ error: 'Account not found' })
    if (!(await isBudgetMember(req.user!.id, account.budgetId))) {
      return reply.code(403).send({ error: 'Not a member of this budget' })
    }
    const deleted = await db.delete(creditCardConfigs).where(eq(creditCardConfigs.accountId, id)).returning()
    if (deleted.length === 0) return reply.code(404).send({ error: 'No credit card config found' })
    return reply.code(204).send()
  })

  /**
   * GET /budgets/:budgetId/credit-configs — list all credit card configs for
   * a budget, joined with payoff bucket name/balance and card account name/balance.
   */
  app.get('/budgets/:budgetId/credit-configs', { preHandler: requireBudgetMember }, async (req) => {
    const { budgetId } = req.params as { budgetId: string }

    const rows = await db
      .select({
        id: creditCardConfigs.id,
        accountId: creditCardConfigs.accountId,
        mode: creditCardConfigs.mode,
        payoffBucketId: creditCardConfigs.payoffBucketId,
        payoffBucketName: buckets.name,
        cardAccountName: accounts.name,
        cardReportedBalanceCents: accounts.reportedBalanceCents,
      })
      .from(creditCardConfigs)
      .innerJoin(accounts, eq(creditCardConfigs.accountId, accounts.id))
      .innerJoin(buckets, eq(creditCardConfigs.payoffBucketId, buckets.id))
      .where(eq(accounts.budgetId, budgetId))

    // Enrich with live payoff bucket balances.
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        payoffBucketBalanceCents: await bucketBalance(row.payoffBucketId),
      })),
    )
  })
}
