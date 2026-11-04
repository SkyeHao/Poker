import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)

const KEY_LENGTH = 64

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scrypt(secret, salt, KEY_LENGTH) as Buffer
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const saltText = parts[1]
  const hashText = parts[2]
  if (saltText === undefined || hashText === undefined) return false
  const salt = Buffer.from(saltText, 'base64url')
  const expected = Buffer.from(hashText, 'base64url')
  if (expected.length === 0) return false
  const derived = await scrypt(secret, salt, expected.length) as Buffer
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

export function secretEquals(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

export function newId(bytes = 12): string {
  return randomBytes(bytes).toString('base64url')
}

export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>()

  allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const current = this.hits.get(key)
    if (current === undefined || current.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + windowMs })
      return true
    }
    current.count += 1
    return current.count <= limit
  }

  reset(key: string): void {
    this.hits.delete(key)
  }
}
