import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../src/server/config.ts'

const secret = 'test-session-secret-0123456789abcdef'

test('PUBLIC_URL is required in production', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: secret }),
    /PUBLIC_URL is required/,
  )
})

test('a sub-path deployment requires PUBLIC_URL with that sub-path', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'development', SESSION_SECRET: secret, POKER_BASE: '/poker/' }),
    /PUBLIC_URL is required/,
  )
  assert.throws(
    () => loadConfig({
      NODE_ENV: 'development',
      SESSION_SECRET: secret,
      POKER_BASE: '/poker/',
      PUBLIC_URL: 'https://poker.example',
    }),
    /must end with the sub-path/,
  )
})

test('a valid PUBLIC_URL is normalized and must use http(s)', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    SESSION_SECRET: secret,
    POKER_BASE: '/poker/',
    PUBLIC_URL: 'https://poker.example:8443/poker/',
  })
  assert.equal(config.publicUrl, 'https://poker.example:8443/poker')
  assert.equal(config.cookieSecure, true)
  assert.throws(
    () => loadConfig({ SESSION_SECRET: secret, PUBLIC_URL: 'ftp://poker.example' }),
    /http or https/,
  )
})

test('PORT is validated', () => {
  assert.throws(() => loadConfig({ SESSION_SECRET: secret, PORT: 'eighty' }), /PORT/)
  assert.throws(() => loadConfig({ SESSION_SECRET: secret, PORT: '70000' }), /PORT/)
  assert.equal(loadConfig({ SESSION_SECRET: secret, PORT: '0' }).port, 0)
})
