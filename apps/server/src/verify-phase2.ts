import './lib/env.js'
import { db, pool } from './db/index.js'
import { accounts, transactions } from './db/schema.js'
import { ingestAccountBatch } from './lib/ingest.js'
import { bucketBalance, budgetMoneySummary } from './lib/ledger.js'

const BUDGET = process.argv[2]!
const BUCKET = process.argv[3]!
const DAY = 86_400_000

async function main(): Promise<void> {
  const [checking] = await db
    .insert(accounts)
    .values({ budgetId: BUDGET, type: 'checking', name: 'Verify Checking', reportedBalanceCents: 100_000 })
    .returning()
  const [card] = await db
    .insert(accounts)
    .values({ budgetId: BUDGET, type: 'credit_card', name: 'Verify Visa', reportedBalanceCents: -48_000 })
    .returning()

  const now = Date.now()
  const mk = (id: string, amountCents: number, description: string) => ({
    id,
    amountCents,
    description,
    postedAtMs: now,
    transactedAtMs: null,
    pending: false,
    rawCategory: null,
  })

  const r1 = await ingestAccountBatch(
    checking!.id,
    {
      balanceCents: 52_000,
      availableBalanceCents: null,
      balanceDate: new Date(),
      transactions: [
        mk('v-tj-1', -5_000, 'TRADER JOES #456'),
        mk('v-rent-1', -120_000, 'RENT JANUARY 1200 MAIN ST'),
        mk('v-pay-1', -48_000, 'PAYMENT TO CARD'),
      ],
    },
    new Map(),
  )
  console.log('checking batch:', JSON.stringify(r1))

  const r2 = await ingestAccountBatch(
    card!.id,
    {
      balanceCents: -48_000,
      availableBalanceCents: null,
      balanceDate: new Date(),
      transactions: [mk('v-pay-2', 48_000, 'CARD PAYMENT')],
    },
    new Map(),
  )
  console.log('card batch:', JSON.stringify(r2))

  console.log('groceries bucketBalance:', await bucketBalance(BUCKET))
  console.log('summary:', JSON.stringify(await budgetMoneySummary(BUDGET)))

  const rows = await db
    .select({
      id: transactions.id,
      desc: transactions.merchantDescription,
      status: transactions.status,
      bucketId: transactions.bucketId,
      transferLinkId: transactions.transferLinkId,
    })
    .from(transactions)
  console.log('txns:', JSON.stringify(rows, null, 1))
  void DAY
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
