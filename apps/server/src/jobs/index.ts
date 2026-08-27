import { randomInt } from 'node:crypto'
import PgBoss from 'pg-boss'
import { and, eq } from 'drizzle-orm'
import { decryptPayload } from '../lib/crypto.js'
import {
  ingestAccountBatch,
  loadSimplefinCategoryMappings,
} from '../lib/ingest.js'
import { applyDueOccurrences, generateOccurrences, runFundingSweeps } from '../lib/funding.js'
import { fetchAccounts } from '../lib/simplefin.js'
import { refreshDiscoveredAccounts } from '../routes/integrations.js'
import { db } from '../db/index.js'
import {
  accounts,
  balanceSnapshots,
  connections,
  providerCredentials,
} from '../db/schema.js'

/**
 * pg-boss backed background jobs (plan §5): Postgres-backed queue so sync jobs
 * enqueue transactionally with business writes and no extra service is needed.
 *
 * Quota awareness (plan §2): SimpleFin allows ~24 requests/day/token. We poll
 * every 6 hours (4/day) at a randomized minute past the hour, with a 5-day
 * overlapping fetch window to catch mutated transactions.
 *
 * Funding sweeps run hourly at :05 (plan §6): regenerate occurrences, then
 * apply due ticks idempotently — missed hours catch up on the next run.
 */

const SIMPLEFIN_QUEUE = 'simplefin-sync'
const SNAPSHOTS_QUEUE = 'balance-snapshots'
const SWEEPS_QUEUE = 'funding-sweeps'
const SYNC_OVERLAP_MS = 5 * 24 * 60 * 60 * 1000
const FIRST_RUN_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000
const DEFAULT_DATABASE_URL = 'postgres://tally:tally@localhost:5432/tally'

type Logger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void }

let boss: PgBoss | null = null

/** Enqueue an on-demand sync. Returns false when the queue isn't running yet. */
export async function enqueueSimplefinSync(): Promise<boolean> {
  if (!boss) return false
  return (await boss.send(SIMPLEFIN_QUEUE, { requestedAt: new Date().toISOString() })) !== null
}

/** Enqueue an on-demand funding sweep pass. */
export async function enqueueFundingSweep(): Promise<boolean> {
  if (!boss) return false
  return (await boss.send(SWEEPS_QUEUE, { requestedAt: new Date().toISOString() })) !== null
}

/** Start pg-boss, register workers, and attach the cron schedules. */
export async function startJobs(logger: Logger): Promise<void> {
  boss = new PgBoss({
    connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  })
  boss.on('error', (err) => logger.error(`pg-boss error: ${String(err)}`))

  await boss.start()
  await boss.createQueue(SIMPLEFIN_QUEUE)
  await boss.createQueue(SNAPSHOTS_QUEUE)
  await boss.createQueue(SWEEPS_QUEUE)

  // v10 work handlers receive a batch of jobs; batchSize stays at the default 1.
  await boss.work(SIMPLEFIN_QUEUE, async () => {
    await runSimplefinSync(logger)
  })
  await boss.work(SNAPSHOTS_QUEUE, async () => {
    await runBalanceSnapshots()
  })
  await boss.work(SWEEPS_QUEUE, async () => {
    await runFundingSweeps(logger)
  })

  const minute = randomInt(0, 60)
  await boss.schedule(SIMPLEFIN_QUEUE, `${minute} */6 * * *`)
  await boss.schedule(SNAPSHOTS_QUEUE, '15 3 * * *')
  await boss.schedule(SWEEPS_QUEUE, '5 * * * *')

  logger.info(
    `Jobs started: '${SIMPLEFIN_QUEUE}' cron '${minute} */6 * * *' (4 polls/day/token), ` +
      `'${SNAPSHOTS_QUEUE}' cron '15 3 * * *', '${SWEEPS_QUEUE}' cron '5 * * * *'`,
  )
}

