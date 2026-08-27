import './../src/lib/env.js'
import { eq } from 'drizzle-orm'
import { db, pool } from '../src/db/index.js'
import { providerCredentials } from '../src/db/schema.js'
import { decryptPayload } from '../src/lib/crypto.js'

/**
 * Debug: fetch RAW /accounts payloads from the stored SimpleFin access URL —
 * once with our current params, once with explicit version=2 — and dump the
 * shapes so we can see where (or whether) institution data lives.
 */

const [cred] = await db
  .select()
  .from(providerCredentials)
  .where(eq(providerCredentials.providerName, 'simplefin'))
  .limit(1)
if (!cred) throw new Error('no simplefin credential stored')

const accessUrl = decryptPayload(cred.encryptedPayload)
const parsed = new URL(accessUrl)
if (!parsed.username) throw new Error('access URL missing credentials')
const authorization =
  'Basic ' +
  Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString('base64')

async function rawFetch(label: string, params: Record<string, string>): Promise<void> {
  const target = new URL(`${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}/accounts`)
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v)

  console.log(`\n=== ${label} ===`)
  console.log('URL path:', target.pathname + '?' + target.searchParams.toString())
  const res = await fetch(target, { headers: { Authorization: authorization } })
  console.log('HTTP', res.status)
  const body = (await res.json()) as Record<string, unknown>

  console.log('top-level keys:', Object.keys(body))
  const conns = body.connections
  console.log(
    'connections:',
    Array.isArray(conns) ? `${conns.length} entries` : `(absent/not-array: ${typeof conns})`,
  )
  if (Array.isArray(conns) && conns.length > 0) {
    console.log('first connection:', JSON.stringify(conns[0]))
  }
  // v1 shape: organization blob at top level?
  if (body.organization !== undefined) {
    console.log('top-level organization:', JSON.stringify(body.organization))
  }

  const accounts = Array.isArray(body.accounts) ? (body.accounts as Record<string, unknown>[]) : []
  console.log('accounts:', accounts.length)
  const first = accounts[0]
  if (first) {
    const { transactions, ...rest } = first
    const tLen = Array.isArray(transactions) ? transactions.length : 'n/a'
    console.log(`first account (transactions omitted, ${tLen} txns):`, JSON.stringify(rest, null, 2))
  }
}

await rawFetch('current app params (no version param)', {
  'balances-only': '1',
  pending: '1',
})
await rawFetch('explicit version=2', {
  'balances-only': '1',
  pending: '1',
  version: '2',
})
// Also check what the server advertises.
const info = await fetch(new URL(`${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}/info`))
console.log('\n=== GET /info ===')
console.log(await info.text())

// Finally, verify through OUR client (with the version=2 fix applied).
const { fetchAccounts } = await import('../src/lib/simplefin.js')
const normalized = await fetchAccounts(accessUrl, { balancesOnly: true })
console.log('\n=== via app client (fetchAccounts) ===')
console.log('normalized connections:', normalized.connections.length)
for (const c of normalized.connections) {
  console.log(` - ${c.orgName ?? c.name ?? '<unnamed>'} (${c.connectionId})`)
}

await pool.end()
