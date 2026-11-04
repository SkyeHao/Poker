import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_STARTING_STACK,
  legalActionsFor,
  MAX_SEATS,
  SMALL_BLIND,
  BIG_BLIND,
} from '../src/engine/index.ts'
import {
  apply,
  createRoom,
  viewFor,
  type ApplyResult,
  type InviteRecord,
  type RoomContext,
  type RoomSettings,
  type RoomState,
} from '../src/room/room.ts'

function makeEnv(seed = 1): RoomContext {
  let value = seed >>> 0
  let nextId = 0
  return {
    now: 1_000_000,
    random: () => {
      value = (value * 1664525 + 1013904223) >>> 0
      return value / 0x100000000
    },
    newId: () => `p${++nextId}`,
  }
}

function must(result: ApplyResult): RoomState {
  assert.equal(result.error, null, result.error?.message)
  return result.room
}

function join(
  env: RoomContext,
  room: RoomState,
  name: string,
  options: { inviteCodeHash?: string | null; seat?: number | null } = {},
): ApplyResult {
  return apply(room, {
    type: 'join',
    name,
    pinHash: `pin:${name}`,
    tokenHash: `token:${name}`,
    inviteCodeHash: options.inviteCodeHash ?? null,
    seat: options.seat ?? null,
  }, env)
}

function ready(env: RoomContext, room: RoomState, playerId: string): ApplyResult {
  return apply(room, { type: 'ready', playerId }, env)
}

function findPlayer(room: RoomState, name: string) {
  const player = room.players.find(candidate => candidate.name === name)
  assert.ok(player, `missing player ${name}`)
  return player
}

function startTable(
  names: readonly string[],
  options: { seed?: number; settings?: Partial<RoomSettings> } = {},
): { env: RoomContext; room: RoomState } {
  const env = makeEnv(options.seed)
  let room = createRoom({ joinOpen: true, ...options.settings })
  for (const name of names) room = must(join(env, room, name))
  for (const player of room.players) room = must(ready(env, room, player.id))
  assert.equal(room.phase, 'playing', 'table should start once everyone is ready')
  return { env, room }
}

function playPassively(env: RoomContext, start: RoomState): RoomState {
  let room = start
  for (let guard = 0; guard < 400 && room.phase === 'playing'; guard += 1) {
    const hand = room.hand
    assert.ok(hand, 'playing room must have a hand')
    const acting = hand.actingSeat
    if (acting === null) assert.fail('playing hand must have an acting seat')
    const seat = hand.seats[acting]
    assert.ok(seat, 'acting seat must exist')
    const legal = legalActionsFor(hand, acting)
    room = must(apply(room, {
      type: 'act',
      playerId: seat.id,
      handId: `${room.epoch}:${room.handNumber}`,
      version: room.version,
      action: legal.canCheck ? 'check' : 'call',
    }, env))
  }
  assert.equal(room.phase, 'hand-over', 'hand should finish')
  return room
}

function totalChips(room: RoomState): number {
  if (room.hand === null || room.phase !== 'playing') {
    return room.players.reduce((sum, player) => sum + player.stack, 0)
  }
  return room.hand.seats.reduce((sum, seat) => sum + seat.stack + seat.committed, 0)
    + room.players.filter(player => player.seat === null).reduce((sum, player) => sum + player.stack, 0)
}

function invite(overrides: Partial<InviteRecord> = {}): InviteRecord {
  return {
    id: 'invite-1',
    codeHash: 'hash-1',
    label: 'friends',
    nickname: null,
    maxUses: 1,
    usedCount: 0,
    expiresAt: null,
    revoked: false,
    createdAt: 0,
    createdBy: 'admin',
    ...overrides,
  }
}

const account = { kind: 'account' as const, label: 'admin' }
const tableKey = { kind: 'tableKey' as const, label: 'table' }

