import path from 'node:path'
import { randomToken } from './security.ts'
import type { AdminBootstrap, ServerOptions } from './app.ts'

export interface ServerConfig extends ServerOptions {
  port: number
  host: string
}

/**
 * Load and validate runtime configuration.
 *
 * `PUBLIC_URL` is the full public entry point, including any sub-path, without
 * a trailing slash (e.g. https://tangping.work:8443/poker). It is required in
 * production and whenever the app is built for a sub-path, because invite
 * links are built from it rather than from the incoming request.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === 'production'
  const publicUrl = normalizePublicUrl(env.PUBLIC_URL)
  const basePath = normalizeBasePath(env.POKER_BASE)

  if (publicUrl === '' && (production || basePath !== '')) {
    throw new Error(
      'PUBLIC_URL is required in production and whenever POKER_BASE is set. '
      + 'Set it to the public entry point, e.g. https://poker.example.com or https://host/poker.',
    )
  }
  if (publicUrl !== '') {
    let parsed: URL
    try {
      parsed = new URL(publicUrl)
    } catch {
      throw new Error(`PUBLIC_URL is not a valid URL: ${publicUrl}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`PUBLIC_URL must use http or https: ${publicUrl}`)
    }
    if (basePath !== '' && normalizeBasePath(parsed.pathname) !== basePath) {
      throw new Error(
        `PUBLIC_URL (${publicUrl}) must end with the sub-path from POKER_BASE (${basePath}); `
        + 'invite links are built from PUBLIC_URL.',
      )
    }
  }

  const sessionSecret = env.SESSION_SECRET?.trim() || randomToken()
  const tableAdminKey = env.TABLE_ADMIN_KEY?.trim() ?? ''
  if (!env.SESSION_SECRET?.trim()) {
    console.warn('[config] SESSION_SECRET is unset; administrator sessions will not survive a restart')
  }
  if (tableAdminKey === '') {
    console.warn('[config] TABLE_ADMIN_KEY is unset; in-table administration is disabled')
  }

  return {
    port: parsePort(env.PORT),
    host: env.HOST?.trim() || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR ?? 'data'),
    publicDir: path.resolve(env.PUBLIC_DIR ?? 'dist/public'),
    sessionSecret,
    tableAdminKey,
    publicUrl,
    cookieSecure: env.COOKIE_SECURE === 'true' || (production && env.COOKIE_SECURE !== 'false'),
    trustProxy: env.TRUST_PROXY !== 'false',
    logger: true,
    adminBootstrap: adminBootstrap(env),
  }
}

function adminBootstrap(env: NodeJS.ProcessEnv): AdminBootstrap | null {
  const username = env.ADMIN_USERNAME?.trim()
  const password = env.ADMIN_PASSWORD
  if (username === undefined || username.length === 0 || password === undefined || password.length < 12) {
    return null
  }
  return { username, password }
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 3000
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`PORT must be an integer between 0 and 65535, got "${value}"`)
  }
  return port
}

function normalizePublicUrl(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '')
}

/** '' for the root, '/poker' for '/poker/' or 'poker'. */
function normalizeBasePath(value: string | undefined): string {
  const trimmed = (value ?? '').trim()
  if (trimmed === '' || trimmed === '/') return ''
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withLeading.replace(/\/+$/, '')
}
