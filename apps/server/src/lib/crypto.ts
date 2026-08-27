import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto'

/**
 * AES-256-GCM encryption for provider credentials at rest.
 * Key is derived from APP_SECRET via scrypt — never store the key itself.
 */

function appSecret(): string {
  const secret = process.env.APP_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('APP_SECRET must be set to at least 32 characters')
  }
  return secret
}

let cachedKey: Buffer | null = null
function key(): Buffer {
  if (!cachedKey) {
    cachedKey = scryptSync(appSecret(), 'tally-credentials-v1', 32)
  }
  return cachedKey
}

/** Encrypt plaintext → base64(iv | authTag | ciphertext). */
export function encryptPayload(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext]).toString('base64')
}

/** Decrypt base64(iv | authTag | ciphertext) → plaintext. Throws on tamper. */
export function decryptPayload(encoded: string): string {
  const raw = Buffer.from(encoded, 'base64')
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const ciphertext = raw.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/** SHA-256 hex hash — used for session tokens (never store raw tokens). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
