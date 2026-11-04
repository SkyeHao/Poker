import { compareValues, createDeck, evaluateBest, shuffle, type Card, type HandValue } from './poker.ts'

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'hand-over'
export const PLAYER_ACTIONS = ['fold', 'check', 'call', 'raise', 'all-in'] as const
export type PlayerAction = typeof PLAYER_ACTIONS[number]

export interface SeatInit {
  readonly id: string
  readonly name: string
  readonly stack: number
  /** Whether this seat is dealt into the hand. Offline/sitting-out/busted seats stay false. */
  readonly inHand: boolean
}

export interface Seat {
  readonly id: string
  readonly name: string
  readonly stack: number
  readonly hole: readonly Card[]
  readonly inHand: boolean
  readonly folded: boolean
  readonly allIn: boolean
  readonly streetBet: number
  readonly committed: number
  readonly result?: string
}

export interface GameState {
  readonly handNumber: number
  readonly dealer: number
  readonly street: Street
  readonly board: readonly Card[]
  readonly deck: readonly Card[]
  readonly seats: readonly Seat[]
  readonly smallBlind: number
  readonly bigBlind: number
  readonly currentBet: number
  readonly lastRaiseSize: number
  readonly actingSeat: number | null
  readonly pendingActors: readonly number[]
  readonly actedSinceFullRaise: readonly number[]
  readonly pot: number
  readonly logs: readonly string[]
  readonly winners: readonly string[]
}

export interface LegalActions {
  readonly toCall: number
  readonly minRaiseTo: number
  readonly maxRaiseTo: number
  readonly raiseTo: number
  readonly canCheck: boolean
  readonly canCall: boolean
  readonly canRaise: boolean
  readonly canAllIn: boolean
}

export interface CreateGameOptions {
  readonly seats: readonly SeatInit[]
  readonly smallBlind: number
  readonly bigBlind: number
  readonly dealer?: number
  readonly handNumber?: number
  readonly random?: () => number
}

export const DEFAULT_STARTING_STACK = 5_000_000
export const DEFAULT_SMALL_BLIND = 25_000
export const DEFAULT_BIG_BLIND = 50_000
export const STARTING_STACK = DEFAULT_STARTING_STACK
export const SMALL_BLIND = DEFAULT_SMALL_BLIND
export const BIG_BLIND = DEFAULT_BIG_BLIND
export const MIN_SEATS = 2
export const MAX_SEATS = 8

