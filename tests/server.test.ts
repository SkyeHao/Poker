import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WebSocket } from 'ws'
import type { RoomView } from '../src/room/index.ts'
import { createServer, type PokerServer } from '../src/server/app.ts'

interface ViewMessage {
  type: 'view'
  view: RoomView
}

type ServerMessage = Record<string, any>

function cookieHeader(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie']
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  return values.map(value => value.split(';')[0]).filter(Boolean).join('; ')
}

async function withServer(run: (server: PokerServer, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'poker-server-'))
  const server = await createServer({
    dataDir: dir,
    publicDir: path.join(dir, 'public'),
    sessionSecret: 'test-session-secret-0123456789abcdef',
    tableAdminKey: 'test-table-key',
    publicUrl: 'https://poker.example',
    cookieSecure: false,
    trustProxy: false,
    logger: false,
    adminBootstrap: { username: 'admin', password: 'test-password-123' },
  })
  try {
    await server.app.ready()
    await run(server, dir)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
}

class TestClient {
  readonly socket: WebSocket
  readonly messages: ServerMessage[] = []
  private readonly waiters: Array<{
    predicate: (message: ServerMessage) => boolean
    resolve: (message: ServerMessage) => void
    timer: NodeJS.Timeout
  }> = []

  constructor(url: string, cookie: string) {
    this.socket = new WebSocket(url, { headers: { cookie } })
    this.socket.on('message', raw => {
      let message: ServerMessage
      try {
        message = JSON.parse(raw.toString()) as ServerMessage
      } catch {
        return
      }
      this.messages.push(message)
      this.flush()
    })
    this.socket.on('error', () => { /* surfaced through waitFor timeouts */ })
  }

  opened(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this.socket.once('open', () => { resolve() })
      this.socket.once('error', reject)
    })
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message))
  }

  waitFor(predicate: (message: ServerMessage) => boolean, timeoutMs = 5000): Promise<ServerMessage> {
    const existing = this.messages.find(predicate)
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex(waiter => waiter.timer === timer)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error('timed out waiting for a WebSocket message'))
      }, timeoutMs)
      this.waiters.push({ predicate, resolve, timer })
    })
  }

  close(): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
    }
    this.socket.close()
  }

  /** Like waitFor, but only messages that arrive after `index` (for repeated states). */
  waitAfter(index: number, predicate: (message: ServerMessage) => boolean, timeoutMs = 5000): Promise<ServerMessage> {
    const started = Date.now()
    return new Promise((resolve, reject) => {
      const tick = (): void => {
        const match = this.messages.slice(index).find(predicate)
        if (match !== undefined) {
          resolve(match)
          return
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error('timed out waiting for a new WebSocket message'))
          return
        }
        setTimeout(tick, 15)
      }
      tick()
    })
  }

  private flush(): void {
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index]
      if (waiter === undefined) continue
      const match = this.messages.find(waiter.predicate)
      if (match === undefined) continue
      this.waiters.splice(index, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(match)
    }
  }
}

async function loginAdmin(server: PokerServer): Promise<string> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { username: 'admin', password: 'test-password-123' },
  })
  assert.equal(response.statusCode, 200)
  return cookieHeader(response)
}

async function createInvite(server: PokerServer, cookie: string, maxUses: number): Promise<{ id: string; code: string; url: string }> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/admin/invites',
    headers: { cookie },
    payload: { maxUses },
  })
  assert.equal(response.statusCode, 200, response.body)
  const body = response.json<{ invite: { id: string }; code: string; url: string }>()
  return { id: body.invite.id, code: body.code, url: body.url }
}

async function joinPlayer(server: PokerServer, code: string, name: string, pin: string): Promise<{ cookie: string; playerId: string }> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/join',
    payload: { name, pin, invite: code },
  })
  assert.equal(response.statusCode, 200, response.body)
  const body = response.json<{ playerId: string }>()
  return { cookie: cookieHeader(response), playerId: body.playerId }
}

