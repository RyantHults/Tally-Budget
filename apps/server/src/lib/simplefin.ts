import { parseDecimalStringToCents } from '@tally/core'

/**
 * Minimal SimpleFin Bridge client (https://bridge.simplefin.org protocol).
 *
 * Realities baked in (plan §2):
 * - Setup tokens are base64-encoded claim URLs; the claim POST is ONE-TIME USE.
 *   The returned Access URL (https://user:pass@host/path) is the secret material.
 * - Access-URL credentials are treated as secrets: they are never passed to
 *   fetch() inline — we build the Authorization header manually.
 * - Polling only, ~24 requests/day/token, 90-day max date range per request.
 * - errlist / non-200 responses surface as thrown errors with server messages.
 */

/**
 * Typed error from SimpleFin operations. Carries the HTTP status code so callers
 * can distinguish 403 (already-claimed) from other failures without string parsing.
 */
export class SimplefinError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message)
    this.name = 'SimplefinError'
  }
}

export interface SimplefinFetchOptions {
  /** Window start (UNIX epoch seconds on the wire). Max 90 days back. */
  startDate?: Date
  /** Window end (UNIX epoch seconds on the wire). */
  endDate?: Date
  /** Include pending transactions (pending=1). */
  pending?: boolean
  /** Skip transaction history entirely (balances-only=1) — used by the link flow. */
  balancesOnly?: boolean
  /** Receives warnings (e.g. skipped non-USD accounts). Defaults to console.warn. */
  logger?: { warn(message: string): void }
}

/** A SimpleFin transaction normalized to codebase conventions (integer cents). */
export interface NormalizedSimplefinTransaction {
  id: string
  amountCents: number
  description: string
  /** Epoch ms of the posted date; null when the provider reports posted=0. */
  postedAtMs: number | null
  transactedAtMs: number | null
  /** True when flagged pending OR when posted is epoch 0. */
  pending: boolean
  /** extra.category from SimpleFin, if provided. */
  rawCategory: string | null
}

export interface NormalizedSimplefinAccount {
  id: string
  name: string
  /** SimpleFin conn_id this account belongs to. */
  connectionId: string
  currency: string
  balanceCents: number
  availableBalanceCents: number | null
  balanceDate: Date | null
  transactions: NormalizedSimplefinTransaction[]
}

export interface NormalizedSimplefinConnection {
  connectionId: string
  name: string | null
  orgName: string | null
}

export interface SimplefinFetchResult {
  connections: NormalizedSimplefinConnection[]
  accounts: NormalizedSimplefinAccount[]
}

// ---- Raw wire shapes (subset we consume; fields are defensive) ----

interface SimplefinTransactionRaw {
  id?: unknown
  posted?: unknown // epoch seconds string ("0" while pending)
  amount?: unknown // decimal string; positive = deposit
  description?: unknown
  transacted_at?: unknown
  pending?: unknown
  extra?: { category?: unknown } & Record<string, unknown>
}

interface SimplefinAccountRaw {
  id?: unknown
  name?: unknown
  conn_id?: unknown
  currency?: unknown
  balance?: unknown
  'available-balance'?: unknown
  'balance-date'?: unknown
  transactions?: SimplefinTransactionRaw[]
  /** v1-shaped responses carry institution info per account. */
  org?: { name?: unknown; domain?: unknown; id?: unknown } & Record<string, unknown>
}

interface SimplefinConnectionRaw {
  conn_id?: unknown
  name?: unknown
  org_name?: unknown
  org_info?: { name?: unknown } & Record<string, unknown>
}

interface SimplefinResponseRaw {
  connections?: SimplefinConnectionRaw[]
  accounts?: SimplefinAccountRaw[]
  errlist?: unknown[]
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.slice(0, 500)
  } catch {
    return '<unreadable body>'
  }
}

/**
 * Decode a base64 setup token into its claim URL and POST it once.
 * Resolves with the returned Access URL — the one-time credential material.
 */
export async function claimSetupToken(setupToken: string): Promise<string> {
  const decoded = Buffer.from(setupToken.trim(), 'base64').toString('utf8')
  let claimUrl: URL
  try {
    claimUrl = new URL(decoded)
  } catch {
    throw new Error(
      'Invalid SimpleFin setup token: expected a base64-encoded https:// claim URL from bridge.simplefin.org',
    )
  }
  if (claimUrl.protocol !== 'https:') {
    throw new Error('SimpleFin claim URL must use https')
  }

  let response: Response
  try {
    response = await fetch(claimUrl, { method: 'POST' })
  } catch (err) {
    throw new Error(`Could not reach SimpleFin to claim the setup token: ${String(err)}`)
  }

  if (response.status === 403) {
    const body = await readErrorBody(response)
    throw new SimplefinError(
      body || 'Setup token has already been claimed',
      403,
    )
  }
  if (!response.ok) {
    const body = await readErrorBody(response)
    throw new SimplefinError(
      `SimpleFin claim failed (${response.status}): ${body}`,
      response.status,
    )
  }

  const accessUrl = (await response.text()).trim()
  if (!accessUrl.startsWith('https://')) {
    throw new Error('SimpleFin claim returned an unexpected response (expected an https Access URL)')
  }
  return accessUrl
}

/**
 * GET {accessUrl}/accounts with Basic auth built from the URL userinfo.
 * The access URL itself is never handed to fetch().
 */
