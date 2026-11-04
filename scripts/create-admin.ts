import path from 'node:path'
import { hashSecret } from '../src/server/security.ts'
import { Store } from '../src/server/store.ts'

const username = (process.argv[2] ?? process.env.ADMIN_USERNAME ?? '').trim()
const password = process.argv[3] ?? process.env.ADMIN_PASSWORD ?? ''

if (username.length === 0 || password.length < 12) {
  console.error('usage: npm run admin:create -- <username> <password>')
  console.error('password must be at least 12 characters (or set ADMIN_USERNAME/ADMIN_PASSWORD)')
  process.exit(1)
}

const store = new Store(path.resolve(process.env.DATA_DIR ?? 'data'))
await store.init()
await store.saveAdmin({
  username,
  passwordHash: await hashSecret(password),
  totpSecret: null,
  createdAt: Date.now(),
})
console.log(`administrator "${username}" saved`)
