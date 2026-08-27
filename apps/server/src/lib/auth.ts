import { hash, verify } from '@node-rs/argon2'
import { randomBytes } from 'node:crypto'
import { eq, and, gt } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { sessions, users, budgetMembers } from '../db/schema.js'
import { sha256Hex } from './crypto.js'

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days
export const SESSION_COOKIE = 'tally_session'

// @node-rs/argon2 defaults to argon2id.
export function hashPassword(password: string): Promise<string> {
  return hash(password)
}

export function verifyPassword(hashValue: string, password: string): Promise<boolean> {
  return verify(hashValue, password)
}

export async function createSession(userId: string, reply: FastifyReply): Promise<void> {
  const raw = randomBytes(32).toString('base64url')
  await db.insert(sessions).values({
    userId,
    tokenHash: sha256Hex(raw),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  })
  reply.setCookie(SESSION_COOKIE, raw, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_MS / 1000,
  })
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = req.cookies[SESSION_COOKIE]
  if (raw) {
    await db.delete(sessions).where(eq(sessions.tokenHash, sha256Hex(raw)))
  }
  reply.clearCookie(SESSION_COOKIE, { path: '/' })
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; email: string }
  }
}

/** Fastify preHandler: resolves the session cookie to req.user or 401s. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = req.cookies[SESSION_COOKIE]
  if (!raw) {
    await reply.code(401).send({ error: 'Not authenticated' })
    return
  }
  const rows = await db
    .select({ userId: sessions.userId, email: users.email })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256Hex(raw)), gt(sessions.expiresAt, new Date())))
    .limit(1)
  const row = rows[0]
  if (!row) {
    await reply.code(401).send({ error: 'Not authenticated' })
    return
  }
  req.user = { id: row.userId, email: row.email }
}

/** Membership probe usable outside request params (e.g. budgetId in a body). */
export async function isBudgetMember(userId: string | undefined, budgetId: string): Promise<boolean> {
  if (!userId) return false
  const rows = await db
    .select({ role: budgetMembers.role })
    .from(budgetMembers)
    .where(and(eq(budgetMembers.budgetId, budgetId), eq(budgetMembers.userId, userId)))
    .limit(1)
  return rows.length > 0
}

/** Require that the authenticated user is a member of :budgetId. */
export async function requireBudgetMember(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user) {
    await reply.code(401).send({ error: 'Not authenticated' })
    return
  }
  const { budgetId } = req.params as { budgetId: string }
  if (!(await isBudgetMember(req.user.id, budgetId))) {
    await reply.code(403).send({ error: 'Not a member of this budget' })
  }
}