test('closed rooms require a valid single-use invite', () => {
  const env = makeEnv(1)
  let room = createRoom()
  assert.equal(join(env, room, 'Alice').error?.code, 'invite-required')

  room = must(apply(room, { type: 'adminCreateInvite', actor: account, invite: invite() }, env))
  const alice = join(env, room, 'Alice', { inviteCodeHash: 'hash-1' })
  room = must(alice)
  assert.equal(room.players[0]?.seat, 0)
  assert.equal(room.invites[0]?.usedCount, 1)
  assert.equal(join(env, room, 'Bob', { inviteCodeHash: 'hash-1' }).error?.code, 'invite-used')
})

test('open rooms accept joins, enforce unique nicknames, and fail when full', () => {
  const env = makeEnv(2)
  let room = createRoom({ joinOpen: true })
  room = must(join(env, room, 'Alice'))
  assert.equal(join(env, room, 'alice').error?.code, 'name-taken')
  assert.equal(join(env, room, '  ').error?.code, 'invalid-name')
  room = must(join(env, room, 'Bob', { seat: 4 }))
  assert.equal(findPlayer(room, 'Bob').seat, 4)
  assert.equal(join(env, room, 'Carol', { seat: 4 }).error?.code, 'seat-taken')

  for (let index = 0; index < MAX_SEATS - 2; index += 1) {
    room = must(join(env, room, `P${index}`))
  }
  assert.equal(room.players.length, MAX_SEATS)
  assert.equal(join(env, room, 'Overflow').error?.code, 'room-full')
})

test('readiness starts a hand, rotates the dealer, and requires a fresh ready round', () => {
  const { env, room: started } = startTable(['Alice', 'Bob'])
  assert.equal(started.handNumber, 1)
  assert.equal(totalChips(started), 2 * DEFAULT_STARTING_STACK)
  assert.equal(started.hand?.seats.filter(seat => seat.inHand).length, 2)

  const firstDealer = started.hand?.dealer
  const finished = playPassively(env, started)
  assert.equal(totalChips(finished), 2 * DEFAULT_STARTING_STACK)
  assert.equal(finished.ready.length, 0)

  let room = finished
  room = must(ready(env, room, findPlayer(room, 'Alice').id))
  assert.equal(room.phase, 'hand-over', 'one ready player is not enough')
  room = must(ready(env, room, findPlayer(room, 'Bob').id))
  assert.equal(room.phase, 'playing')
  assert.equal(room.handNumber, 2)
  assert.notEqual(room.hand?.dealer, firstDealer)
})

test('offline players are skipped for the next hand and reconnect restores them', () => {
  const { env, room: started } = startTable(['Alice', 'Bob', 'Carol'])
  let room = playPassively(env, started)
  const carol = findPlayer(room, 'Carol')

  room = must(apply(room, { type: 'disconnect', playerId: carol.id }, env))
  assert.equal(findPlayer(room, 'Carol').connected, false)
  assert.equal(viewFor(room, carol.id).you?.connected, false)

  room = must(ready(env, room, findPlayer(room, 'Alice').id))
  assert.equal(room.phase, 'hand-over')
  room = must(ready(env, room, findPlayer(room, 'Bob').id))
  assert.equal(room.phase, 'playing')
  const carolSeat = findPlayer(room, 'Carol').seat
  assert.notEqual(carolSeat, null)
  assert.equal(room.hand?.seats[carolSeat as number]?.inHand, false)
  assert.equal(room.hand?.seats[carolSeat as number]?.hole.length, 0)

  room = must(apply(room, { type: 'reconnect', playerId: carol.id }, env))
  assert.equal(findPlayer(room, 'Carol').connected, true)
  room = must(apply(room, { type: 'authenticate', playerId: carol.id, tokenHash: 'rotated' }, env))
  assert.equal(findPlayer(room, 'Carol').tokenHash, 'rotated')
})