export function formatTokenAmount(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`
  return value.toLocaleString()
}

function replaceSeat(state: GameState, index: number, change: (seat: Seat) => Seat): GameState {
  const seats = [...state.seats]
  seats[index] = change(seats[index] as Seat)
  return { ...state, seats }
}

function addLog(state: GameState, message: string): GameState {
  return { ...state, logs: [...state.logs.slice(-8), message] }
}

function pay(state: GameState, index: number, requested: number): GameState {
  const seat = state.seats[index] as Seat
  const amount = Math.min(Math.max(0, requested), seat.stack)
  return replaceSeat(state, index, current => ({
    ...current,
    stack: current.stack - amount,
    streetBet: current.streetBet + amount,
    committed: current.committed + amount,
    allIn: current.stack === amount,
  }))
}

function nextIndex(seats: readonly Seat[], from: number, predicate: (seat: Seat, index: number) => boolean): number | null {
  for (let offset = 1; offset <= seats.length; offset += 1) {
    const index = (from + offset) % seats.length
    const seat = seats[index]
    if (seat !== undefined && predicate(seat, index)) return index
  }
  return null
}

function nextInHandIndex(seats: readonly Seat[], from: number): number | null {
  return nextIndex(seats, from, seat => seat.inHand)
}

function normalizeDealer(seats: readonly Seat[], requested: number | undefined): number {
  const start = requested === undefined ? seats.length - 1 : requested
  const bounded = ((start % seats.length) + seats.length) % seats.length
  const seat = seats[bounded]
  if (seat?.inHand === true) return bounded
  const next = nextInHandIndex(seats, bounded)
  if (next === null) throw new Error('no seats are in hand')
  return next
}

export function blindSeatIndices(state: GameState): { smallBlindSeat: number; bigBlindSeat: number } {
  const inHandCount = state.seats.filter(seat => seat.inHand).length
  const smallBlindSeat = inHandCount === 2
    ? state.dealer
    : nextInHandIndex(state.seats, state.dealer) ?? state.dealer
  const bigBlindSeat = nextInHandIndex(state.seats, smallBlindSeat) ?? smallBlindSeat
  return { smallBlindSeat, bigBlindSeat }
}

function nextPendingIndex(state: GameState, from: number, pending: readonly number[]): number | null {
  const allowed = new Set(pending)
  return nextIndex(state.seats, from, (_seat, index) => allowed.has(index))
}

function activeSeats(state: GameState): Array<[number, Seat]> {
  return state.seats
    .map((seat, index) => [index, seat] as [number, Seat])
    .filter(([, seat]) => seat.inHand && !seat.folded)
}

function actionableIndices(state: GameState): number[] {
  return state.seats.flatMap((seat, index) => seat.inHand && !seat.folded && !seat.allIn ? [index] : [])
}

function withPot(state: GameState): GameState {
  return { ...state, pot: potOf(state) }
}

export function potOf(state: GameState): number {
  return state.seats.reduce((sum, seat) => sum + seat.committed, 0)
}

function awardUncontested(state: GameState): GameState {
  const active = activeSeats(state)
  if (active.length !== 1) return state
  const [index, winner] = active[0] as [number, Seat]
  const pot = potOf(state)
  let next = replaceSeat(state, index, seat => ({ ...seat, stack: seat.stack + pot, result: `Won ${formatTokenAmount(pot)}` }))
  next = { ...next, street: 'hand-over', currentBet: 0, actingSeat: null, pendingActors: [], winners: [winner.id], pot }
  return addLog(next, `${winner.name} wins ${formatTokenAmount(pot)} uncontested`)
}

function settleShowdown(state: GameState): GameState {
  const seats = state.seats.map(seat => ({ ...seat }))
  const levels = [...new Set(seats.map(seat => seat.committed).filter(value => value > 0))].sort((a, b) => a - b)
  let lower = 0
  const won = new Map<number, number>()
  for (const level of levels) {
    const contributors = seats.map((seat, index) => ({ seat, index })).filter(({ seat }) => seat.committed >= level)
    const amount = (level - lower) * contributors.length
    lower = level
    const eligible = contributors.filter(({ seat }) => seat.inHand && !seat.folded && seat.hole.length === 2)
    if (eligible.length === 0) continue
    let best: HandValue | undefined
    let winners: number[] = []
    for (const { seat, index } of eligible) {
      const value = evaluateBest([...seat.hole, ...state.board])
      const comparison = best === undefined ? 1 : compareValues(value, best)
      if (comparison > 0) {
        best = value
        winners = [index]
      } else if (comparison === 0) winners.push(index)
    }
    const share = Math.floor(amount / winners.length)
    let remainder = amount - share * winners.length
    for (const index of winners) {
      won.set(index, (won.get(index) ?? 0) + share + (remainder > 0 ? 1 : 0))
      if (remainder > 0) remainder -= 1
    }
  }
  for (const [index, amount] of won) {
    const seat = seats[index] as Seat
    const value = evaluateBest([...seat.hole, ...state.board])
    seats[index] = { ...seat, stack: seat.stack + amount, result: `${value.label} · +${formatTokenAmount(amount)}` }
  }
  const winnerIds = [...won.keys()].map(index => (seats[index] as Seat).id)
  const names = [...won.keys()].map(index => (seats[index] as Seat).name).join(' & ')
  const pot = potOf(state)
  return addLog({
    ...state,
    seats,
    street: 'hand-over',
    currentBet: 0,
    actingSeat: null,
    pendingActors: [],
    winners: winnerIds,
    pot,
  }, `${names} win the showdown`)
}

function revealTo(state: GameState, count: number): GameState {
  const board = [...state.board]
  const deck = [...state.deck]
  while (board.length < count) {
    const card = deck.shift()
    if (card === undefined) throw new Error('deck exhausted')
    board.push(card)
  }
  return { ...state, board, deck }
}

function beginPostflopStreet(state: GameState, street: Exclude<Street, 'preflop' | 'hand-over'>, boardCount: number): GameState {
  let next = revealTo({
    ...state,
    street,
    currentBet: 0,
    lastRaiseSize: state.bigBlind,
    actedSinceFullRaise: [],
    seats: state.seats.map(seat => ({ ...seat, streetBet: 0 })),
  }, boardCount)
  const actionable = actionableIndices(next)
  const pending = actionable.length >= 2 ? actionable : []
  const actingSeat = pending.length === 0
    ? null
    : nextIndex(next.seats, next.dealer, (_seat, index) => pending.includes(index))
  next = { ...next, pendingActors: pending, actingSeat }
  return addLog(next, street === 'flop' ? 'Flop dealt' : street === 'turn' ? 'Turn dealt' : 'River dealt')
}

function finishStreet(state: GameState): GameState {
  const uncontested = awardUncontested(state)
  if (uncontested.street === 'hand-over') return uncontested
  if (state.street === 'preflop') return beginPostflopStreet(state, 'flop', 3)
  if (state.street === 'flop') return beginPostflopStreet(state, 'turn', 4)
  if (state.street === 'turn') return beginPostflopStreet(state, 'river', 5)
  if (state.street === 'river') return settleShowdown(revealTo(state, 5))
  return state
}

/** Advance the board when nobody is left to act (all-in runout or a completed street). */
export function advanceStreet(state: GameState): GameState {
  if (state.street === 'hand-over') return state
  if (state.actingSeat !== null) return state
  return withPot(finishStreet(state))
}

/** Next seat that is dealt into the current hand, starting strictly after `from`. */
export function nextInHandSeat(state: GameState, from: number): number {
  return nextInHandIndex(state.seats, from) ?? from
}

export function legalActionsFor(state: GameState, index: number): LegalActions {
  const seat = state.seats[index]
  const ownsTurn = seat !== undefined
    && state.street !== 'hand-over'
    && state.actingSeat === index
    && seat.inHand
    && !seat.folded
    && !seat.allIn
  const toCall = seat === undefined ? 0 : Math.max(0, state.currentBet - seat.streetBet)
  const pot = potOf(state)
  const suggestedRaise = Math.max(state.lastRaiseSize, Math.round(Math.max(state.bigBlind, pot * 0.75) / state.bigBlind) * state.bigBlind)
  const maximumTo = seat === undefined ? 0 : seat.streetBet + seat.stack
  const minimumTo = state.currentBet + state.lastRaiseSize
  const raiseTo = Math.min(maximumTo, Math.max(minimumTo, state.currentBet + suggestedRaise))
  const raiseRightsOpen = !state.actedSinceFullRaise.includes(index)
  return {
    toCall,
    minRaiseTo: minimumTo,
    maxRaiseTo: maximumTo,
    raiseTo,
    canCheck: ownsTurn && toCall === 0,
    canCall: ownsTurn && toCall > 0 && seat !== undefined && seat.stack > 0,
    canRaise: ownsTurn && raiseRightsOpen && maximumTo >= state.currentBet + state.lastRaiseSize,
    canAllIn: ownsTurn && seat !== undefined && seat.stack > 0,
  }
}

function recordActed(state: GameState, index: number): number[] {
  return state.actedSinceFullRaise.includes(index)
    ? [...state.actedSinceFullRaise]
    : [...state.actedSinceFullRaise, index]
}

function resolveAfterAction(state: GameState, actor: number, fullRaise: boolean, raisedBet: boolean): GameState {
  const uncontested = awardUncontested(state)
  if (uncontested.street === 'hand-over') return uncontested

  const actionable = actionableIndices(state)
  let pending: number[]
  let acted = recordActed(state, actor)
  if (fullRaise) {
    pending = actionable.filter(index => index !== actor)
    acted = [actor]
  } else {
    const remaining = state.pendingActors.filter(index => index !== actor && actionable.includes(index))
    const owesNewBet = raisedBet
      ? actionable.filter(index => index !== actor && (state.seats[index]?.streetBet ?? 0) < state.currentBet)
      : []
    pending = [...new Set([...remaining, ...owesNewBet])]
  }

  if (pending.length === 0) {
    return withPot(addLog({
      ...state,
      pendingActors: [],
      actingSeat: null,
      actedSinceFullRaise: acted,
    }, `${state.street === 'preflop' ? 'Pre-flop' : state.street[0]?.toUpperCase()}${state.street === 'preflop' ? '' : state.street.slice(1)} betting complete`))
  }
  const actingSeat = nextPendingIndex(state, actor, pending)
  if (actingSeat === null) throw new Error('pending betting actors have no next seat')
  return withPot({ ...state, pendingActors: pending, actingSeat, actedSinceFullRaise: acted })
}

function actAt(state: GameState, index: number, action: PlayerAction, requestedRaiseTo?: number): GameState {
  if (state.street === 'hand-over' || state.actingSeat !== index) return state
  const seat = state.seats[index]
  if (seat === undefined || !seat.inHand) return state
  const legal = legalActionsFor(state, index)
  let next = state
  let fullRaise = false
  let raisedBet = false

  if (action === 'fold') {
    next = replaceSeat(next, index, current => ({ ...current, folded: true }))
    next = addLog(next, `${seat.name} folds`)
  } else if (action === 'check' && legal.canCheck) {
    next = addLog(next, `${seat.name} checks`)
  } else if (action === 'call' && legal.canCall) {
    const amount = Math.min(legal.toCall, seat.stack)
    next = pay(next, index, legal.toCall)
    next = addLog(next, `${seat.name} calls ${formatTokenAmount(amount)}${amount < legal.toCall ? ' all-in' : ''}`)
  } else if (action === 'raise' && legal.canRaise) {
    const raiseTo = requestedRaiseTo ?? legal.raiseTo
    if (!Number.isFinite(raiseTo) || !Number.isInteger(raiseTo) || raiseTo < legal.minRaiseTo || raiseTo > legal.maxRaiseTo) return state
    const oldBet = next.currentBet
    const amount = raiseTo - seat.streetBet
    next = pay(next, index, amount)
    const newBet = (next.seats[index] as Seat).streetBet
    const raiseSize = newBet - oldBet
    next = { ...next, currentBet: newBet, lastRaiseSize: raiseSize }
    next = addLog(next, `${seat.name} raises to ${formatTokenAmount(newBet)}`)
    fullRaise = true
    raisedBet = true
  } else if (action === 'all-in' && legal.canAllIn) {
    const oldBet = next.currentBet
    next = pay(next, index, seat.stack)
    const newBet = (next.seats[index] as Seat).streetBet
    if (newBet > oldBet) {
      const raiseSize = newBet - oldBet
      fullRaise = raiseSize >= next.lastRaiseSize
      raisedBet = true
      next = { ...next, currentBet: newBet, lastRaiseSize: fullRaise ? raiseSize : next.lastRaiseSize }
    }
    next = addLog(next, `${seat.name} moves all-in for ${formatTokenAmount(seat.stack)}`)
  } else {
    return state
  }
  return resolveAfterAction(next, index, fullRaise, raisedBet)
}

export function actAs(state: GameState, index: number, action: PlayerAction, raiseTo?: number): GameState {
  return actAt(state, index, action, raiseTo)
}

/** Fold a seat even when it is not their turn. Used by admins to remove disconnected players. */
export function forceFold(state: GameState, index: number): GameState {
  const seat = state.seats[index]
  if (seat === undefined || !seat.inHand || seat.folded || state.street === 'hand-over') return state
  if (state.actingSeat === index) return actAt(state, index, 'fold')
  let next = replaceSeat(state, index, current => ({ ...current, folded: true }))
  next = {
    ...next,
    pendingActors: next.pendingActors.filter(candidate => candidate !== index),
    actedSinceFullRaise: next.actedSinceFullRaise.filter(candidate => candidate !== index),
  }
  next = addLog(next, `${seat.name} folds`)
  return withPot(awardUncontested(next))
}

export function createGame(options: CreateGameOptions): GameState {
  const { seats: initialSeats, smallBlind, bigBlind, random = Math.random } = options
  if (initialSeats.length < MIN_SEATS || initialSeats.length > MAX_SEATS) {
    throw new Error(`table requires ${MIN_SEATS}-${MAX_SEATS} seats`)
  }
  const inHandCount = initialSeats.filter(seat => seat.inHand && seat.stack > 0).length
  if (inHandCount < 2) throw new Error('at least two funded seats must be in hand')

  const normalized: SeatInit[] = initialSeats.map(seat => ({
    id: seat.id,
    name: seat.name,
    stack: Math.max(0, Math.floor(seat.stack)),
    inHand: seat.inHand && seat.stack > 0,
  }))
  const skeleton: Seat[] = normalized.map(seat => ({
    id: seat.id,
    name: seat.name,
    stack: seat.stack,
    hole: [],
    inHand: seat.inHand,
    folded: !seat.inHand,
    allIn: false,
    streetBet: 0,
    committed: 0,
  }))

  const dealer = normalizeDealer(skeleton, options.dealer)
  const handNumber = options.handNumber ?? 1
  const deck = shuffle(createDeck(), random)
  const holes: Card[][] = skeleton.map(() => [])
  for (let round = 0; round < 2; round += 1) {
    for (let offset = 1; offset <= skeleton.length; offset += 1) {
      const index = (dealer + offset) % skeleton.length
      const seat = skeleton[index]
      if (seat === undefined || !seat.inHand) continue
      holes[index]?.push(deck.shift() as Card)
    }
  }

  let state: GameState = {
    handNumber,
    dealer,
    street: 'preflop',
    board: [],
    deck,
    seats: skeleton.map((seat, index) => ({ ...seat, hole: holes[index] ?? [] })),
    smallBlind,
    bigBlind,
    currentBet: bigBlind,
    lastRaiseSize: bigBlind,
    actingSeat: null,
    pendingActors: [],
    actedSinceFullRaise: [],
    pot: 0,
    logs: [`Hand #${handNumber}`],
    winners: [],
  }

  const { smallBlindSeat, bigBlindSeat } = blindSeatIndices(state)
  state = pay(state, smallBlindSeat, state.smallBlind)
  state = pay(state, bigBlindSeat, state.bigBlind)
  state = addLog(state, `${state.seats[smallBlindSeat]?.name} posts ${formatTokenAmount(state.smallBlind)}; ${state.seats[bigBlindSeat]?.name} posts ${formatTokenAmount(state.bigBlind)}`)
  const actionable = actionableIndices(state)
  const loneActor = actionable.length === 1 ? state.seats[actionable[0] as number] : undefined
  const pending = loneActor !== undefined && loneActor.streetBet >= state.currentBet ? [] : actionable
  const actingSeat = nextIndex(state.seats, bigBlindSeat, (_seat, index) => pending.includes(index))
  return withPot({ ...state, pendingActors: pending, actingSeat })
}