test('HTTP join flow validates invites, honors PUBLIC_URL, and rotates player tokens', async () => {
  await withServer(async server => {
    const summary = await server.app.inject({ method: 'GET', url: '/api/room' })
    assert.equal(summary.statusCode, 200)
    assert.deepEqual(
      { joinOpen: summary.json<{ joinOpen: boolean }>().joinOpen, seats: summary.json<{ seats: number }>().seats },
      { joinOpen: false, seats: 8 },
    )

    const wrongLogin = await server.app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { username: 'admin', password: 'wrong-password' },
    })
    assert.equal(wrongLogin.statusCode, 401)

    const adminCookie = await loginAdmin(server)
    const invite = await createInvite(server, adminCookie, 2)
    assert.match(invite.code, /^[A-Za-z0-9_-]+$/)
    assert.equal(invite.url, `https://poker.example/?invite=${encodeURIComponent(invite.code)}`)

    const withoutInvite = await server.app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name: 'Alice', pin: '1234' },
    })
    assert.equal(withoutInvite.statusCode, 403)

    const alice = await joinPlayer(server, invite.code, 'Alice', '1234')
    assert.ok(alice.cookie.includes('poker_token='))
    const me = await server.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: alice.cookie } })
    assert.equal(me.json<{ player: { name: string } | null }>().player?.name, 'Alice')

    const wrongPin = await server.app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name: 'Alice', pin: '9999' },
    })
    assert.equal(wrongPin.statusCode, 401)

    const recovered = await server.app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name: 'Alice', pin: '1234' },
    })
    assert.equal(recovered.statusCode, 200)
    const newCookie = cookieHeader(recovered)
    assert.notEqual(newCookie, alice.cookie)

    const stale = await server.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: alice.cookie } })
    assert.equal(stale.json<{ player: unknown }>().player, null, 'the rotated token stops working')
    const fresh = await server.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: newCookie } })
    assert.equal(fresh.json<{ player: { name: string } | null }>().player?.name, 'Alice')
  })
})

test('deleting an invite removes it and invalidates its link', async () => {
  await withServer(async server => {
    const adminCookie = await loginAdmin(server)
    const invite = await createInvite(server, adminCookie, 1)

    const listBefore = await server.app.inject({ method: 'GET', url: '/api/admin/invites', headers: { cookie: adminCookie } })
    assert.equal(
      listBefore.json<{ invites: Array<{ id: string }> }>().invites.some(entry => entry.id === invite.id),
      true,
    )

    const deleted = await server.app.inject({
      method: 'POST',
      url: `/api/admin/invites/${invite.id}/delete`,
      headers: { cookie: adminCookie },
    })
    assert.equal(deleted.statusCode, 200)

    const listAfter = await server.app.inject({ method: 'GET', url: '/api/admin/invites', headers: { cookie: adminCookie } })
    assert.equal(
      listAfter.json<{ invites: Array<{ id: string }> }>().invites.some(entry => entry.id === invite.id),
      false,
    )

    const joinAttempt = await server.app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { name: 'Alice', pin: '1234', invite: invite.code },
    })
    assert.equal(joinAttempt.statusCode, 403)
    assert.equal(joinAttempt.json<{ code?: string }>().code, 'invite-invalid')

    const repeat = await server.app.inject({
      method: 'POST',
      url: `/api/admin/invites/${invite.id}/delete`,
      headers: { cookie: adminCookie },
    })
    assert.equal(repeat.statusCode, 404)
  })
})

test('WebSocket flow deals a redacted hand, accepts an action, and survives reconnect', async () => {
  await withServer(async server => {
    const adminCookie = await loginAdmin(server)
    const invite = await createInvite(server, adminCookie, 3)
    const alice = await joinPlayer(server, invite.code, 'Alice', '1234')
    const bob = await joinPlayer(server, invite.code, 'Bob', '5678')

    await server.app.listen({ port: 0, host: '127.0.0.1' })
    const address = server.app.server.address() as AddressInfo
    const wsUrl = `ws://127.0.0.1:${address.port}/ws`

    const aliceClient = new TestClient(wsUrl, alice.cookie)
    const bobClient = new TestClient(wsUrl, bob.cookie)
    try {
      await Promise.all([aliceClient.opened(), bobClient.opened()])
      const seated = await aliceClient.waitFor(message => message.type === 'view' && (message as ViewMessage).view.you?.id === alice.playerId)
      assert.equal((seated as ViewMessage).view.you?.seat, 0)

      aliceClient.send({ type: 'ready' })
      bobClient.send({ type: 'ready' })

      const isPlaying = (message: ServerMessage): boolean => message.type === 'view' && (message as ViewMessage).view.phase === 'playing'
      const [playingMessage, bobPlayingMessage] = await Promise.all([
        aliceClient.waitFor(isPlaying),
        bobClient.waitFor(isPlaying),
      ])
      const playing = (playingMessage as ViewMessage).view
      const bobPlaying = (bobPlayingMessage as ViewMessage).view
      assert.ok(playing.handId !== null)
      assert.ok(playing.game !== null)
      assert.ok(bobPlaying.game !== null)

      const serialized = JSON.stringify(playing)
      assert.equal(serialized.includes('"deck"'), false, 'the deck must never be sent to a client')
      assert.equal(serialized.includes('pinHash'), false)
      assert.equal(serialized.includes('tokenHash'), false)
      const visibleHoleCards = playing.game?.seats.reduce((sum, seat) => sum + seat.hole.length, 0) ?? 0
      assert.equal(visibleHoleCards, 2, 'only the viewer hole cards are visible')
      assert.equal(playing.game?.seats.filter(seat => seat.inHand).every(seat => seat.holeCount === 2), true)

      const actingSeat = playing.game.actingSeat
      assert.notEqual(actingSeat, null)
      const actorId = playing.game.seats[actingSeat as number]?.id
      const actorClient = actorId === alice.playerId ? aliceClient : bobClient
      const actorView = actorId === alice.playerId ? playing : bobPlaying
      const legal = actorView.legal
      assert.ok(legal)

      actorClient.send({
        type: 'act',
        handId: playing.handId,
        version: playing.version,
        action: legal.canCheck ? 'check' : 'call',
      })
      const afterAction = await aliceClient.waitFor(message => message.type === 'view' && (message as ViewMessage).view.version > playing.version)
      assert.ok((afterAction as ViewMessage).view.version > playing.version)
      const versionAfterAction = (afterAction as ViewMessage).view.version

      for (const client of [aliceClient, bobClient]) {
        assert.equal(client.messages.some(message => message.type === 'error'), false, JSON.stringify(client.messages))
      }

      aliceClient.close()
      const aliceReconnected = new TestClient(wsUrl, alice.cookie)
      try {
        await aliceReconnected.opened()
        const reconnected = await aliceReconnected.waitFor(message => message.type === 'view' && (message as ViewMessage).view.you?.id === alice.playerId)
        const view = (reconnected as ViewMessage).view
        assert.equal(view.you?.seat, 0, 'the seat survives a reconnect')
        assert.equal(view.you?.connected, true)
        assert.equal(view.version, versionAfterAction, 'presence changes do not bump the table version')
        assert.equal(view.handId, playing.handId)
      } finally {
        aliceReconnected.close()
      }
    } finally {
      bobClient.close()
      aliceClient.close()
    }
  })
})