test('views redact the deck and other players hole cards until showdown', () => {
  const { env, room } = startTable(['Alice', 'Bob', 'Carol'])
  const alice = findPlayer(room, 'Alice')
  const bob = findPlayer(room, 'Bob')

  const aliceView = viewFor(room, alice.id)
  assert.equal(JSON.stringify(aliceView).includes('deck'), false)
  assert.equal(JSON.stringify(aliceView).includes('pinHash'), false)
  assert.equal(JSON.stringify(aliceView).includes('tokenHash'), false)
  const aliceSeat = aliceView.game?.seats[alice.seat as number]
  assert.ok(aliceSeat)
  assert.equal(aliceSeat.hole.length, 2)
  assert.equal(aliceSeat.isYou, true)

  for (const seat of aliceView.game?.seats ?? []) {
    if (seat.id === alice.id) continue
    if (seat.inHand) {
      assert.equal(seat.hole.length, 0, 'opponent hole cards must be hidden')
      assert.equal(seat.holeCount, 2)
    }
  }

  const actingSeat = room.hand?.actingSeat as number
  const actingPlayer = room.hand?.seats[actingSeat]
  assert.ok(actingPlayer)
  assert.equal(viewFor(room, actingPlayer.id).canAct, true)
  assert.notEqual(viewFor(room, actingPlayer.id).legal, null)
  assert.equal(viewFor(room, bob.id).canAct, false)
  assert.equal(viewFor(room, bob.id).legal, null)

  const finished = playPassively(env, room)
  const showdown = viewFor(finished, alice.id)
  for (const seat of showdown.game?.seats ?? []) {
    if (seat.inHand && !seat.folded) assert.equal(seat.hole.length, 2)
  }
  assert.equal(viewFor(finished, null).viewerSeat, null)
})

test('folded players are not revealed at showdown', () => {
  const { env, room } = startTable(['Alice', 'Bob', 'Carol'])
  const hand = room.hand
  assert.ok(hand)
  const actingSeat = hand.actingSeat as number
  const folder = hand.seats[actingSeat]
  assert.ok(folder)
  let next = must(apply(room, {
    type: 'act',
    playerId: folder.id,
    handId: `${room.epoch}:${room.handNumber}`,
    version: room.version,
    action: 'fold',
  }, env))
  next = playPassively(env, next)
  const view = viewFor(next, findPlayer(next, 'Alice').id)
  const folderSeat = view.game?.seats.find(seat => seat.id === folder.id)
  assert.ok(folderSeat)
  assert.equal(folderSeat.folded, true)
  assert.equal(folderSeat.hole.length, 0)
})

test('three reset levels keep different amounts of room state', () => {
  const { env, room: started } = startTable(['Alice', 'Bob', 'Carol'], { settings: { startingStack: 5_000_000 } })
  const alice = findPlayer(started, 'Alice')
  const aliceSeat = alice.seat as number
  const before = started.hand?.seats[aliceSeat]
  assert.ok(before)
  const chipsBefore = before.stack + before.committed
  const firstDealer = started.hand?.dealer
  const firstNumber = started.handNumber

  const redealt = must(apply(started, { type: 'adminRedeal', actor: tableKey }, env))
  assert.equal(redealt.phase, 'playing')
  assert.equal(redealt.handNumber, firstNumber)
  assert.equal(redealt.hand?.dealer, firstDealer)
  const after = redealt.hand?.seats[aliceSeat]
  assert.ok(after)
  assert.equal(after.stack + after.committed, chipsBefore)
  assert.equal(totalChips(redealt), totalChips(started))

  const invitation = invite({ id: 'keep-me', codeHash: 'keep-hash' })
  let withInvite = must(apply(redealt, { type: 'adminCreateInvite', actor: account, invite: invitation }, env))
  const tableReset = must(apply(withInvite, { type: 'adminResetTable', actor: tableKey }, env))
  assert.equal(tableReset.phase, 'waiting')
  assert.equal(tableReset.hand, null)
  assert.equal(tableReset.handNumber, 0)
  assert.equal(tableReset.players.length, 3)
  assert.equal(tableReset.invites.length, 1)
  for (const player of tableReset.players) assert.equal(player.stack, 5_000_000)
  assert.equal(findPlayer(tableReset, 'Alice').seat, aliceSeat)

  assert.equal(apply(tableReset, { type: 'adminResetRoom', actor: tableKey }, env).error?.code, 'forbidden')
  const houseReset = must(apply(tableReset, { type: 'adminResetRoom', actor: account }, env))
  assert.equal(houseReset.epoch, tableReset.epoch + 1)
  assert.equal(houseReset.players.length, 0)
  assert.equal(houseReset.invites.length, 0)
  assert.equal(houseReset.settings.startingStack, 5_000_000)
  withInvite = houseReset
  assert.equal(viewFor(withInvite, alice.id).you, null)
})

