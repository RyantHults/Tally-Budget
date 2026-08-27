import './lib/env.js'
import { eq } from 'drizzle-orm'
import { db, pool } from './db/index.js'
import { budgets, users } from './db/schema.js'
import { createUser } from './routes/auth.js'
import { hashPassword } from './lib/auth.js'
import { applyDueOccurrences, generateOccurrences } from './lib/funding.js'

/**
 * MVP user administration CLI (email flows are deferred).
 *
 * Usage:
 *   pnpm --filter @tally/server cli create-user <email> <password>
 *   pnpm --filter @tally/server cli list-users
 *   pnpm --filter @tally/server cli reset-password <email> <newPassword>
 *   pnpm --filter @tally/server cli generate-occurrences <budgetId>
 *   pnpm --filter @tally/server cli run-sweeps [budgetId]
 */

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)

  switch (command) {
    case 'create-user': {
      const [email, password] = args
      if (!email || !password || password.length < 8) {
        throw new Error('Usage: cli create-user <email> <password (min 8 chars)>')
      }
      const id = await createUser(email, password)
      console.log(`Created user ${email} (${id})`)
      break
    }
    case 'list-users': {
      const rows = await db.select({ id: users.id, email: users.email }).from(users)
      for (const row of rows) console.log(`${row.id}  ${row.email}`)
      console.log(`\n${rows.length} user(s)`)
      break
    }
    case 'reset-password': {
      const [email, password] = args
      if (!email || !password || password.length < 8) {
        throw new Error('Usage: cli reset-password <email> <newPassword>')
      }
      const passwordHash = await hashPassword(password)
      const updated = await db
        .update(users)
        .set({ passwordHash })
        .where(eq(users.email, email))
        .returning({ id: users.id })
      if (!updated[0]) throw new Error(`No such user: ${email}`)
      console.log(`Password reset for ${email}`)
      break
    }
    case 'generate-occurrences': {
      const [budgetId] = args
      if (!budgetId) throw new Error('Usage: cli generate-occurrences <budgetId>')
      const result = await generateOccurrences(budgetId)
      console.log(
        `Generated ${result.inserted} occurrence(s) across ${result.bucketsProcessed} fundable bucket(s)`,
      )
      break
    }
    case 'run-sweeps': {
      // Manual trigger: regenerate + apply due occurrences without the queue.
      const [budgetId] = args
      if (budgetId) {
        await generateOccurrences(budgetId)
        const outcome = await applyDueOccurrences(budgetId, { info: console.log })
        console.log(
          `Swept budget ${budgetId}: ${outcome.applied} applied (${outcome.fundedCents} cents), ${outcome.skipped} skipped`,
        )
      } else {
        const all = await db.select({ id: budgets.id }).from(budgets)
        for (const budget of all) {
          await generateOccurrences(budget.id)
          const outcome = await applyDueOccurrences(budget.id, { info: console.log })
          console.log(
            `Swept budget ${budget.id}: ${outcome.applied} applied (${outcome.fundedCents} cents), ${outcome.skipped} skipped`,
          )
        }
      }
      break
    }
    default:
      console.log(
        'Commands: create-user | list-users | reset-password | generate-occurrences <budgetId> | run-sweeps [budgetId]',
      )
      process.exitCode = command === undefined ? 0 : 1
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
