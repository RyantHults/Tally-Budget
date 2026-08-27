import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import {
  createSession,
  destroySession,
  hashPassword,
  requireAuth,
  verifyPassword,
} from '../lib/auth.js'

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export function authRoutes(app: FastifyInstance): void {
  app.post('/auth/login', async (req, reply) => {
    const body = LoginBody.parse(req.body)
    const rows = await db.select().from(users).where(eq(users.email, body.email)).limit(1)
    const user = rows[0]
    // Constant-shape response to avoid leaking which emails exist.
    const ok = user ? await verifyPassword(user.passwordHash, body.password) : false
    if (!user || !ok) {
      return reply.code(401).send({ error: 'Invalid email or password' })
    }
    await createSession(user.id, reply)
    return { id: user.id, email: user.email }
  })

  app.post('/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    await destroySession(req, reply)
    return reply.code(204).send()
  })

  app.get('/auth/me', { preHandler: requireAuth }, async (req) => {
    return req.user
  })
}

/** Used by the CLI only — creates a user with a hashed password. */
export async function createUser(email: string, password: string): Promise<string> {
  const passwordHash = await hashPassword(password)
  const inserted = await db.insert(users).values({ email, passwordHash }).returning({ id: users.id })
  return inserted[0]!.id
}