test('the table key cannot manage invites, open the room, or reset it', () => {
  const env = makeEnv(3)
  const room = createRoom()
  assert.equal(apply(room, { type: 'adminCreateInvite', actor: tableKey, invite: invite() }, env).error?.code, 'forbidden')
  assert.equal(apply(room, { type: 'adminRevokeInvite', actor: tableKey, inviteId: 'x' }, env).error?.code, 'forbidden')
  assert.equal(apply(room, { type: 'adminRevokeAllInvites', actor: tableKey }, env).error?.code, 'forbidden')
  assert.equal(apply(room, { type: 'adminSetJoinOpen', actor: tableKey, joinOpen: true }, env).error?.code, 'forbidden')
  assert.equal(apply(room, { type: 'adminResetRoom', actor: tableKey }, env).error?.code, 'forbidden')
})

test('invites expire, revoke, and can be bound to a nickname', () => {
  const env = makeEnv(4)
  let room = createRoom()
  room = must(apply(room, {
    type: 'adminCreateInvite',
    actor: account,
    invite: invite({ id: 'alice-only', codeHash: 'alice-hash', nickname: 'Alice', maxUses: 2 }),
  }, env))
  assert.equal(join(env, room, 'Bob', { inviteCodeHash: 'alice-hash' }).error?.code, 'invite-name-mismatch')
  room = must(join(env, room, 'Alice', { inviteCodeHash: 'alice-hash' }))
  assert.equal(room.invites[0]?.usedCount, 1)

  room = must(apply(room, {
    type: 'adminCreateInvite',
    actor: account,
    invite: invite({ id: 'expiring', codeHash: 'expiring-hash', expiresAt: env.now + 10 }),
  }, env))
  env.now += 20
  assert.equal(join(env, room, 'Carol', { inviteCodeHash: 'expiring-hash' }).error?.code, 'invite-expired')

  room = must(apply(room, {
    type: 'adminCreateInvite',
    actor: account,
    invite: invite({ id: 'revoked', codeHash: 'revoked-hash' }),
  }, env))
  room = must(apply(room, { type: 'adminRevokeInvite', actor: account, inviteId: 'revoked' }, env))
  assert.equal(join(env, room, 'Dave', { inviteCodeHash: 'revoked-hash' }).error?.code, 'invite-invalid')

  room = must(apply(room, { type: 'adminRevokeAllInvites', actor: account }, env))
  assert.ok(room.invites.every(candidate => candidate.revoked))
})

