import assert from 'node:assert/strict'
import test from 'node:test'
import {
  actAs,
  advanceStreet,
  BIG_BLIND,
  blindSeatIndices,
  createGame,
  DEFAULT_STARTING_STACK,
  formatTokenAmount,
  forceFold,
  legalActionsFor,
  potOf,
  SMALL_BLIND,
  type GameState,
  type SeatInit,
} from '../src/engine/index.ts'
import { createDeck, shuffle } from '../src/engine/poker.ts'

function seeded(seed = 1): () => number {
  let value = seed >>> 0
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0
    return value / 0x100000000
  }
}

function makeSeats(count: number, stack = DEFAULT_STARTING_STACK): SeatInit[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index}`,
    name: `P${index}`,
    stack,
    inHand: true,
  }))
}

function totalTokens(state: GameState): number {
  return state.seats.reduce((sum, seat) => sum + seat.stack, 0) + (state.street === 'hand-over' ? 0 : potOf(state))
}

function playToEnd(state: GameState, limit = 1_000): GameState {
  let next = state
  for (let guard = 0; guard < limit && next.street !== 'hand-over'; guard += 1) {
    if (next.actingSeat === null) {
      const advanced = advanceStreet(next)
      assert.notStrictEqual(advanced, next, 'advanceStreet must make progress')
      next = advanced
      continue
    }
    const acting = next.actingSeat
    const legal = legalActionsFor(next, acting)
    next = actAs(next, acting, legal.canCheck ? 'check' : 'call')
  }
  assert.equal(next.street, 'hand-over', 'hand must terminate within the action guard')
  return next
}

function advanceToSeat(state: GameState, seat: number, limit = 100): GameState {
  let next = state
  for (let guard = 0; guard < limit && next.street !== 'hand-over' && next.actingSeat !== seat; guard += 1) {
    if (next.actingSeat === null) {
      next = advanceStreet(next)
      continue
    }
    const acting = next.actingSeat
    const legal = legalActionsFor(next, acting)
    next = actAs(next, acting, legal.canCheck ? 'check' : 'call')
  }
  return next
}

test('formats large Token amounts for the table HUD', () => {
  assert.equal(formatTokenAmount(25_000), '25K')
  assert.equal(formatTokenAmount(4_950_000), '4.95M')
})

test('deals 2-8 seats two unique cards each and posts blinds', () => {
  for (let count = 2; count <= 8; count += 1) {
    const random = seeded(100 + count)
    const game = createGame({
      seats: makeSeats(count),
      smallBlind: SMALL_BLIND,
      bigBlind: BIG_BLIND,
      random,
    })
    assert.equal(game.seats.length, count)
    assert.equal(game.seats.flatMap(seat => seat.hole).length, count * 2, `${count} seats`)
    assert.equal(
      new Set(game.seats.flatMap(seat => seat.hole).map(card => `${card.rank}-${card.suit}`)).size,
      count * 2,
      `${count} seats deal unique cards`,
    )
    assert.ok(game.seats.every(seat => seat.inHand))
    assert.equal(game.seats.reduce((sum, seat) => sum + seat.stack, 0) + potOf(game), count * DEFAULT_STARTING_STACK)
    assert.equal(potOf(game), SMALL_BLIND + BIG_BLIND)
  }
})

test('six-seat table matches the original blind and acting order', () => {
  const game = createGame({
    seats: makeSeats(6),
    smallBlind: SMALL_BLIND,
    bigBlind: BIG_BLIND,
    random: seeded(7),
  })
  assert.equal(game.dealer, 5)
  assert.equal(game.seats[0]?.streetBet, SMALL_BLIND)
  assert.equal(game.seats[1]?.streetBet, BIG_BLIND)
  assert.deepEqual(blindSeatIndices(game), { smallBlindSeat: 0, bigBlindSeat: 1 })
  assert.equal(game.actingSeat, 2)
  assert.deepEqual([...game.pendingActors], [0, 1, 2, 3, 4, 5])
})

test('heads-up button posts the small blind and acts first preflop', () => {
  const game = createGame({
    seats: makeSeats(2),
    smallBlind: SMALL_BLIND,
    bigBlind: BIG_BLIND,
    random: seeded(8),
  })
  assert.equal(game.dealer, 1)
  assert.deepEqual(blindSeatIndices(game), { smallBlindSeat: 1, bigBlindSeat: 0 })
  assert.equal(game.actingSeat, 1)
})

test('cards are dealt clockwise in two rounds', () => {
  const count = 6
  const random = seeded(7)
  const game = createGame({ seats: makeSeats(count), smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND, random: seeded(7) })
  const shuffled = shuffle(createDeck(), seeded(7))
  const dealer = game.dealer
  for (let offset = 1; offset <= count; offset += 1) {
    const index = (dealer + offset) % count
    assert.deepEqual(game.seats[index]?.hole, [
      shuffled[(dealer + offset) % count],
      shuffled[count + ((dealer + offset) % count)],
    ])
  }
})

test('one action advances exactly one seat and conserves Tokens', () => {
  const count = 6
  const game = createGame({ seats: makeSeats(count), smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND, random: seeded(21) })
  const actor = game.actingSeat
  assert.notEqual(actor, null)
  const next = actAs(game, actor as number, 'call')
  assert.equal(game.actingSeat, actor)
  assert.notEqual(next.actingSeat, actor)
  assert.equal(totalTokens(next), count * DEFAULT_STARTING_STACK)
})

test('a full raise reopens action for players who already acted', () => {
  const game = createGame({ seats: makeSeats(6), smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND, random: seeded(33) })
  const actor = game.actingSeat as number
  assert.equal(legalActionsFor(game, actor).canRaise, true)
  const activeOpponents = game.seats.flatMap((seat, index) => !seat.folded && !seat.allIn && index !== actor ? [index] : [])
  const raised = actAs(game, actor, 'raise')
  assert.deepEqual([...raised.pendingActors].sort((a, b) => a - b), activeOpponents.sort((a, b) => a - b))
  assert.deepEqual(raised.actedSinceFullRaise, [actor])
  assert.notEqual(raised.actingSeat, actor)
})

test('a player can raise to an explicit legal amount', () => {
  const game = createGame({ seats: makeSeats(6), smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND, random: seeded(34) })
  const actor = game.actingSeat as number
  const legal = legalActionsFor(game, actor)
  const target = Math.min(legal.maxRaiseTo, legal.minRaiseTo + SMALL_BLIND * 3)
  const raised = actAs(game, actor, 'raise', target)
  assert.equal(raised.currentBet, target)
  assert.equal(raised.seats[actor]?.streetBet, target)
  assert.match(raised.logs.at(-1) ?? '', /raises to/)
})

test('an explicit raise outside the legal range is ignored', () => {
  const game = createGame({ seats: makeSeats(6), smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND, random: seeded(35) })
  const actor = game.actingSeat as number
  const legal = legalActionsFor(game, actor)
  assert.equal(actAs(game, actor, 'raise', legal.minRaiseTo - 1), game)
  assert.equal(actAs(game, actor, 'raise', legal.maxRaiseTo + 1), game)
  assert.equal(actAs(game, actor, 'raise', legal.minRaiseTo + 0.5), game)
})

test('a short all-in requires a response without reopening raise rights', () => {
  const base = createGame({ seats: makeSeats(6), smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND, random: seeded(40) })
  const state: GameState = {
    ...base,
    actingSeat: 0,
    currentBet: 500,
    lastRaiseSize: 400,
    pendingActors: [0],
    actedSinceFullRaise: [2],
    seats: base.seats.map((seat, index) => {
      if (index === 0) return { ...seat, inHand: true, folded: false, stack: 500, streetBet: 200, committed: 200 }
      if (index === 2) return { ...seat, inHand: true, folded: false, stack: 9_500, streetBet: 500, committed: 500 }
      return { ...seat, folded: true, streetBet: 0, committed: 0 }
    }),
  }
  const shortRaise = actAs(state, 0, 'all-in')
  assert.equal(shortRaise.currentBet, 700)
  assert.equal(shortRaise.lastRaiseSize, 400)
  assert.deepEqual([...shortRaise.actedSinceFullRaise], [2, 0])
  assert.deepEqual([...shortRaise.pendingActors], [2])
  assert.equal(shortRaise.actingSeat, 2)
})

test('betting round closes after every pending response and starts postflop left of button', () => {
  const game = createGame({ seats: makeSeats(6), smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND, random: seeded(12) })
  let next = game
  for (let guard = 0; guard < 150 && next.street === 'preflop' && next.actingSeat !== null; guard += 1) {
    const acting = next.actingSeat
    const legal = legalActionsFor(next, acting)
    next = actAs(next, acting, legal.canCheck ? 'check' : 'call')
  }
  assert.equal(next.street, 'preflop')
  assert.equal(next.actingSeat, null)
  assert.equal(next.board.length, 0)
  next = advanceStreet(next)
  assert.equal(next.street, 'flop')
  assert.equal(next.board.length, 3)
  assert.equal(next.actingSeat, 0)
  assert.equal(next.currentBet, 0)
  assert.ok(next.seats.every(seat => seat.streetBet === 0))
})

test('fold removes only that seat and the hand continues', () => {
  const game = createGame({ seats: makeSeats(6), smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND, random: seeded(93) })
  const actor = game.actingSeat as number
  const folded = actAs(game, actor, 'fold')
  assert.equal(folded.seats[actor]?.folded, true)
  assert.notEqual(folded.street, 'hand-over')
  const finished = playToEnd(folded)
  assert.equal(finished.street, 'hand-over')
  assert.ok(finished.winners.length >= 1)
  assert.equal(finished.seats.reduce((sum, seat) => sum + seat.stack, 0), 6 * DEFAULT_STARTING_STACK)
})

test('all-in runout and side-pot settlement conserve the Token pool', () => {
  const seats = makeSeats(6)
  const short = seats.map((seat, index) => index === 0 ? { ...seat, stack: 100_000 } : seat)
  let game = createGame({ seats: short, smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND, random: seeded(2) })
  game = advanceToSeat(game, 0)
  assert.equal(game.actingSeat, 0)
  game = actAs(game, 0, 'all-in')
  const finished = playToEnd(game)
  assert.equal(finished.board.length, 5)
  assert.ok(finished.winners.length >= 1)
  assert.equal(finished.seats.reduce((sum, seat) => sum + seat.stack, 0), 5 * DEFAULT_STARTING_STACK + 100_000)
})

test('a passive hand reaches showdown and conserves Tokens for 2-8 seats', () => {
  for (let count = 2; count <= 8; count += 1) {
    const finished = playToEnd(createGame({
      seats: makeSeats(count),
      smallBlind: SMALL_BLIND,
      bigBlind: BIG_BLIND,
      random: seeded(70 + count),
    }))
    assert.equal(finished.board.length, 5, `${count} seats`)
    assert.ok(finished.winners.length >= 1, `${count} seats`)
    assert.equal(finished.seats.reduce((sum, seat) => sum + seat.stack, 0), count * DEFAULT_STARTING_STACK, `${count} seats`)
    assert.equal(totalTokens(finished), count * DEFAULT_STARTING_STACK, `${count} seats`)
  }
})

test('seeded action-state simulations terminate without creating Tokens', () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const finished = playToEnd(createGame({
      seats: makeSeats(6),
      smallBlind: SMALL_BLIND,
      bigBlind: BIG_BLIND,
      random: seeded(seed),
    }))
    assert.equal(finished.seats.reduce((sum, seat) => sum + seat.stack, 0), 6 * DEFAULT_STARTING_STACK, `seed ${seed}`)
  }
})

test('sitting-out seats are not dealt, cannot act, and keep their stack', () => {
  const seats = makeSeats(4).map((seat, index) => index === 2 ? { ...seat, inHand: false } : seat)
  const game = createGame({ seats, smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND, random: seeded(11) })
  assert.equal(game.seats[2]?.hole.length, 0)
  assert.equal(game.seats[2]?.inHand, false)
  assert.ok(!game.pendingActors.includes(2))
  const finished = playToEnd(game)
  assert.equal(finished.seats[2]?.stack, DEFAULT_STARTING_STACK)
  assert.equal(finished.seats.reduce((sum, seat) => sum + seat.stack, 0), 4 * DEFAULT_STARTING_STACK)
})

test('forceFold can remove a disconnected seat that is not currently acting', () => {
  const game = createGame({ seats: makeSeats(6), smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND, random: seeded(13) })
  const actor = game.actingSeat as number
  const target = (actor + 1) % 6
  const folded = forceFold(game, target)
  assert.equal(folded.seats[target]?.folded, true)
  assert.equal(folded.actingSeat, actor)
})

test('advanceStreet runs the board to showdown when everyone is all-in', () => {
  let game = createGame({ seats: makeSeats(3), smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND, random: seeded(14) })
  game = actAs(game, game.actingSeat as number, 'all-in')
  while (game.actingSeat !== null && game.street !== 'hand-over') {
    game = actAs(game, game.actingSeat, 'all-in')
  }
  let guard = 0
  while (game.street !== 'hand-over' && guard < 10) {
    game = advanceStreet(game)
    guard += 1
  }
  assert.equal(game.street, 'hand-over')
  assert.equal(game.board.length, 5)
})
