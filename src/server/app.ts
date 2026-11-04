import { randomInt } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { WebSocket } from 'ws'
import { MAX_SEATS } from '../engine/index.ts'
import {
  apply,
  createRoom,
  viewFor,
  type AdminActor,
  type ApplyResult,
  type RoomCommand,
  type RoomContext,
  type RoomState,
} from '../room/index.ts'
import {
  AdminCommandSchema,
  AdminLoginSchema,
  ClientMessageSchema,
  InviteCreateSchema,
  InviteIdParamsSchema,
  JoinOpenSchema,
  JoinRequestSchema,
  ResetRoomSchema,
  type AdminCommand,
  type InviteMeta,
  type InviteRecord,
} from '../protocol/index.ts'
import { RateLimiter, hashSecret, newId, randomToken, secretEquals, sha256, verifySecret } from './security.ts'
import { Store, type AdminAccount } from './store.ts'

export interface AdminBootstrap {
  username: string
  password: string
}

export interface ServerOptions {
  dataDir: string
  publicDir: string
  /** Signing secret for cookies. */
  sessionSecret: string
  /** Empty string disables in-table administration. */
  tableAdminKey: string
  /** Public base URL without a trailing slash, e.g. https://host/poker. Empty derives from the request. */
  publicUrl: string
  cookieSecure: boolean
  trustProxy: boolean
  logger?: boolean
  adminBootstrap?: AdminBootstrap | null
}

export interface PokerServer {
  app: FastifyInstance
  store: Store
  getRoom: () => RoomState
  close: () => Promise<void>
}

const PLAYER_COOKIE = 'poker_token'
const ADMIN_COOKIE = 'poker_admin'
const PLAYER_COOKIE_MAX_AGE = 60 * 60 * 24 * 180
const ADMIN_SESSION_MS = 1000 * 60 * 60 * 24 * 60

interface Connection {
  socket: WebSocket
  playerId: string
  tableAdmin: boolean
  alive: boolean
}