test('only the account can delete an invite, and deletion is permanent', () => {
  const env = makeEnv(6)
  let room = createRoom()
  room = must(apply(room, {
    type: 'adminCreateInvite',
    actor: account,
    invite: invite({ id: 'temporary', codeHash: 'temporary-hash' }),
  }, env))

  assert.equal(apply(room, { type: 'adminDeleteInvite', actor: tableKey, inviteId: 'temporary' }, env).error?.code, 'forbidden')
  assert.equal(apply(room, { type: 'adminDeleteInvite', actor: account, inviteId: 'missing' }, env).error?.code, 'invite-not-found')

  const version = room.version
  const next = must(apply(room, { type: 'adminDeleteInvite', actor: account, inviteId: 'temporary' }, env))
  assert.equal(next.invites.length, 0)
  assert.equal(next.version, version, 'invites are not table state')
  assert.equal(join(env, next, 'Alice', { inviteCodeHash: 'temporary-hash' }).error?.code, 'invite-invalid')
})

test('standing mid-hand folds the player and frees the seat after the hand', () => {
  const { env, room } = startTable(['Alice', 'Bob', 'Carol'])
  const hand = room.hand
  assert.ok(hand)
  const actorSeat = hand.actingSeat as number
  const leaver = room.players.find(player => player.seat !== actorSeat)
  assert.ok(leaver)

  let next = must(apply(room, { type: 'stand', playerId: leaver.id }, env))
  assert.equal(findPlayer(next, leaver.name).leaveAfterHand, true)
  assert.notEqual(findPlayer(next, leaver.name).seat, null)
  assert.equal(next.hand?.seats[leaver.seat as number]?.folded, true)

  next = playPassively(env, next)
  assert.equal(findPlayer(next, leaver.name).seat, null)
  assert.equal(findPlayer(next, leaver.name).leaveAfterHand, false)

  next = must(apply(next, { type: 'stand', playerId: findPlayer(next, 'Alice').id }, env))
  assert.equal(findPlayer(next, 'Alice').seat, null)
})

test('players can sit during a hand but are only dealt in from the next hand', () => {
  const { env, room } = startTable(['Alice', 'Bob'])
  const next = must(join(env, room, 'Carol'))
  assert.equal(findPlayer(next, 'Carol').seat, 2)
  assert.equal(next.phase, 'playing')
  assert.equal(next.hand?.seats[2]?.inHand, false)
  assert.equal(viewFor(next, findPlayer(next, 'Carol').id).canAct, false)
})

test('kicking removes a player immediately or after the current hand', () => {
  const { env, room } = startTable(['Alice', 'Bob', 'Carol'])
  const hand = room.hand
  assert.ok(hand)
  const actorSeat = hand.actingSeat as number
  const target = room.players.find(player => player.seat !== actorSeat && player.name !== 'Alice')
  assert.ok(target)

  let next = must(apply(room, { type: 'adminKick', actor: tableKey, playerId: target.id }, env))
  assert.equal(findPlayer(next, target.name).kicked, true)
  assert.equal(next.players.some(player => player.id === target.id), true)
  assert.equal(viewFor(next, null).players.some(player => player.id === target.id), false)
  next = playPassively(env, next)
  assert.equal(next.players.some(player => player.id === target.id), false)
  assert.equal(viewFor(next, null).game?.seats[target.seat as number]?.id, '')

  const alice = findPlayer(next, 'Alice')
  next = must(apply(next, { type: 'adminKick', actor: tableKey, playerId: alice.id }, env))
  assert.equal(next.players.some(player => player.id === alice.id), false)
})

test('pause blocks play, and forced actions unstick the table', () => {
  const { env, room } = startTable(['Alice', 'Bob', 'Carol'])
  let next = must(apply(room, { type: 'adminPause', actor: tableKey, paused: true }, env))
  const hand = next.hand
  assert.ok(hand)
  const actorSeat = hand.actingSeat as number
  const actor = hand.seats[actorSeat]
  assert.ok(actor)
  assert.equal(apply(next, {
    type: 'act',
    playerId: actor.id,
    handId: `${next.epoch}:${next.handNumber}`,
    version: next.version,
    action: 'fold',
  }, env).error?.code, 'paused')

  next = must(apply(next, { type: 'adminPause', actor: tableKey, paused: false }, env))
  next = must(apply(next, { type: 'disconnect', playerId: actor.id }, env))
  next = must(apply(next, { type: 'adminForceAction', actor: tableKey, playerId: actor.id, action: 'fold' }, env))
  assert.equal(next.hand?.seats[actorSeat]?.folded, true)
})