export async function fetchAccounts(
  accessUrl: string,
  opts: SimplefinFetchOptions = {},
): Promise<SimplefinFetchResult> {
  const logger = opts.logger ?? console
  const parsed = new URL(accessUrl)
  if (!parsed.username) {
    throw new Error('SimpleFin access URL is missing its credentials segment')
  }
  const authorization =
    'Basic ' +
    Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString(
      'base64',
    )

  const target = new URL(`${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}/accounts`)
  if (opts.startDate) {
    target.searchParams.set('start-date', String(Math.floor(opts.startDate.getTime() / 1000)))
  }
  if (opts.endDate) {
    target.searchParams.set('end-date', String(Math.floor(opts.endDate.getTime() / 1000)))
  }
  if (opts.pending) target.searchParams.set('pending', '1')
  if (opts.balancesOnly) target.searchParams.set('balances-only', '1')
  // v2 responses carry the top-level connections[] list (institution names).
  // Without it the Bridge defaults to v1 shape, where institutions live
  // per-account under org{} and connections is absent entirely.
  target.searchParams.set('version', '2')

  let response: Response
  try {
    response = await fetch(target, { headers: { Authorization: authorization, Accept: 'application/json' } })
  } catch (err) {
    throw new Error(`Could not reach SimpleFin accounts endpoint: ${String(err)}`)
  }

  if (!response.ok) {
    throw new Error(`SimpleFin accounts request failed (${response.status}): ${await readErrorBody(response)}`)
  }

  let body: SimplefinResponseRaw
  try {
    body = (await response.json()) as SimplefinResponseRaw
  } catch (err) {
    throw new Error(`SimpleFin returned malformed JSON: ${String(err)}`)
  }

  if (Array.isArray(body.errlist) && body.errlist.length > 0) {
    const details = (e: unknown) =>
      typeof e === 'string' ? e : JSON.stringify(e)
    // Advisory warnings (e.g. date-range > 45 days) come through errlist but
    // the data is still returned — log and continue. Anything else is fatal.
    const fatal = body.errlist.filter(
      (e) => !/recommended range|was capped|exceeds/i.test(details(e)),
    )
    if (fatal.length > 0) {
      throw new Error(`SimpleFin reported errors: ${fatal.map(details).join('; ')}`)
    }
    logger.warn(`SimpleFin warnings: ${body.errlist.map(details).join('; ')}`)
  }

  const connections: NormalizedSimplefinConnection[] = []
  for (const raw of body.connections ?? []) {
    const connectionId = asString(raw.conn_id)
    if (!connectionId) continue
    connections.push({
      connectionId,
      name: asString(raw.name),
      orgName: asString(raw.org_name) ?? asString(raw.org_info?.name),
    })
  }

  const accounts: NormalizedSimplefinAccount[] = []
  for (const raw of body.accounts ?? []) {
    const id = asString(raw.id)
    const name = asString(raw.name)
    const balance = asString(raw.balance)
    if (!id || !name || balance === null) {
      logger.warn(`Skipping SimpleFin account with missing id/name/balance: ${id ?? '<no id>'}`)
      continue
    }
    const currency = (asString(raw.currency) ?? 'USD').toUpperCase()
    if (currency !== 'USD') {
      logger.warn(`Skipping non-USD SimpleFin account "${name}" (${currency}) — USD-only for MVP`)
      continue
    }

    const transactions: NormalizedSimplefinTransaction[] = []
    for (const rawTxn of raw.transactions ?? []) {
      const txn = normalizeTransaction(rawTxn)
      if (txn) transactions.push(txn)
    }

    const balanceDateString = asString(raw['balance-date'])
    const balanceDateMs = balanceDateString ? Date.parse(balanceDateString) : NaN

    accounts.push({
      id,
      name,
      connectionId: asString(raw.conn_id) ?? '',
      currency,
      balanceCents: parseAmount(balance, `account ${id} balance`),
      availableBalanceCents:
        asString(raw['available-balance']) !== null
          ? parseAmount(asString(raw['available-balance'])!, `account ${id} available-balance`)
          : null,
      balanceDate: Number.isNaN(balanceDateMs) ? null : new Date(balanceDateMs),
      transactions,
    })
  }

  // v1 fallback: some institutions/upstreams omit connections[] entirely and
  // carry institution info per account under org{}. Synthesize connection
  // entries for any account connectionId we haven't seen yet.
  const knownConnections = new Set(connections.map((c) => c.connectionId))
  for (const raw of body.accounts ?? []) {
    const connId = asString(raw.conn_id)
    if (!connId || knownConnections.has(connId)) continue
    const orgName = asString(raw.org?.name) ?? null
    connections.push({ connectionId: connId, name: orgName, orgName })
    knownConnections.add(connId)
  }

  return { connections, accounts }
}

function parseAmount(amount: string, context: string): number {
  try {
    return parseDecimalStringToCents(amount)
  } catch {
    throw new Error(`Unparseable SimpleFin amount for ${context}: ${JSON.stringify(amount)}`)
  }
}

function normalizeTransaction(raw: SimplefinTransactionRaw): NormalizedSimplefinTransaction | null {
  const id = asString(raw.id)
  const amount = asString(raw.amount)
  const description = asString(raw.description)
  if (!id || amount === null || description === null) return null

  // posted is epoch seconds; "0"/missing means not yet posted.
  const postedSeconds = Number(asString(raw.posted) ?? '0')
  const postedAtMs = Number.isFinite(postedSeconds) && postedSeconds > 0 ? postedSeconds * 1000 : null

  const transactedAtString = asString(raw.transacted_at)
  const transactedAtMs = transactedAtString ? Date.parse(transactedAtString) : NaN

  const extraCategory = raw.extra && typeof raw.extra === 'object' ? asString(raw.extra.category) : null

  return {
    id,
    amountCents: parseAmount(amount, `transaction ${id}`),
    description,
    postedAtMs,
    transactedAtMs: Number.isNaN(transactedAtMs) ? null : transactedAtMs,
    pending: raw.pending === true || postedAtMs === null,
    rawCategory: extraCategory,
  }
}
