import {
  legalActionsFor,
  MAX_SEATS,
  type Card,
  type LegalActions,
  type Street,
} from '../engine/index.ts'
import { displayStack, eligibleSeats, occupiedSeats, playerAtSeat, playerById } from './selectors.ts'
import { EMPTY_COSMETICS } from './types.ts'
import type { Cosmetics, PlayerRecord, RoomPhase, RoomSettings, RoomState } from './types.ts'

export interface PublicSeat {
  id: string
  name: string
  stack: number
  hole: readonly Card[]
  holeCount: number
  inHand: boolean
  folded: boolean
  allIn: boolean
  streetBet: number
  committed: number
  result: string | null
  connected: boolean
  sittingOut: boolean
  ready: boolean
  isYou: boolean
}

export interface PublicGame {
  handNumber: number
  dealer: number
  street: Street
  board: readonly Card[]
  seats: readonly PublicSeat[]
  smallBlind: number
  bigBlind: number
  currentBet: number
  lastRaiseSize: number
  actingSeat: number | null
  pot: number
  logs: readonly string[]
  winners: readonly string[]
}

export interface LobbyPlayer {
  id: string
  name: string
  seat: number | null
  stack: number
  connected: boolean
  sittingOut: boolean
  ready: boolean
  isYou: boolean
}

export interface RoomView {
  epoch: number
  version: number
  handId: string | null
  phase: RoomPhase
  paused: boolean
  settings: RoomSettings
  handNumber: number
  viewerSeat: number | null
  you: LobbyPlayer | null
  players: readonly LobbyPlayer[]
  game: PublicGame | null
  legal: LegalActions | null
  canReady: boolean
  canAct: boolean
  readyCount: number
  eligibleCount: number
  seatsOpen: boolean
  /** Cosmetics this viewer should render (table override already applied). */
  cosmetics: Cosmetics
  /** The table-wide override, so the UI can show it and offer a reset. */
  cosmeticsOverride: Cosmetics | null
}

/** Field-by-field merge: an override only wins where it sets a value. */
function resolveCosmetics(room: RoomState, player: PlayerRecord | undefined): Cosmetics {
  const own = player?.cosmetics ?? EMPTY_COSMETICS
  const override = room.tableCosmetics
  if (override === null) return own
  const pick = (forced: string, mine: string): string => (forced !== '' ? forced : mine)
  return {
    back: pick(override.back, own.back),
    faces: {
      spades: pick(override.faces.spades, own.faces.spades),
      hearts: pick(override.faces.hearts, own.faces.hearts),
      clubs: pick(override.faces.clubs, own.faces.clubs),
      diamonds: pick(override.faces.diamonds, own.faces.diamonds),
    },
  }
}

function lobbyPlayer(room: RoomState, player: PlayerRecord, viewerId: string | null): LobbyPlayer {
  return {
    id: player.id,
    name: player.name,
    seat: player.seat,
    stack: displayStack(room, player),
    connected: player.connected,
    sittingOut: player.sittingOut,
    ready: room.ready.includes(player.id),
    isYou: player.id === viewerId,
  }
}

/**
 * Build the projection for one viewer. The deck never leaves the server and
 * hole cards are only included for the viewer or after a showdown.
 */
export function viewFor(room: RoomState, viewerId: string | null): RoomView {
  const viewer = viewerId === null ? undefined : playerById(room, viewerId)
  const viewerSeat = viewer === undefined ? null : viewer.seat
  const hand = room.hand
  const playing = room.phase === 'playing'
  const ready = new Set(room.ready)
  const seats: PublicSeat[] = []

  for (let index = 0; index < MAX_SEATS; index += 1) {
    const occupant = playerAtSeat(room, index)
    const handSeat = hand?.seats[index]
    const ownsSeat = occupant !== undefined && handSeat !== undefined && handSeat.id === occupant.id
    const isYou = occupant !== undefined && occupant.id === viewerId
    const inHand = ownsSeat && handSeat.inHand
    const showdown = handSeat !== undefined && handSeat.inHand && !handSeat.folded && hand?.street === 'hand-over'
    const hole = inHand && (isYou || showdown) ? handSeat.hole : []
    const playingSeat = playing && ownsSeat

    seats.push({
      id: occupant?.id ?? '',
      name: occupant?.name ?? '',
      stack: playingSeat && handSeat !== undefined ? handSeat.stack : occupant?.stack ?? 0,
      hole,
      holeCount: inHand ? 2 : 0,
      inHand,
      folded: ownsSeat ? handSeat.folded : false,
      allIn: ownsSeat ? handSeat.allIn : false,
      streetBet: ownsSeat ? handSeat.streetBet : 0,
      committed: ownsSeat ? handSeat.committed : 0,
      result: ownsSeat ? handSeat.result ?? null : null,
      connected: occupant?.connected ?? false,
      sittingOut: occupant?.sittingOut ?? false,
      ready: occupant !== undefined && ready.has(occupant.id),
      isYou,
    })
  }

  const game: PublicGame | null = hand === null ? null : {
    handNumber: hand.handNumber,
    dealer: hand.dealer,
    street: hand.street,
    board: hand.board,
    seats,
    smallBlind: hand.smallBlind,
    bigBlind: hand.bigBlind,
    currentBet: hand.currentBet,
    lastRaiseSize: hand.lastRaiseSize,
    actingSeat: playing ? hand.actingSeat : null,
    pot: hand.pot,
    logs: hand.logs,
    winners: hand.winners,
  }

  const ownHandSeat = viewerSeat === null ? undefined : hand?.seats[viewerSeat]
  const ownsSeat = viewer !== undefined && ownHandSeat !== undefined && ownHandSeat.id === viewer.id
  const canAct = playing
    && !room.paused
    && hand !== null
    && hand.street !== 'hand-over'
    && viewerSeat !== null
    && ownsSeat
    && hand.actingSeat === viewerSeat
  const legal = canAct && viewerSeat !== null ? legalActionsFor(hand, viewerSeat) : null

  const canReady = viewer !== undefined
    && !viewer.kicked
    && viewer.seat !== null
    && viewer.connected
    && viewer.stack > 0
    && !viewer.sittingOut
    && !viewer.leaveAfterHand
    && room.phase !== 'playing'
    && !room.paused

  const eligible = eligibleSeats(room)
  const readyCount = eligible.filter(seat => {
    const player = playerAtSeat(room, seat)
    return player !== undefined && ready.has(player.id)
  }).length
  const occupied = occupiedSeats(room)

  return {
    epoch: room.epoch,
    version: room.version,
    handId: hand === null ? null : `${room.epoch}:${room.handNumber}`,
    phase: room.phase,
    paused: room.paused,
    settings: room.settings,
    handNumber: room.handNumber,
    viewerSeat,
    you: viewer === undefined ? null : lobbyPlayer(room, viewer, viewerId),
    players: room.players
      .filter(player => !player.kicked)
      .map(player => lobbyPlayer(room, player, viewerId)),
    game,
    legal,
    canReady,
    canAct,
    readyCount,
    eligibleCount: eligible.length,
    seatsOpen: occupied.size < MAX_SEATS,
    cosmetics: resolveCosmetics(room, viewer),
    cosmeticsOverride: room.tableCosmetics,
  }
}