test('forced checks advance the street when a player can check', () => {
  const { env, room } = startTable(['Alice', 'Bob', 'Carol'])
  let next = room
  for (let guard = 0; guard < 20; guard += 1) {
    const hand = next.hand
    assert.ok(hand)
    const acting = hand.actingSeat
    if (acting === null) assert.fail('unexpected idle hand')
    const seat = hand.seats[acting]
    assert.ok(seat)
    const legal = legalActionsFor(hand, acting)
    if (legal.canCheck) {
      next = must(apply(next, { type: 'adminForceAction', actor: tableKey, playerId: seat.id, action: 'check' }, env))
      break
    }
    next = must(apply(next, {
      type: 'act',
      playerId: seat.id,
      handId: `${next.epoch}:${next.handNumber}`,
      version: next.version,
      action: 'call',
    }, env))
  }
  assert.equal(next.hand?.street, 'flop')
})

test('admin stack and blind changes validate their phase and ranges', () => {
  const env = makeEnv(5)
  let room = createRoom({ joinOpen: true })
  room = must(join(env, room, 'Alice'))
  room = must(join(env, room, 'Bob'))
  const alice = findPlayer(room, 'Alice')

  room = must(apply(room, { type: 'adminTopUp', actor: tableKey, playerId: alice.id, amount: 1_000 }, env))
  assert.equal(findPlayer(room, 'Alice').stack, DEFAULT_STARTING_STACK + 1_000)
  assert.equal(apply(room, { type: 'adminTopUp', actor: tableKey, playerId: alice.id, amount: -1 }, env).error?.code, 'invalid-amount')
  assert.equal(apply(room, { type: 'adminSetStack', actor: tableKey, playerId: alice.id, stack: -5 }, env).error?.code, 'invalid-amount')

  room = must(apply(room, { type: 'adminSetStack', actor: tableKey, playerId: alice.id, stack: 0 }, env))
  assert.equal(findPlayer(room, 'Alice').sittingOut, true)
  assert.equal(ready(env, room, alice.id).error?.code, 'no-chips')

  room = must(apply(room, { type: 'adminSetStack', actor: tableKey, playerId: alice.id, stack: DEFAULT_STARTING_STACK }, env))
  room = must(apply(room, { type: 'adminSetBlinds', actor: tableKey, smallBlind: 100, bigBlind: 200 }, env))
  assert.equal(room.settings.smallBlind, 100)
  assert.equal(room.settings.bigBlind, 200)
  assert.equal(apply(room, { type: 'adminSetBlinds', actor: tableKey, smallBlind: 300, bigBlind: 200 }, env).error?.code, 'invalid-blinds')
  room = must(apply(room, { type: 'adminSetStartingStack', actor: tableKey, startingStack: 12_345 }, env))
  assert.equal(room.settings.startingStack, 12_345)
  room = must(apply(room, { type: 'adminResetTable', actor: tableKey }, env))
  assert.ok(room.players.every(player => player.stack === 12_345))

  for (const player of room.players) room = must(ready(env, room, player.id))
  assert.equal(room.phase, 'playing')
  assert.equal(apply(room, { type: 'adminTopUp', actor: tableKey, playerId: alice.id, amount: 1 }, env).error?.code, 'hand-in-progress')
  assert.equal(apply(room, { type: 'adminSetBlinds', actor: tableKey, smallBlind: 25, bigBlind: 50 }, env).error?.code, 'hand-in-progress')
  assert.equal(apply(room, { type: 'adminSetStartingStack', actor: tableKey, startingStack: 1 }, env).error?.code, 'hand-in-progress')
})

