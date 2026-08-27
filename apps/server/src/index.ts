import './lib/env.js'
import Fastify from 'fastify'
import type { FastifyError } from 'fastify'
import cookie from '@fastify/cookie'
import { ZodError } from 'zod'
import { authRoutes } from './routes/auth.js'
import { budgetRoutes } from './routes/budgets.js'
import { settingsRoutes } from './routes/settings.js'
import { integrationRoutes } from './routes/integrations.js'
import { requireAuth } from './lib/auth.js'
import { seedCategories, backfillUncategorizedTransactions } from './lib/categories.js'
import { startJobs, stopJobs } from './jobs/index.js'
import { pool } from './db/index.js'

const app = Fastify({
  logger: true,
})

// Validation failures are client errors, not server errors.
app.setErrorHandler((error: FastifyError, _req, reply) => {
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: 'Validation failed', issues: error.issues })
  }
  reply.status(error.statusCode ?? 500).send({ error: error.message })
})

await app.register(cookie)

app.get('/health', async () => ({ ok: true }))

// All app routes live under /api (web dev proxy forwards /api → :3001).
// Auth routes get no session requirement; budget/settings routes share an
// encapsulated scope whose preHandler hook requires authentication.
await app.register(
  async (api) => {
    authRoutes(api)
  },
  { prefix: '/api' },
)

await app.register(
  async (api) => {
    api.addHook('preHandler', requireAuth)
    budgetRoutes(api)
    settingsRoutes(api)
    integrationRoutes(api)
  },
  { prefix: '/api' },
)

const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '127.0.0.1'

try {
  await app.listen({ port, host })
} catch (err) {
  const code = (err as { code?: string }).code
  if (code === 'EADDRINUSE') {
    console.error(
      `\nPort ${port} is already in use — another instance is probably still running.\n` +
        `Stop it with:  corepack pnpm --filter @tally/server dev:stop\n`,
    )
    process.exit(1)
  }
  throw err
}

// Boot-time side effects, after the server accepts traffic.
await seedCategories()
try {
  const backfillCount = await backfillUncategorizedTransactions(app.log)
  if (backfillCount > 0) {
    app.log.info(`Boot backfill complete: ${backfillCount} transactions categorized`)
  }
} catch (err) {
  app.log.error(`Boot backfill failed: ${String(err)}`)
}
try {
  await startJobs(app.log)
} catch (err) {
  // The API stays up even if the queue can't start; sync just won't run.
  app.log.error(`Failed to start background jobs: ${String(err)}`)
}

// ---- Graceful shutdown ----
// Ctrl+C / docker stop: close the listener, stop pg-boss workers, drain the
// Postgres pool. Force-exits after a grace period in case something hangs —
// a second signal also exits immediately.
let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      process.exit(1)
    }
    shuttingDown = true
    app.log.info(`${signal} received — shutting down`)
    const forceExit = setTimeout(() => process.exit(1), 5000)
    forceExit.unref()
    void Promise.allSettled([app.close(), stopJobs()])
      .finally(async () => {
        await pool.end()
        process.exit(0)
      })
  })
}