test('cosmetics round-trip over the socket and the admin can pin a table style', async () => {
  await withServer(async server => {
    const adminCookie = await loginAdmin(server)
    const invite = await createInvite(server, adminCookie, 2)
    const alice = await joinPlayer(server, invite.code, 'Alice', '1234')

    await server.app.listen({ port: 0, host: '127.0.0.1' })
    const address = server.app.server.address() as AddressInfo
    const client = new TestClient(`ws://127.0.0.1:${address.port}/ws`, alice.cookie)
    try {
      await client.opened()
      await client.waitFor(message => message.type === 'view')

      const cosmetics = { back: 'red', faces: { spades: 'witcher-3', hearts: '', clubs: '', diamonds: '' } }
      let mark = client.messages.length
      client.send({ type: 'setCosmetics', cosmetics })
      const applied = await client.waitAfter(mark, message => message.type === 'view' && message.view.cosmetics.back === 'red')
      assert.equal(applied.view.cosmetics.faces.spades, 'witcher-3')

      client.send({ type: 'adminUnlock', key: 'test-table-key' })
      await client.waitFor(message => message.type === 'admin' && message.unlocked === true)

      mark = client.messages.length
      client.send({
        type: 'admin',
        command: {
          type: 'setTableCosmetics',
          cosmetics: { back: '', faces: { spades: '', hearts: 'among-us', clubs: '', diamonds: '' } },
        },
      })
      const pinned = await client.waitAfter(mark, message => message.type === 'view' && message.view.cosmetics.faces.hearts === 'among-us')
      assert.equal(pinned.view.cosmetics.back, 'red', 'an unpinned slot keeps the personal back')
      assert.notEqual(pinned.view.cosmeticsOverride, null)

      mark = client.messages.length
      client.send({ type: 'admin', command: { type: 'setTableCosmetics', cosmetics: null } })
      const cleared = await client.waitAfter(mark, message => message.type === 'view' && message.view.cosmeticsOverride === null)
      assert.equal(cleared.view.cosmetics.back, 'red')
      assert.equal(cleared.view.cosmetics.faces.hearts, '')

      const errors = client.messages.filter(message => message.type === 'error')
      assert.deepEqual(errors, [])
    } finally {
      client.close()
    }
  })
})

test('the shipped card-art manifest only lists files that exist', async () => {
  const artDir = path.resolve('src/client/assets/card-art')
  const manifest = JSON.parse(await readFile(path.join(artDir, 'manifest.json'), 'utf8')) as {
    backs: Array<{ id: string }>
    faces: Array<{ suit: string; id: string }>
  }
  assert.equal(manifest.backs.length, 16)
  assert.equal(manifest.faces.length, 24)
  for (const back of manifest.backs) {
    const file = path.join(artDir, 'backs', `${back.id}.png`)
    const contents = await readFile(file)
    assert.deepEqual([...contents.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${file} is not a PNG`)
  }
  for (const set of manifest.faces) {
    const file = path.join(artDir, 'faces', `${set.suit}-${set.id}.png`)
    const contents = await readFile(file)
    assert.deepEqual([...contents.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${file} is not a PNG`)
  }
})