test('actions reject stale versions and stale hand ids', () => {
  const { env, room } = startTable(['Alice', 'Bob'])
  const hand = room.hand
  assert.ok(hand)
  const acting = hand.actingSeat as number
  const player = hand.seats[acting]
  assert.ok(player)

  const staleVersion = apply(room, {
    type: 'act',
    playerId: player.id,
    handId: `${room.epoch}:${room.handNumber}`,
    version: room.version - 1,
    action: 'fold',
  }, env)
  assert.equal(staleVersion.error?.code, 'stale-version')

  const staleHand = apply(room, {
    type: 'act',
    playerId: player.id,
    handId: 'nope',
    version: room.version,
    action: 'fold',
  }, env)
  assert.equal(staleHand.error?.code, 'stale-hand')

  const notYourTurn = apply(room, {
    type: 'act',
    playerId: room.players.find(candidate => candidate.id !== player.id)?.id as string,
    handId: `${room.epoch}:${room.handNumber}`,
    version: room.version,
    action: 'fold',
  }, env)
  assert.equal(notYourTurn.error?.code, 'not-your-turn')
})

test('tables of every supported size deal, terminate, and conserve chips', () => {
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
  for (let count = 2; count <= MAX_SEATS; count += 1) {
    const { env, room } = startTable(names.slice(0, count), { seed: 50 + count })
    assert.equal(room.hand?.seats.filter(seat => seat.inHand).length, count, `${count} seats`)
    for (const seat of room.hand?.seats ?? []) {
      if (seat.inHand) assert.equal(seat.hole.length, 2)
    }
    const finished = playPassively(env, room)
    assert.equal(finished.phase, 'hand-over')
    assert.equal(totalChips(finished), count * DEFAULT_STARTING_STACK, `${count} seats`)
  }
})

test('a hand can be played to showdown with explicit legal raises', () => {
  const { env, room } = startTable(['Alice', 'Bob', 'Carol'])
  let next = room
  const hand = next.hand
  assert.ok(hand)
  const acting = hand.actingSeat as number
  const seat = hand.seats[acting]
  assert.ok(seat)
  const legal = legalActionsFor(hand, acting)
  const raiseTo = Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, legal.raiseTo))
  next = must(apply(next, {
    type: 'act',
    playerId: seat.id,
    handId: `${next.epoch}:${next.handNumber}`,
    version: next.version,
    action: 'raise',
    raiseTo,
  }, env))
  assert.equal(next.hand?.seats[acting]?.streetBet, raiseTo)
  assert.equal(next.hand?.currentBet, raiseTo)
  assert.equal(apply(next, {
    type: 'act',
    playerId: next.hand?.seats[next.hand.actingSeat as number]?.id as string,
    handId: `${next.epoch}:${next.handNumber}`,
    version: next.version,
    action: 'raise',
    raiseTo: -1,
  }, env).error?.code, 'illegal-raise')
})

test('presence changes do not invalidate an in-flight action', () => {
  const { env, room } = startTable(['Alice', 'Bob', 'Carol'])
  const carol = findPlayer(room, 'Carol')
  const version = room.version
  let next = must(join(env, room, 'Dave'))
  assert.equal(next.version, version, 'joining mid-hand must not bump the table version')
  next = must(apply(next, { type: 'disconnect', playerId: carol.id }, env))
  assert.equal(next.version, version, 'disconnect must not bump the table version')
  next = must(apply(next, { type: 'reconnect', playerId: carol.id }, env))
  assert.equal(next.version, version, 'reconnect must not bump the table version')
  next = must(apply(next, { type: 'authenticate', playerId: carol.id, tokenHash: 'rotated' }, env))
  assert.equal(next.version, version, 'token rotation must not bump the table version')
  next = must(apply(next, { type: 'adminSetJoinOpen', actor: account, joinOpen: false }, env))
  assert.equal(next.settings.joinOpen, false)
  assert.equal(next.version, version, 'the join policy is not table state')

  const hand = next.hand
  assert.ok(hand)
  const acting = hand.actingSeat as number
  const seat = hand.seats[acting]
  assert.ok(seat)
  const legal = legalActionsFor(hand, acting)
  const action = legal.canCheck ? 'check' : 'call'
  const result = apply(next, {
    type: 'act',
    playerId: seat.id,
    handId: `${next.epoch}:${next.handNumber}`,
    version,
    action,
  }, env)
  assert.equal(result.error, null, result.error?.message)
  assert.equal(result.room.version, version + 1, 'an action bumps the table version')
})