export async function createServer(options: ServerOptions): Promise<PokerServer> {
  const app = Fastify({
    logger: options.logger ?? true,
    trustProxy: options.trustProxy,
    bodyLimit: 64 * 1024,
  })

  const store = new Store(options.dataDir)
  await store.init()
  let room: RoomState = (await store.loadRoom()) ?? createRoom()
  let admin: AdminAccount | null = await store.loadAdmin()

  if (admin === null && options.adminBootstrap !== null && options.adminBootstrap !== undefined) {
    const { username, password } = options.adminBootstrap
    admin = {
      username,
      passwordHash: await hashSecret(password),
      totpSecret: null,
      createdAt: Date.now(),
    }
    await store.saveAdmin(admin)
    app.log.info(`[admin] created administrator "${username}" from configuration`)
  }
  if (admin === null) {
    app.log.warn('[admin] no administrator configured; run "npm run admin:create -- <username> <password>"')
  }

  await app.register(cookie, { secret: options.sessionSecret })
  await app.register(websocket)

  const joinLimiter = new RateLimiter()
  const adminLoginLimiter = new RateLimiter()
  const unlockLimiter = new RateLimiter()
  const pinFailures = new Map<string, { count: number; lockedUntil: number }>()

  const connections = new Map<WebSocket, Connection>()
  const playerSockets = new Map<string, Set<WebSocket>>()
  let closing = false

  function makeContext(): RoomContext {
    return {
      now: Date.now(),
      random: () => randomInt(0, 0x1_0000_0000) / 0x1_0000_0000,
      newId: () => newId(),
    }
  }

  function mutate(command: RoomCommand, mutateOptions: { broadcast?: boolean } = {}): ApplyResult {
    const result = apply(room, command, makeContext())
    if (result.room !== room) {
      room = result.room
      store.scheduleRoomSave(room)
      if (mutateOptions.broadcast !== false) broadcast()
    }
    return result
  }

  function send(socket: WebSocket, payload: unknown): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
  }

  function sendError(socket: WebSocket, code: string, message: string): void {
    send(socket, { type: 'error', code, message })
  }

  function broadcast(): void {
    for (const [socket, connection] of connections) {
      const player = room.players.find(candidate => candidate.id === connection.playerId)
      if (player === undefined) {
        send(socket, { type: 'removed' })
        socket.close(4003, 'removed')
        continue
      }
      send(socket, { type: 'view', view: viewFor(room, player.id) })
    }
  }

  function sendView(socket: WebSocket, playerId: string): void {
    send(socket, { type: 'view', view: viewFor(room, playerId) })
  }

  function readPlayer(request: FastifyRequest) {
    const token = request.cookies[PLAYER_COOKIE]
    if (token === undefined || token.length === 0) return null
    const hash = sha256(token)
    return room.players.find(player => player.tokenHash === hash && !player.kicked) ?? null
  }

  function readAdmin(request: FastifyRequest): string | null {
    if (admin === null) return null
    const raw = request.cookies[ADMIN_COOKIE]
    if (raw === undefined || raw.length === 0) return null
    const unsigned = request.unsignCookie(raw)
    if (!unsigned.valid || unsigned.value === null) return null
    try {
      const payload: unknown = JSON.parse(Buffer.from(unsigned.value, 'base64url').toString('utf8'))
      if (typeof payload !== 'object' || payload === null) return null
      const record = payload as Record<string, unknown>
      if (record.u !== admin.username) return null
      if (typeof record.exp !== 'number' || record.exp < Date.now()) return null
      return admin.username
    } catch {
      return null
    }
  }

  function setPlayerCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(PLAYER_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: options.cookieSecure,
      maxAge: PLAYER_COOKIE_MAX_AGE,
    })
  }

  function setAdminCookie(reply: FastifyReply, username: string): void {
    const exp = Date.now() + ADMIN_SESSION_MS
    const value = Buffer.from(JSON.stringify({ u: username, exp })).toString('base64url')
    reply.setCookie(ADMIN_COOKIE, value, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: options.cookieSecure,
      signed: true,
      maxAge: Math.floor(ADMIN_SESSION_MS / 1000),
    })
  }

  function requireAdmin(request: FastifyRequest, reply: FastifyReply): string | null {
    const username = readAdmin(request)
    if (username === null) {
      void reply.code(401).send({ error: 'Administrator login required' })
      return null
    }
    return username
  }

  function statusFor(code: string): number {
    switch (code) {
      case 'invite-required':
      case 'invite-invalid':
      case 'invite-expired':
      case 'invite-used':
      case 'invite-name-mismatch':
      case 'forbidden':
        return 403
      case 'unknown-player':
      case 'invite-not-found':
        return 404
      case 'invalid-name':
      case 'invalid-seat':
      case 'invalid-credentials':
      case 'invalid-amount':
      case 'invalid-blinds':
      case 'invalid-stack':
      case 'invalid-invite':
      case 'bad-message':
        return 400
      default:
        return 409
    }
  }

  function inviteMeta(invite: InviteRecord): InviteMeta {
    return {
      id: invite.id,
      label: invite.label,
      nickname: invite.nickname,
      maxUses: invite.maxUses,
      usedCount: invite.usedCount,
      expiresAt: invite.expiresAt,
      revoked: invite.revoked,
      createdAt: invite.createdAt,
      createdBy: invite.createdBy,
    }
  }

  function roomSummary() {
    return {
      joinOpen: room.settings.joinOpen,
      phase: room.phase,
      paused: room.paused,
      handNumber: room.handNumber,
      players: room.players.filter(player => !player.kicked).length,
      seats: MAX_SEATS,
      smallBlind: room.settings.smallBlind,
      bigBlind: room.settings.bigBlind,
      startingStack: room.settings.startingStack,
    }
  }

  async function audit(actor: string, source: 'account' | 'tableKey' | 'system', action: string, detail: Record<string, unknown>): Promise<void> {
    await store.audit({ at: Date.now(), actor, source, action, detail })
  }

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('X-Robots-Tag', 'noindex, nofollow')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'DENY')
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'",
    )
    return payload
  })

  app.get('/api/room', async () => roomSummary())

  app.get('/api/me', async request => {
    const player = readPlayer(request)
    return {
      player: player === null ? null : {
        id: player.id,
        name: player.name,
        seat: player.seat,
        stack: player.stack,
        connected: player.connected,
      },
      admin: readAdmin(request) !== null,
      room: roomSummary(),
    }
  })

  app.post('/api/join', async (request, reply) => {
    if (!joinLimiter.allow(`join:${request.ip}`, 20, 60_000)) {
      return reply.code(429).send({ error: 'Too many attempts; wait a minute' })
    }
    const parsed = JoinRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid join request' })
    const body = parsed.data
    const name = body.name.trim()

    const existing = room.players.find(player => !player.kicked && player.name.toLocaleLowerCase() === name.toLocaleLowerCase())
    if (existing !== undefined) {
      const failure = pinFailures.get(existing.id)
      if (failure !== undefined && failure.lockedUntil > Date.now()) {
        return reply.code(423).send({ error: 'Too many wrong PINs; try again later' })
      }
      const valid = await verifySecret(body.pin, existing.pinHash)
      if (!valid) {
        const count = (failure?.count ?? 0) + 1
        pinFailures.set(existing.id, {
          count,
          lockedUntil: count >= 5 ? Date.now() + 10 * 60_000 : 0,
        })
        return reply.code(401).send({ error: 'Wrong PIN' })
      }
      pinFailures.delete(existing.id)
      const token = randomToken()
      const result = mutate({ type: 'authenticate', playerId: existing.id, tokenHash: sha256(token) })
      if (result.error !== null) return reply.code(statusFor(result.error.code)).send({ error: result.error.message })
      setPlayerCookie(reply, token)
      return { ok: true, playerId: existing.id, name: existing.name }
    }

    const pinHash = await hashSecret(body.pin)
    const token = randomToken()
    const result = mutate({
      type: 'join',
      name,
      pinHash,
      tokenHash: sha256(token),
      inviteCodeHash: body.invite === undefined ? null : sha256(body.invite),
      seat: body.seat ?? null,
    })
    if (result.error !== null) {
      return reply.code(statusFor(result.error.code)).send({ error: result.error.message, code: result.error.code })
    }
    setPlayerCookie(reply, token)
    const player = room.players.find(candidate => candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())
    return { ok: true, playerId: player?.id ?? null, name: player?.name ?? name }
  })

  app.post('/api/logout', async (_request, reply) => {
    reply.clearCookie(PLAYER_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.post('/api/admin/login', async (request, reply) => {
    if (!adminLoginLimiter.allow(`admin-login:${request.ip}`, 8, 10 * 60_000)) {
      return reply.code(429).send({ error: 'Too many login attempts; try again later' })
    }
    if (admin === null) return reply.code(503).send({ error: 'No administrator is configured' })
    const parsed = AdminLoginSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid login request' })
    const valid = parsed.data.username === admin.username && await verifySecret(parsed.data.password, admin.passwordHash)
    if (!valid) {
      await audit(parsed.data.username, 'account', 'admin.login.failed', { ip: request.ip })
      return reply.code(401).send({ error: 'Wrong username or password' })
    }
    adminLoginLimiter.reset(`admin-login:${request.ip}`)
    setAdminCookie(reply, admin.username)
    await audit(admin.username, 'account', 'admin.login', { ip: request.ip })
    return { ok: true, username: admin.username }
  })

  app.post('/api/admin/logout', async (_request, reply) => {
    reply.clearCookie(ADMIN_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.get('/api/admin/invites', async (request, reply) => {
    if (requireAdmin(request, reply) === null) return
    return { invites: [...room.invites].sort((a, b) => b.createdAt - a.createdAt).map(inviteMeta) }
  })

  app.post('/api/admin/invites', async (request, reply) => {
    const username = requireAdmin(request, reply)
    if (username === null) return
    const parsed = InviteCreateSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid invite request' })
    const body = parsed.data
    const code = randomToken(32)
    const record: InviteRecord = {
      id: newId(),
      codeHash: sha256(code),
      label: body.label?.trim() ?? '',
      nickname: body.nickname?.trim() || null,
      maxUses: body.maxUses ?? 1,
      usedCount: 0,
      expiresAt: body.expiresInHours === undefined ? null : Date.now() + body.expiresInHours * 60 * 60 * 1000,
      revoked: false,
      createdAt: Date.now(),
      createdBy: username,
    }
    const result = mutate({ type: 'adminCreateInvite', actor: { kind: 'account', label: username }, invite: record })
    if (result.error !== null) return reply.code(statusFor(result.error.code)).send({ error: result.error.message })
    await audit(username, 'account', 'invite.create', { inviteId: record.id, label: record.label, maxUses: record.maxUses })
    const origin = options.publicUrl !== '' ? options.publicUrl : `${request.protocol}://${request.host}`
    return {
      invite: inviteMeta(record),
      code,
      url: `${origin}/?invite=${encodeURIComponent(code)}`,
    }
  })

  app.post('/api/admin/invites/revoke-all', async (request, reply) => {
    const username = requireAdmin(request, reply)
    if (username === null) return
    const result = mutate({ type: 'adminRevokeAllInvites', actor: { kind: 'account', label: username } })
    if (result.error !== null) return reply.code(statusFor(result.error.code)).send({ error: result.error.message })
    await audit(username, 'account', 'invite.revoke-all', {})
    return { ok: true }
  })

  app.post('/api/admin/invites/:id/revoke', async (request, reply) => {
    const username = requireAdmin(request, reply)
    if (username === null) return
    const params = InviteIdParamsSchema.safeParse(request.params)
    if (!params.success) return reply.code(400).send({ error: 'Invalid invite id' })
    const result = mutate({ type: 'adminRevokeInvite', actor: { kind: 'account', label: username }, inviteId: params.data.id })
    if (result.error !== null) return reply.code(statusFor(result.error.code)).send({ error: result.error.message })
    await audit(username, 'account', 'invite.revoke', { inviteId: params.data.id })
    return { ok: true }
  })

  app.post('/api/admin/invites/:id/delete', async (request, reply) => {
    const username = requireAdmin(request, reply)
    if (username === null) return
    const params = InviteIdParamsSchema.safeParse(request.params)
    if (!params.success) return reply.code(400).send({ error: 'Invalid invite id' })
    const result = mutate({ type: 'adminDeleteInvite', actor: { kind: 'account', label: username }, inviteId: params.data.id })
    if (result.error !== null) return reply.code(statusFor(result.error.code)).send({ error: result.error.message })
    await audit(username, 'account', 'invite.delete', { inviteId: params.data.id })
    return { ok: true }
  })

  app.post('/api/admin/room/reset', async (request, reply) => {
    const username = requireAdmin(request, reply)
    if (username === null) return
    const parsed = ResetRoomSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Type RESET to confirm' })
    const result = mutate(
      { type: 'adminResetRoom', actor: { kind: 'account', label: username } },
      { broadcast: false },
    )
    if (result.error !== null) return reply.code(statusFor(result.error.code)).send({ error: result.error.message })
    await audit(username, 'account', 'room.reset', { epoch: room.epoch })
    for (const socket of connections.keys()) {
      send(socket, { type: 'roomReset', epoch: room.epoch })
      socket.close(4001, 'room-reset')
    }
    return { ok: true, epoch: room.epoch }
  })

  app.post('/api/admin/room/open', async (request, reply) => {
    const username = requireAdmin(request, reply)
    if (username === null) return
    const parsed = JoinOpenSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid room request' })
    const result = mutate({ type: 'adminSetJoinOpen', actor: { kind: 'account', label: username }, joinOpen: parsed.data.joinOpen })
    if (result.error !== null) return reply.code(statusFor(result.error.code)).send({ error: result.error.message })
    await audit(username, 'account', 'room.joinOpen', { joinOpen: parsed.data.joinOpen })
    return { ok: true, joinOpen: room.settings.joinOpen }
  })

  app.post('/api/admin/table/reset', async (request, reply) => {
    const username = requireAdmin(request, reply)
    if (username === null) return
    const result = mutate({ type: 'adminResetTable', actor: { kind: 'account', label: username } })
    if (result.error !== null) return reply.code(statusFor(result.error.code)).send({ error: result.error.message })
    await audit(username, 'account', 'table.reset', {})
    return { ok: true }
  })

  if (existsSync(options.publicDir)) {
    await app.register(fastifyStatic, { root: options.publicDir, prefix: '/' })
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' })
    }
    if (existsSync(path.join(options.publicDir, 'index.html'))) {
      reply.header('Cache-Control', 'no-store')
      return reply.sendFile('index.html')
    }
    return reply.code(503).send('Client build is missing. Run "npm run build".')
  })

  function toRoomCommand(payload: AdminCommand, actor: AdminActor): RoomCommand {
    switch (payload.type) {
      case 'redeal': return { type: 'adminRedeal', actor }
      case 'resetTable': return { type: 'adminResetTable', actor }
      case 'topUp': return { type: 'adminTopUp', actor, playerId: payload.playerId, amount: payload.amount }
      case 'setStack': return { type: 'adminSetStack', actor, playerId: payload.playerId, stack: payload.stack }
      case 'kick': return { type: 'adminKick', actor, playerId: payload.playerId }
      case 'pause': return { type: 'adminPause', actor, paused: payload.paused }
      case 'forceAction': return { type: 'adminForceAction', actor, playerId: payload.playerId, action: payload.action }
      case 'setBlinds': return { type: 'adminSetBlinds', actor, smallBlind: payload.smallBlind, bigBlind: payload.bigBlind }
      case 'setStartingStack': return { type: 'adminSetStartingStack', actor, startingStack: payload.startingStack }
      case 'setTableCosmetics': return { type: 'adminSetTableCosmetics', actor, cosmetics: payload.cosmetics }
    }
  }

  function handleSocketMessage(connection: Connection, raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      sendError(connection.socket, 'bad-message', 'Message must be JSON')
      return
    }
    const message = ClientMessageSchema.safeParse(parsed)
    if (!message.success) {
      sendError(connection.socket, 'bad-message', 'Invalid message')
      return
    }
    const socket = connection.socket
    const data = message.data

    if (data.type === 'ping') {
      send(socket, { type: 'pong' })
      return
    }

    if (data.type === 'adminUnlock') {
      if (!unlockLimiter.allow(`unlock:${connection.playerId}`, 5, 5 * 60_000)) {
        sendError(socket, 'rate-limited', 'Too many attempts')
        return
      }
      if (options.tableAdminKey === '' || !secretEquals(data.key, options.tableAdminKey)) {
        void audit(connection.playerId, 'tableKey', 'table.unlock.failed', {})
        sendError(socket, 'forbidden', 'Wrong table key')
        return
      }
      connection.tableAdmin = true
      void audit(connection.playerId, 'tableKey', 'table.unlock', {})
      send(socket, { type: 'admin', unlocked: true })
      return
    }

    if (data.type === 'admin') {
      if (!connection.tableAdmin) {
        sendError(socket, 'forbidden', 'Unlock with the table key first')
        return
      }
      const command = toRoomCommand(data.command, { kind: 'tableKey', label: connection.playerId })
      const result = mutate(command)
      if (result.error !== null) {
        sendError(socket, result.error.code, result.error.message)
        return
      }
      void audit(connection.playerId, 'tableKey', `table.${data.command.type}`, { command: data.command })
      send(socket, { type: 'ack', command: data.command.type })
      return
    }

    let command: RoomCommand
    if (data.type === 'sit') {
      command = { type: 'sit', playerId: connection.playerId, seat: data.seat }
    } else if (data.type === 'stand') {
      command = { type: 'stand', playerId: connection.playerId }
    } else if (data.type === 'ready') {
      command = { type: 'ready', playerId: connection.playerId }
    } else if (data.type === 'setCosmetics') {
      command = { type: 'setCosmetics', playerId: connection.playerId, cosmetics: data.cosmetics }
    } else {
      command = data.raiseTo === undefined
        ? {
          type: 'act',
          playerId: connection.playerId,
          handId: data.handId,
          version: data.version,
          action: data.action,
        }
        : {
          type: 'act',
          playerId: connection.playerId,
          handId: data.handId,
          version: data.version,
          action: data.action,
          raiseTo: data.raiseTo,
        }
    }
    const result = mutate(command)
    if (result.error !== null) sendError(socket, result.error.code, result.error.message)
  }

  app.get('/ws', { websocket: true }, (socket, request) => {
    const player = readPlayer(request)
    if (player === null) {
      socket.close(4001, 'unauthorized')
      return
    }
    const reconnected = mutate({ type: 'reconnect', playerId: player.id })
    if (reconnected.error !== null) {
      socket.close(4001, 'unauthorized')
      return
    }

    const connection: Connection = {
      socket,
      playerId: player.id,
      tableAdmin: false,
      alive: true,
    }
    connections.set(socket, connection)
    let sockets = playerSockets.get(player.id)
    if (sockets === undefined) {
      sockets = new Set()
      playerSockets.set(player.id, sockets)
    }
    sockets.add(socket)
    sendView(socket, player.id)

    socket.on('pong', () => {
      connection.alive = true
    })
    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const text = raw.toString()
      if (text.length > 16_384) {
        socket.close(1009, 'too-large')
        return
      }
      handleSocketMessage(connection, text)
    })
    socket.on('error', error => {
      request.log.warn({ err: error }, 'websocket error')
    })
    socket.on('close', () => {
      connections.delete(socket)
      const peers = playerSockets.get(player.id)
      if (peers !== undefined) {
        peers.delete(socket)
        if (peers.size === 0) playerSockets.delete(player.id)
      }
      if (!playerSockets.has(player.id) && !closing) mutate({ type: 'disconnect', playerId: player.id })
    })
  })

  const heartbeat = setInterval(() => {
    for (const [socket, connection] of connections) {
      if (!connection.alive) {
        socket.terminate()
        continue
      }
      connection.alive = false
      try {
        socket.ping()
      } catch {
        socket.terminate()
      }
    }
  }, 30_000)
  heartbeat.unref()

  let closed = false
  async function close(): Promise<void> {
    if (closed) return
    closed = true
    closing = true
    clearInterval(heartbeat)
    for (const socket of connections.keys()) {
      try {
        socket.close(1001, 'server-shutdown')
      } catch {
        socket.terminate()
      }
    }
    await store.flush()
    await app.close()
  }

  return {
    app,
    store,
    getRoom: () => room,
    close,
  }
}