/** Stop the boss cleanly (used by tests/shutdown paths). */
export async function stopJobs(): Promise<void> {
  if (boss) {
    await boss.stop()
    boss = null
  }
}

async function runSimplefinSync(logger: Logger): Promise<void> {
  const credentialRows = await db
    .select()
    .from(providerCredentials)
    .where(eq(providerCredentials.providerName, 'simplefin'))
  for (const credential of credentialRows) {
    await syncCredential(credential.encryptedPayload, logger)
  }
}

async function syncCredential(encryptedAccessUrl: string, logger: Logger): Promise<void> {
  let accessUrl: string
  try {
    accessUrl = decryptPayload(encryptedAccessUrl)
  } catch (err) {
    logger.error(`SimpleFin credential could not be decrypted (APP_SECRET changed?): ${String(err)}`)
    return
  }

  // Guard: validate the access URL looks like a real SimpleFin access URL.
  // If a never-claimed setup token was stored instead, skip polling to avoid
  // hammering a bogus endpoint and surface the issue.
  if (!accessUrl.startsWith('https://') || !accessUrl.includes('@')) {
    logger.warn(
      `SimpleFin credential does not look like a valid access URL (missing https:// or @) — skipping sync. ` +
        `If this was a setup token, claim it first via POST /api/integrations/simplefin/claim.`,
    )
    await db
      .update(connections)
      .set({ status: 'error' })
      .where(eq(connections.providerName, 'simplefin'))
    return
  }

  // Overlap window: normally the oldest connection's last successful sync
  // minus 5 days. If ANY simplefin connection has never successfully synced
  // (freshly added, or recovered after an identity break), fall back to the
  // full 90-day lookback so its history gets backfilled — dedupe makes the
  // overlap harmless.
  const knownConnections = await db
    .select({ lastSyncAt: connections.lastSyncAt })
    .from(connections)
    .where(eq(connections.providerName, 'simplefin'))
  const lastSyncTimes = knownConnections
    .map((row) => row.lastSyncAt?.getTime())
    .filter((t): t is number => typeof t === 'number')
  const anyNeverSynced = knownConnections.some((row) => !row.lastSyncAt)
  const startDate =
    lastSyncTimes.length === 0 || anyNeverSynced
      ? new Date(Date.now() - FIRST_RUN_LOOKBACK_MS)
      : new Date(Math.min(...lastSyncTimes) - SYNC_OVERLAP_MS)

  let discovered
  try {
    discovered = await fetchAccounts(accessUrl, {
      startDate,
      endDate: new Date(),
      pending: true,
      logger,
    })
  } catch (err) {
    logger.error(`SimpleFin fetch failed: ${String(err)}`)
    await db
      .update(connections)
      .set({ status: 'error' })
      .where(eq(connections.providerName, 'simplefin'))
    throw err // surface to pg-boss for retry accounting
  }

  // Derive per-connection iteration from the ACCOUNTS' connectionId values —
  // some institutions return accounts without a populated connections[] list.
  const nameByConn = new Map(discovered.connections.map((c) => [c.connectionId, c]))
  const connIdsInOrder = [...new Set(discovered.accounts.map((a) => a.connectionId))]

  const categoryMappingsByRawValue = await loadSimplefinCategoryMappings()

  // Keep the Accounts-page discovery list current (names/balances/types),
  // including accounts not yet linked to any budget.
  await refreshDiscoveredAccounts(discovered)

  for (const connectionId of connIdsInOrder) {
    try {
      const connMeta = nameByConn.get(connectionId)
      // New institutions can appear under an existing token between links.
      const [connectionRow] = await db
        .insert(connections)
        .values({
          providerName: 'simplefin',
          providerConnectionId: connectionId,
          orgName: connMeta?.orgName ?? connMeta?.name ?? 'SimpleFin connection',
          status: 'active',
        })
        .onConflictDoUpdate({
          target: [connections.providerName, connections.providerConnectionId],
          set: { orgName: connMeta?.orgName ?? connMeta?.name ?? 'SimpleFin connection' },
        })
        .returning()
      if (!connectionRow) continue

      const connectionAccounts = discovered.accounts.filter((a) => a.connectionId === connectionId)
      for (const acct of connectionAccounts) {
        const [accountRow] = await db
          .select()
          .from(accounts)
          .where(
            and(eq(accounts.connectionId, connectionRow.id), eq(accounts.providerAccountId, acct.id)),
          )
          .limit(1)
        if (!accountRow) {
          // Sync never invents budget membership — link the token again to adopt it.
          logger.warn(
            `Skipping unknown SimpleFin account "${acct.name}" (${acct.id}) — no linked account row`,
          )
          continue
        }

        // Always stamp lastSeenAt — the account IS present at the bank.
        await db
          .update(accounts)
          .set({ lastSeenAt: new Date() })
          .where(eq(accounts.id, accountRow.id))

        // Skip ingest + balance updates for archived accounts.
        if (accountRow.status === 'archived') {
          logger.info(`Skipping archived account "${acct.name}" — lastSeenAt stamped, ingest frozen`)
          continue
        }

        const outcome = await ingestAccountBatch(
          accountRow.id,
          {
            balanceCents: acct.balanceCents,
            availableBalanceCents: acct.availableBalanceCents,
            balanceDate: acct.balanceDate,
            transactions: acct.transactions,
          },
          categoryMappingsByRawValue,
        )
        logger.info(
          `Ingested account "${acct.name}": +${outcome.insertedPosted} posted, ` +
            `+${outcome.insertedPending} pending, ${outcome.supersededPendings} superseded`,
        )
      }

      await db
        .update(connections)
        .set({ lastSyncAt: new Date(), status: 'active' })
        .where(eq(connections.id, connectionRow.id))
    } catch (err) {
      logger.error(`SimpleFin sync failed for connection ${connectionId}: ${String(err)}`)
      await db
        .update(connections)
        .set({ status: 'error' })
        .where(
          and(
            eq(connections.providerName, 'simplefin'),
            eq(connections.providerConnectionId, connectionId),
          ),
        )
    }
  }

  // ---- Disappearance detection ----
  // Connections that were NOT in the discovery set but DO have linked Account
  // rows are marked 'disconnected'. Accounts vanish from SimpleFin when the
  // bank revokes access or the institution migrates. We don't remove rows —
  // the UI can surface the staleness via lastSeenAt aging.
  const allSimplefinConns = await db
    .select({ id: connections.id, providerConnectionId: connections.providerConnectionId })
    .from(connections)
    .where(eq(connections.providerName, 'simplefin'))

  for (const conn of allSimplefinConns) {
    if (connIdsInOrder.includes(conn.providerConnectionId)) continue // present in discovery
    // Check if this connection has any linked accounts
    const hasLinkedAccounts = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.connectionId, conn.id))
      .limit(1)
    if (hasLinkedAccounts.length > 0) {
      await db
        .update(connections)
        .set({ status: 'disconnected' })
        .where(eq(connections.id, conn.id))
      logger.warn(`Connection ${conn.providerConnectionId} vanished from SimpleFin — marked disconnected`)
    }
  }
}

/** Daily snapshot of every active account's reported balance (history/audit). */
async function runBalanceSnapshots(): Promise<void> {
  const activeAccounts = await db.select().from(accounts).where(eq(accounts.status, 'active'))
  if (activeAccounts.length === 0) return
  const today = new Date().toISOString().slice(0, 10)
  await db
    .insert(balanceSnapshots)
    .values(
      activeAccounts.map((account) => ({
        accountId: account.id,
        date: today,
        reportedBalanceCents: account.reportedBalanceCents,
      })),
    )
    .onConflictDoNothing({ target: [balanceSnapshots.accountId, balanceSnapshots.date] })
}