test('default settings match the engine blinds and starting stack', () => {
  const room = createRoom()
  assert.equal(room.settings.smallBlind, SMALL_BLIND)
  assert.equal(room.settings.bigBlind, BIG_BLIND)
  assert.equal(room.settings.startingStack, DEFAULT_STARTING_STACK)
  assert.equal(room.settings.joinOpen, false)
  assert.equal(room.phase, 'waiting')
  assert.equal(room.epoch, 1)
})

test('players keep their own cosmetics and an admin override only fills the pinned slots', () => {
  const env = makeEnv(9)
  let room = createRoom({ joinOpen: true })
  room = must(join(env, room, 'Ada'))
  room = must(join(env, room, 'Bo'))
  const ada = findPlayer(room, 'Ada')
  const bo = findPlayer(room, 'Bo')

  const mine = {
    back: 'plasma',
    faces: { spades: 'witcher-3', hearts: '', clubs: '', diamonds: 'rust' },
  }
  const version = room.version
  room = must(apply(room, { type: 'setCosmetics', playerId: ada.id, cosmetics: mine }, env))
  assert.equal(room.version, version, 'appearance must not invalidate an in-flight action')
  assert.deepEqual(viewFor(room, ada.id).cosmetics, mine)
  assert.deepEqual(viewFor(room, bo.id).cosmetics, {
    back: '',
    faces: { spades: '', hearts: '', clubs: '', diamonds: '' },
  })

  const invalid = apply(room, {
    type: 'setCosmetics',
    playerId: ada.id,
    cosmetics: { ...mine, back: 'Not An Id!' },
  }, env)
  assert.equal(invalid.error?.code, 'invalid-cosmetics')
  assert.equal(invalid.room, room)

  const pinned = { back: 'zodiac', faces: { spades: '', hearts: 'among-us', clubs: '', diamonds: '' } }
  room = must(apply(room, {
    type: 'adminSetTableCosmetics',
    actor: { kind: 'tableKey', label: 'p1' },
    cosmetics: pinned,
  }, env))
  const adaView = viewFor(room, ada.id)
  assert.equal(adaView.cosmetics.back, 'zodiac', 'the pinned back wins')
  assert.equal(adaView.cosmetics.faces.hearts, mine.faces.hearts, 'face cards stay personal')
  assert.equal(adaView.cosmetics.faces.spades, 'witcher-3')
  assert.equal(viewFor(room, bo.id).cosmetics.back, 'zodiac')
  assert.equal(viewFor(room, bo.id).cosmetics.faces.hearts, '')

  // Face pins from an older room are dropped, not applied.
  assert.deepEqual(adaView.cosmeticsOverride?.faces, { spades: '', hearts: '', clubs: '', diamonds: '' })

  room = must(apply(room, {
    type: 'adminSetTableCosmetics',
    actor: { kind: 'tableKey', label: 'p1' },
    cosmetics: null,
  }, env))
  assert.equal(viewFor(room, ada.id).cosmeticsOverride, null)
  assert.deepEqual(viewFor(room, ada.id).cosmetics, mine)
  assert.equal(viewFor(room, bo.id).cosmetics.back, '')
  assert.equal(viewFor(room, bo.id).cosmetics.faces.hearts, '')
})
