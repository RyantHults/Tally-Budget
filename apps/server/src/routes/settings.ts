import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../db/index.js'
import { providerCredentials } from '../db/schema.js'
import { requireAuth } from '../lib/auth.js'
import { encryptPayload } from '../lib/crypto.js'

const CredentialPut = z.object({
  providerName: z.string().min(1).max(50),
  /** Raw secret material (e.g. SimpleFin setup/access token). Encrypted before storage. */
  payload: z.string().min(1),
})

export function settingsRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', requireAuth)

  /** List stored credential providers — metadata only, never the secrets. */
  app.get('/settings/credentials', async () => {
    return db
      .select({
        providerName: providerCredentials.providerName,
        createdAt: providerCredentials.createdAt,
      })
      .from(providerCredentials)
  })

  /** Upsert an encrypted credential for a provider (instance-level). */
  app.put('/settings/credentials', async (req) => {
    const body = CredentialPut.parse(req.body)
    const encryptedPayload = encryptPayload(body.payload)
    const [row] = await db
      .insert(providerCredentials)
      .values({ providerName: body.providerName, encryptedPayload })
      .onConflictDoUpdate({
        target: providerCredentials.providerName,
        set: { encryptedPayload },
      })
      .returning({ providerName: providerCredentials.providerName })
    return row
  })

  app.delete('/settings/credentials/:providerName', async (req, reply) => {
    const { providerName } = req.params as { providerName: string }
    await db.delete(providerCredentials).where(eq(providerCredentials.providerName, providerName))
    return reply.code(204).send()
  })
}
