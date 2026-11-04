import {
  actAs,
  createGame,
  forceFold,
  legalActionsFor,
  MAX_SEATS,
  type GameState,
  type SeatInit,
} from '../engine/index.ts'
import type { AdminActor, Cosmetics, InviteRecord, RoomCommand } from '../protocol/index.ts'
import {
  advanceHand,
  canStart,
  eligibleSeats,
  firstEmptySeat,
  handIdOf,
  normalizeName,
  occupiedSeats,
  pickDealer,
  playerAtSeat,
  playerById,
  sameName,
} from './selectors.ts'
import { EMPTY_COSMETICS, sameCosmetics } from './types.ts'
import type {
  ApplyResult,
  PlayerRecord,
  RoomContext,
  RoomError,
  RoomEvent,
  RoomState,
} from './types.ts'

type Outcome = { room: RoomState; events: RoomEvent[] } | { error: RoomError }

function fail(code: string, message: string): Outcome {
  return { error: { code, message } }
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Presence and lobby bookkeeping (connect/disconnect/token rotation, joining,
 * seat moves, stacks between hands) must not invalidate an in-flight action.
 * `version` therefore tracks only the state an action depends on: the current
 * hand, the phase, the pause flag and the readiness round.
 */
export function didTableStateChange(previous: RoomState, next: RoomState): boolean {
  if (previous.epoch !== next.epoch) return true
  if (previous.hand !== next.hand) return true
  if (previous.phase !== next.phase) return true
  if (previous.paused !== next.paused) return true
  if (!sameList(previous.ready, next.ready)) return true
  return false
}

export function apply(room: RoomState, command: RoomCommand, ctx: RoomContext): ApplyResult {
  const outcome = dispatch(room, command, ctx)
  if ('error' in outcome) return { room, events: [], error: outcome.error }
  if (outcome.room === room) return { room, events: outcome.events, error: null }
  const version = didTableStateChange(room, outcome.room) ? room.version + 1 : room.version
  return { room: { ...outcome.room, version }, events: outcome.events, error: null }
}

function dispatch(room: RoomState, command: RoomCommand, ctx: RoomContext): Outcome {
  switch (command.type) {
    case 'join': return handleJoin(room, command, ctx)
    case 'authenticate': return handleAuthenticate(room, command, ctx)
    case 'reconnect': return handleReconnect(room, command, ctx)
    case 'disconnect': return handleDisconnect(room, command, ctx)
    case 'sit': return handleSit(room, command)
    case 'stand': return handleStand(room, command, ctx)
    case 'ready': return handleReady(room, command, ctx)
    case 'act': return handleAct(room, command, ctx)
    case 'setCosmetics': return handleSetCosmetics(room, command)
    case 'adminRedeal': return handleAdminRedeal(room, command, ctx)
    case 'adminResetTable': return handleAdminResetTable(room, command)
    case 'adminResetRoom': return handleAdminResetRoom(room, command)
    case 'adminTopUp': return handleAdminTopUp(room, command)
    case 'adminSetStack': return handleAdminSetStack(room, command)
    case 'adminKick': return handleAdminKick(room, command, ctx)
    case 'adminPause': return handleAdminPause(room, command)
    case 'adminForceAction': return handleAdminForceAction(room, command, ctx)
    case 'adminSetBlinds': return handleAdminSetBlinds(room, command)
    case 'adminSetStartingStack': return handleAdminSetStartingStack(room, command)
    case 'adminCreateInvite': return handleAdminCreateInvite(room, command, ctx)
    case 'adminRevokeInvite': return handleAdminRevokeInvite(room, command)
    case 'adminDeleteInvite': return handleAdminDeleteInvite(room, command)
    case 'adminRevokeAllInvites': return handleAdminRevokeAllInvites(room, command)
    case 'adminSetJoinOpen': return handleAdminSetJoinOpen(room, command)
    case 'adminSetTableCosmetics': return handleAdminSetTableCosmetics(room, command)
  }
}

function handleJoin(room: RoomState, command: Extract<RoomCommand, { type: 'join' }>, ctx: RoomContext): Outcome {
  const name = normalizeName(command.name)
  if (name.length === 0 || [...name].length > 24) return fail('invalid-name', 'Nickname must be 1-24 characters')
  if (/[\u0000-\u001f\u007f]/.test(name)) return fail('invalid-name', 'Nickname contains control characters')
  if (command.pinHash.length === 0 || command.tokenHash.length === 0) return fail('invalid-credentials', 'Missing credentials')
  if (room.players.some(player => sameName(player.name, name))) return fail('name-taken', 'Nickname is already taken')

  let invites = room.invites
  if (!room.settings.joinOpen) {
    if (command.inviteCodeHash === null) return fail('invite-required', 'An invite is required to join')
    const invite = room.invites.find(candidate => candidate.codeHash === command.inviteCodeHash)
    if (invite === undefined || invite.revoked) return fail('invite-invalid', 'Invite is invalid or revoked')
    if (invite.expiresAt !== null && invite.expiresAt <= ctx.now) return fail('invite-expired', 'Invite has expired')
    if (invite.usedCount >= invite.maxUses) return fail('invite-used', 'Invite has already been used')
    if (invite.nickname !== null && !sameName(invite.nickname, name)) return fail('invite-name-mismatch', 'Invite is bound to another nickname')
    invites = room.invites.map(candidate => candidate.id === invite.id
      ? { ...candidate, usedCount: candidate.usedCount + 1 }
      : candidate)
  }

  const requested = command.seat
  if (requested !== null && (!Number.isInteger(requested) || requested < 0 || requested >= MAX_SEATS)) {
    return fail('invalid-seat', 'Seat is out of range')
  }
  const seat = requested ?? firstEmptySeat(room)
  if (seat === null) return fail('room-full', 'No seats are available')
  if (occupiedSeats(room).has(seat)) return fail('seat-taken', 'Seat is already occupied')

  const player: PlayerRecord = {
    id: ctx.newId(),
    name,
    pinHash: command.pinHash,
    tokenHash: command.tokenHash,
    seat,
    stack: room.settings.startingStack,
    connected: true,
    sittingOut: room.settings.startingStack <= 0,
    leaveAfterHand: false,
    kicked: false,
    cosmetics: EMPTY_COSMETICS,
    createdAt: ctx.now,
    lastSeenAt: ctx.now,
  }
  return {
    room: { ...room, players: [...room.players, player], invites },
    events: [{ type: 'playerJoined', playerId: player.id, name, seat }],
  }
}

function handleAuthenticate(room: RoomState, command: Extract<RoomCommand, { type: 'authenticate' }>, ctx: RoomContext): Outcome {
  const player = playerById(room, command.playerId)
  if (player === undefined || player.kicked) return fail('unknown-player', 'Player not found')
  if (command.tokenHash.length === 0) return fail('invalid-credentials', 'Missing token')
  const players = room.players.map(candidate => candidate.id === player.id
    ? { ...candidate, tokenHash: command.tokenHash, connected: true, lastSeenAt: ctx.now }
    : candidate)
  return { room: { ...room, players }, events: [] }
}

function handleReconnect(room: RoomState, command: Extract<RoomCommand, { type: 'reconnect' }>, ctx: RoomContext): Outcome {
  const player = playerById(room, command.playerId)
  if (player === undefined || player.kicked) return fail('unknown-player', 'Player not found')
  if (player.connected) return { room, events: [] }
  const players = room.players.map(candidate => candidate.id === player.id
    ? { ...candidate, connected: true, lastSeenAt: ctx.now }
    : candidate)
  return { room: { ...room, players }, events: [] }
}

function handleDisconnect(room: RoomState, command: Extract<RoomCommand, { type: 'disconnect' }>, ctx: RoomContext): Outcome {
  const player = playerById(room, command.playerId)
  if (player === undefined) return { room, events: [] }
  const players = room.players.map(candidate => candidate.id === player.id
    ? { ...candidate, connected: false, lastSeenAt: ctx.now }
    : candidate)
  return {
    room: { ...room, players, ready: room.ready.filter(id => id !== player.id) },
    events: [],
  }
}

function handleSit(room: RoomState, command: Extract<RoomCommand, { type: 'sit' }>): Outcome {
  const player = playerById(room, command.playerId)
  if (player === undefined || player.kicked) return fail('unknown-player', 'Player not found')
  if (!Number.isInteger(command.seat) || command.seat < 0 || command.seat >= MAX_SEATS) {
    return fail('invalid-seat', 'Seat is out of range')
  }
  if (player.seat === command.seat) return { room, events: [] }
  if (room.phase === 'playing' && player.seat !== null) return fail('cannot-move-seat', 'Cannot change seats during a hand')
  const occupant = playerAtSeat(room, command.seat)
  if (occupant !== undefined && occupant.id !== player.id) return fail('seat-taken', 'Seat is already occupied')
  const players = room.players.map(candidate => candidate.id === player.id
    ? { ...candidate, seat: command.seat, sittingOut: candidate.stack <= 0 }
    : candidate)
  return {
    room: { ...room, players },
    events: [{ type: 'seatChanged', playerId: player.id, name: player.name, seat: command.seat }],
  }
}

function handleStand(room: RoomState, command: Extract<RoomCommand, { type: 'stand' }>, ctx: RoomContext): Outcome {
  const player = playerById(room, command.playerId)
  if (player === undefined || player.kicked) return fail('unknown-player', 'Player not found')
  if (player.seat === null) return { room, events: [] }

  const hand = room.hand
  const handSeat = hand?.seats[player.seat]
  const inCurrentHand = room.phase === 'playing'
    && hand !== null
    && hand.street !== 'hand-over'
    && handSeat !== undefined
    && handSeat.id === player.id
    && handSeat.inHand

  if (inCurrentHand && hand !== null && player.seat !== null) {
    const folded = advanceHand(forceFold(hand, player.seat))
    const players = room.players.map(candidate => candidate.id === player.id
      ? { ...candidate, leaveAfterHand: true, lastSeenAt: ctx.now }
      : candidate)
    const next: RoomState = {
      ...room,
      players,
      hand: folded,
      ready: room.ready.filter(id => id !== player.id),
    }
    if (folded.street === 'hand-over') return finishHand(next, folded, ctx)
    return { room: next, events: [{ type: 'notice', message: `${player.name} will leave after this hand` }] }
  }

  const players = room.players.map(candidate => candidate.id === player.id
    ? { ...candidate, seat: null, leaveAfterHand: false, lastSeenAt: ctx.now }
    : candidate)
  return {
    room: { ...room, players, ready: room.ready.filter(id => id !== player.id) },
    events: [{ type: 'seatChanged', playerId: player.id, name: player.name, seat: null }],
  }
}

function handleReady(room: RoomState, command: Extract<RoomCommand, { type: 'ready' }>, ctx: RoomContext): Outcome {
  if (room.phase === 'playing') return fail('hand-in-progress', 'A hand is in progress')
  if (room.paused) return fail('paused', 'The table is paused')
  const player = playerById(room, command.playerId)
  if (player === undefined || player.kicked) return fail('unknown-player', 'Player not found')
  if (player.seat === null) return fail('not-seated', 'Sit down first')
  if (!player.connected) return fail('offline', 'Player is offline')
  if (player.stack <= 0) return fail('no-chips', 'Player has no chips')
  if (player.sittingOut) return fail('sitting-out', 'Player is sitting out')
  if (player.leaveAfterHand) return fail('leaving', 'Player is leaving')
  if (room.ready.includes(player.id)) return { room, events: [] }

  const next: RoomState = { ...room, ready: [...room.ready, player.id] }
  if (!canStart(next)) return { room: next, events: [] }
  return dealHand(next, ctx, 'next')
}

function handleAct(room: RoomState, command: Extract<RoomCommand, { type: 'act' }>, ctx: RoomContext): Outcome {
  const hand = room.hand
  if (room.phase !== 'playing' || hand === null || hand.street === 'hand-over') return fail('no-hand', 'No hand is in progress')
  if (room.paused) return fail('paused', 'The table is paused')
  if (command.version !== room.version) return fail('stale-version', 'State is out of date')
  if (command.handId !== handIdOf(room)) return fail('stale-hand', 'Hand is out of date')
  const player = playerById(room, command.playerId)
  if (player === undefined || player.kicked) return fail('unknown-player', 'Player not found')
  if (player.seat === null) return fail('not-seated', 'Player is not seated')
  if (hand.actingSeat !== player.seat) return fail('not-your-turn', 'It is not your turn')

  const legal = legalActionsFor(hand, player.seat)
  if (command.action === 'check' && !legal.canCheck) return fail('illegal-action', 'Cannot check')
  if (command.action === 'call' && !legal.canCall) return fail('illegal-action', 'Cannot call')
  if (command.action === 'all-in' && !legal.canAllIn) return fail('illegal-action', 'Cannot move all-in')
  if (command.action === 'raise') {
    if (!legal.canRaise) return fail('illegal-action', 'Cannot raise')
    const target = command.raiseTo
    if (target !== undefined && (!Number.isInteger(target) || target < legal.minRaiseTo || target > legal.maxRaiseTo)) {
      return fail('illegal-raise', 'Raise amount is out of range')
    }
  }

  const acted = actAs(hand, player.seat, command.action, command.raiseTo)
  if (acted === hand) return fail('illegal-action', 'Action was rejected')
  const settled = advanceHand(acted)
  const next: RoomState = { ...room, hand: settled }
  if (settled.street === 'hand-over') return finishHand(next, settled, ctx)
  return { room: next, events: [] }
}

function dealHand(room: RoomState, ctx: RoomContext, dealerMode: 'next' | 'same'): Outcome {
  const eligible = eligibleSeats(room)
  if (eligible.length < 2) return fail('not-enough-players', 'At least two players are required')

  const previous = room.hand?.dealer ?? room.dealer
  const dealer = dealerMode === 'same'
    ? (previous !== null && eligible.includes(previous) ? previous : pickDealer(room, eligible))
    : pickDealer(room, eligible)
  const handNumber = dealerMode === 'same' ? Math.max(1, room.handNumber) : room.handNumber + 1

  const seats: SeatInit[] = []
  for (let index = 0; index < MAX_SEATS; index += 1) {
    const player = playerAtSeat(room, index)
    seats.push({
      id: player?.id ?? `empty-${index}`,
      name: player?.name ?? '',
      stack: player?.stack ?? 0,
      inHand: player !== undefined && eligible.includes(index),
    })
  }

  let hand: GameState
  try {
    hand = createGame({
      seats,
      smallBlind: room.settings.smallBlind,
      bigBlind: room.settings.bigBlind,
      dealer,
      handNumber,
      random: ctx.random,
    })
  } catch (error) {
    return fail('deal-failed', error instanceof Error ? error.message : 'Could not deal a hand')
  }
  hand = advanceHand(hand)

  const next: RoomState = {
    ...room,
    hand,
    phase: 'playing',
    ready: [],
    dealer: hand.dealer,
    handNumber: hand.handNumber,
  }
  const events: RoomEvent[] = [{
    type: 'handStarted',
    handNumber: hand.handNumber,
    dealer: hand.dealer,
    handId: `${room.epoch}:${hand.handNumber}`,
  }]
  if (hand.street === 'hand-over') {
    const finished = finishHand(next, hand, ctx)
    if ('error' in finished) return finished
    return { room: finished.room, events: [...events, ...finished.events] }
  }
  return { room: next, events }
}

function finishHand(room: RoomState, hand: GameState, ctx: RoomContext): Outcome {
  const events: RoomEvent[] = [{ type: 'handEnded', handNumber: hand.handNumber, winners: hand.winners }]
  const players: PlayerRecord[] = []
  for (const player of room.players) {
    const handSeat = player.seat === null ? undefined : hand.seats[player.seat]
    const ownsSeat = handSeat !== undefined && handSeat.id === player.id
    const stack = ownsSeat ? handSeat.stack : player.stack
    if (player.kicked) {
      events.push({ type: 'playerRemoved', playerId: player.id, name: player.name, reason: 'kicked' })
      continue
    }
    if (player.leaveAfterHand) {
      players.push({ ...player, seat: null, stack, leaveAfterHand: false, lastSeenAt: ctx.now })
      events.push({ type: 'seatChanged', playerId: player.id, name: player.name, seat: null })
      continue
    }
    players.push({
      ...player,
      stack,
      sittingOut: stack <= 0 ? true : player.sittingOut,
      lastSeenAt: ctx.now,
    })
  }
  return {
    room: { ...room, players, hand, phase: 'hand-over', ready: [] },
    events,
  }
}

function requireActor(actor: AdminActor, accountOnly = false): RoomError | null {
  if (accountOnly && actor.kind !== 'account') {
    return { code: 'forbidden', message: 'Only the administrator account can do that' }
  }
  return null
}

function handleAdminRedeal(room: RoomState, command: Extract<RoomCommand, { type: 'adminRedeal' }>, ctx: RoomContext): Outcome {
  const denied = requireActor(command.actor)
  if (denied !== null) return { error: denied }
  const hand = room.hand
  if (room.phase !== 'playing' || hand === null || hand.street === 'hand-over') {
    return fail('no-hand', 'No hand is in progress')
  }
  const refunded: RoomState = {
    ...room,
    players: room.players.map(player => {
      if (player.seat === null) return player
      const handSeat = hand.seats[player.seat]
      if (handSeat === undefined || handSeat.id !== player.id) return player
      return { ...player, stack: handSeat.stack + handSeat.committed }
    }),
  }
  const players = refunded.players.flatMap(player => {
    if (player.kicked) return []
    if (player.leaveAfterHand) return [{ ...player, seat: null, leaveAfterHand: false }]
    return [player]
  })
  return dealHand({ ...refunded, players, ready: [] }, ctx, 'same')
}

function handleAdminResetTable(room: RoomState, command: Extract<RoomCommand, { type: 'adminResetTable' }>): Outcome {
  const denied = requireActor(command.actor)
  if (denied !== null) return { error: denied }
  const stack = room.settings.startingStack
  const players = room.players
    .filter(player => !player.kicked)
    .map(player => ({
      ...player,
      stack,
      sittingOut: stack <= 0,
      leaveAfterHand: false,
    }))
  return {
    room: {
      ...room,
      players,
      hand: null,
      phase: 'waiting',
      paused: false,
      ready: [],
      dealer: null,
      handNumber: 0,
    },
    events: [{ type: 'notice', message: 'Table reset; everyone is back to the starting stack' }],
  }
}

function handleAdminResetRoom(room: RoomState, command: Extract<RoomCommand, { type: 'adminResetRoom' }>): Outcome {
  const denied = requireActor(command.actor, true)
  if (denied !== null) return { error: denied }
  const epoch = room.epoch + 1
  return {
    room: {
      ...room,
      epoch,
      players: [],
      hand: null,
      phase: 'waiting',
      paused: false,
      ready: [],
      dealer: null,
      handNumber: 0,
      invites: [],
    },
    events: [{ type: 'roomReset', epoch }],
  }
}

function handleAdminTopUp(room: RoomState, command: Extract<RoomCommand, { type: 'adminTopUp' }>): Outcome {
  const denied = requireActor(command.actor)
  if (denied !== null) return { error: denied }
  if (room.phase === 'playing') return fail('hand-in-progress', 'Top up between hands')
  if (!Number.isInteger(command.amount) || command.amount <= 0) return fail('invalid-amount', 'Amount must be a positive integer')
  const player = playerById(room, command.playerId)
  if (player === undefined || player.kicked) return fail('unknown-player', 'Player not found')
  const players = room.players.map(candidate => candidate.id === player.id
    ? { ...candidate, stack: candidate.stack + command.amount, sittingOut: false }
    : candidate)
  return {
    room: { ...room, players },
    events: [{ type: 'notice', message: `${player.name} was topped up by ${command.amount}` }],
  }
}

function handleAdminSetStack(room: RoomState, command: Extract<RoomCommand, { type: 'adminSetStack' }>): Outcome {
  const denied = requireActor(command.actor)
  if (denied !== null) return { error: denied }
  if (room.phase === 'playing') return fail('hand-in-progress', 'Change stacks between hands')
  if (!Number.isInteger(command.stack) || command.stack < 0) return fail('invalid-amount', 'Stack must be a non-negative integer')
  const player = playerById(room, command.playerId)
  if (player === undefined || player.kicked) return fail('unknown-player', 'Player not found')
  const players = room.players.map(candidate => candidate.id === player.id
    ? { ...candidate, stack: command.stack, sittingOut: command.stack <= 0 }
    : candidate)
  return {
    room: { ...room, players },
    events: [{ type: 'notice', message: `${player.name} now has ${command.stack}` }],
  }
}

function handleAdminKick(room: RoomState, command: Extract<RoomCommand, { type: 'adminKick' }>, ctx: RoomContext): Outcome {
  const denied = requireActor(command.actor)
  if (denied !== null) return { error: denied }
  const player = playerById(room, command.playerId)
  if (player === undefined) return { room, events: [] }
  const hand = room.hand
  const handSeat = player.seat === null ? undefined : hand?.seats[player.seat]
  const inCurrentHand = room.phase === 'playing'
    && hand !== null
    && hand.street !== 'hand-over'
    && handSeat !== undefined
    && handSeat.id === player.id
    && handSeat.inHand

  if (inCurrentHand && hand !== null && player.seat !== null) {
    const folded = advanceHand(forceFold(hand, player.seat))
    const players = room.players.map(candidate => candidate.id === player.id
      ? { ...candidate, kicked: true }
      : candidate)
    const next: RoomState = {
      ...room,
      players,
      hand: folded,
      ready: room.ready.filter(id => id !== player.id),
    }
    if (folded.street === 'hand-over') return finishHand(next, folded, ctx)
    return { room: next, events: [{ type: 'notice', message: `${player.name} will be removed after this hand` }] }
  }

  return {
    room: {
      ...room,
      players: room.players.filter(candidate => candidate.id !== player.id),
      ready: room.ready.filter(id => id !== player.id),
    },
    events: [{ type: 'playerRemoved', playerId: player.id, name: player.name, reason: 'kicked' }],
  }
}

function handleAdminPause(room: RoomState, command: Extract<RoomCommand, { type: 'adminPause' }>): Outcome {
  const denied = requireActor(command.actor)
  if (denied !== null) return { error: denied }
  if (room.paused === command.paused) return { room, events: [] }
  return {
    room: { ...room, paused: command.paused },
    events: [{ type: 'notice', message: command.paused ? 'Table paused' : 'Table resumed' }],
  }
}

function handleAdminForceAction(room: RoomState, command: Extract<RoomCommand, { type: 'adminForceAction' }>, ctx: RoomContext): Outcome {
  const denied = requireActor(command.actor)
  if (denied !== null) return { error: denied }
  const hand = room.hand
  if (room.phase !== 'playing' || hand === null || hand.street === 'hand-over') return fail('no-hand', 'No hand is in progress')
  const player = playerById(room, command.playerId)
  if (player === undefined || player.kicked) return fail('unknown-player', 'Player not found')
  if (player.seat === null) return fail('not-seated', 'Player is not seated')
  const seat = player.seat
  const ownsSeat = hand.seats[seat]?.id === player.id
  if (!ownsSeat) return fail('not-seated', 'Player is not in this hand')

  let settled: GameState
  if (command.action === 'fold') {
    settled = advanceHand(forceFold(hand, seat))
  } else {
    if (hand.actingSeat !== seat) return fail('not-your-turn', 'It is not their turn')
    if (!legalActionsFor(hand, seat).canCheck) return fail('cannot-check', 'They cannot check')
    settled = advanceHand(actAs(hand, seat, 'check'))
  }
  const next: RoomState = { ...room, hand: settled }
  if (settled.street === 'hand-over') return finishHand(next, settled, ctx)
  return { room: next, events: [] }
}

function handleAdminSetBlinds(room: RoomState, command: Extract<RoomCommand, { type: 'adminSetBlinds' }>): Outcome {
  const denied = requireActor(command.actor)
  if (denied !== null) return { error: denied }
  if (room.phase === 'playing') return fail('hand-in-progress', 'Change blinds between hands')
  if (!Number.isInteger(command.smallBlind) || !Number.isInteger(command.bigBlind) || command.smallBlind <= 0) {
    return fail('invalid-blinds', 'Blinds must be positive integers')
  }
  if (command.smallBlind >= command.bigBlind) return fail('invalid-blinds', 'Small blind must be below the big blind')
  return {
    room: { ...room, settings: { ...room.settings, smallBlind: command.smallBlind, bigBlind: command.bigBlind } },
    events: [{ type: 'notice', message: `Blinds set to ${command.smallBlind}/${command.bigBlind}` }],
  }
}

function handleAdminSetStartingStack(room: RoomState, command: Extract<RoomCommand, { type: 'adminSetStartingStack' }>): Outcome {
  const denied = requireActor(command.actor)
  if (denied !== null) return { error: denied }
  if (room.phase === 'playing') return fail('hand-in-progress', 'Change the starting stack between hands')
  if (!Number.isInteger(command.startingStack) || command.startingStack <= 0) {
    return fail('invalid-stack', 'Starting stack must be a positive integer')
  }
  return {
    room: { ...room, settings: { ...room.settings, startingStack: command.startingStack } },
    events: [{ type: 'notice', message: `Starting stack set to ${command.startingStack}` }],
  }
}

function handleAdminCreateInvite(room: RoomState, command: Extract<RoomCommand, { type: 'adminCreateInvite' }>, ctx: RoomContext): Outcome {
  const denied = requireActor(command.actor, true)
  if (denied !== null) return { error: denied }
  const invite: InviteRecord = command.invite
  if (invite.codeHash.length === 0) return fail('invalid-invite', 'Invite hash is required')
  if (!Number.isInteger(invite.maxUses) || invite.maxUses < 1) return fail('invalid-invite', 'Invite needs at least one use')
  if (!Number.isInteger(invite.usedCount) || invite.usedCount < 0 || invite.usedCount > invite.maxUses) {
    return fail('invalid-invite', 'Invite usage is invalid')
  }
  if (invite.expiresAt !== null && invite.expiresAt <= ctx.now) return fail('invalid-invite', 'Invite expiry is in the past')
  if (room.invites.some(candidate => candidate.id === invite.id || candidate.codeHash === invite.codeHash)) {
    return fail('invite-exists', 'Invite already exists')
  }
  return { room: { ...room, invites: [...room.invites, invite] }, events: [] }
}

function handleAdminRevokeInvite(room: RoomState, command: Extract<RoomCommand, { type: 'adminRevokeInvite' }>): Outcome {
  const denied = requireActor(command.actor, true)
  if (denied !== null) return { error: denied }
  if (!room.invites.some(invite => invite.id === command.inviteId)) return fail('invite-not-found', 'Invite not found')
  return {
    room: {
      ...room,
      invites: room.invites.map(invite => invite.id === command.inviteId ? { ...invite, revoked: true } : invite),
    },
    events: [],
  }
}

/** Permanent removal. Unlike revoke, the invite disappears from the room; the audit log keeps the delete event. */
function handleAdminDeleteInvite(room: RoomState, command: Extract<RoomCommand, { type: 'adminDeleteInvite' }>): Outcome {
  const denied = requireActor(command.actor, true)
  if (denied !== null) return { error: denied }
  if (!room.invites.some(invite => invite.id === command.inviteId)) return fail('invite-not-found', 'Invite not found')
  return {
    room: { ...room, invites: room.invites.filter(invite => invite.id !== command.inviteId) },
    events: [],
  }
}

function handleAdminRevokeAllInvites(room: RoomState, command: Extract<RoomCommand, { type: 'adminRevokeAllInvites' }>): Outcome {
  const denied = requireActor(command.actor, true)
  if (denied !== null) return { error: denied }
  return {
    room: { ...room, invites: room.invites.map(invite => ({ ...invite, revoked: true })) },
    events: [{ type: 'notice', message: 'All invites revoked' }],
  }
}

function handleAdminSetJoinOpen(room: RoomState, command: Extract<RoomCommand, { type: 'adminSetJoinOpen' }>): Outcome {
  const denied = requireActor(command.actor, true)
  if (denied !== null) return { error: denied }
  if (room.settings.joinOpen === command.joinOpen) return { room, events: [] }
  return {
    room: { ...room, settings: { ...room.settings, joinOpen: command.joinOpen } },
    events: [{ type: 'notice', message: command.joinOpen ? 'Room is open for anyone' : 'Room requires an invite' }],
  }
}

const ART_ID = /^[a-z0-9-]{0,40}$/

function validCosmetics(cosmetics: Cosmetics): boolean {
  const ids = [
    cosmetics.back,
    cosmetics.faces.spades,
    cosmetics.faces.hearts,
    cosmetics.faces.clubs,
    cosmetics.faces.diamonds,
  ]
  return ids.every(id => ART_ID.test(id))
}

/**
 * Appearance is per player and purely presentational, so it is accepted in any
 * phase and never invalidates an in-flight action (it does not bump `version`).
 */
function handleSetCosmetics(room: RoomState, command: Extract<RoomCommand, { type: 'setCosmetics' }>): Outcome {
  if (!validCosmetics(command.cosmetics)) return fail('invalid-cosmetics', 'Cosmetics id is invalid')
  const player = playerById(room, command.playerId)
  if (player === undefined || player.kicked) return fail('unknown-player', 'Player not found')
  if (sameCosmetics(player.cosmetics, command.cosmetics)) return { room, events: [] }
  const players = room.players.map(candidate => candidate.id === player.id
    ? { ...candidate, cosmetics: command.cosmetics }
    : candidate)
  return { room: { ...room, players }, events: [] }
}

/** Table-wide override; an empty field keeps each player's own choice for that slot. */
function handleAdminSetTableCosmetics(room: RoomState, command: Extract<RoomCommand, { type: 'adminSetTableCosmetics' }>): Outcome {
  const denied = requireActor(command.actor)
  if (denied !== null) return { error: denied }
  const next = command.cosmetics
  if (next !== null && !validCosmetics(next)) return fail('invalid-cosmetics', 'Cosmetics id is invalid')
  const current = room.tableCosmetics
  if (current === null && next === null) return { room, events: [] }
  if (current !== null && next !== null && sameCosmetics(current, next)) return { room, events: [] }
  return { room: { ...room, tableCosmetics: next }, events: [] }
}
