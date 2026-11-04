import {
  DEFAULT_BIG_BLIND,
  DEFAULT_SMALL_BLIND,
  DEFAULT_STARTING_STACK,
  type GameState,
} from '../engine/index.ts'
import type { AdminActor, Cosmetics, InviteRecord, RoomCommand } from '../protocol/index.ts'

export type { AdminActor, Cosmetics, InviteRecord, RoomCommand }

export const EMPTY_COSMETICS: Cosmetics = {
  back: '',
  faces: { spades: '', hearts: '', clubs: '', diamonds: '' },
}

export function sameCosmetics(left: Cosmetics, right: Cosmetics): boolean {
  return left.back === right.back
    && left.faces.spades === right.faces.spades
    && left.faces.hearts === right.faces.hearts
    && left.faces.clubs === right.faces.clubs
    && left.faces.diamonds === right.faces.diamonds
}

const ART_ID = /^[a-z0-9-]{0,40}$/

/** Tolerate rooms written before cosmetics existed, and any hand-edited value. */
export function normalizeCosmetics(value: unknown): Cosmetics {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const faces = typeof record.faces === 'object' && record.faces !== null
    ? record.faces as Record<string, unknown>
    : {}
  const pick = (candidate: unknown): string => (typeof candidate === 'string' && ART_ID.test(candidate) ? candidate : '')
  return {
    back: pick(record.back),
    faces: {
      spades: pick(faces.spades),
      hearts: pick(faces.hearts),
      clubs: pick(faces.clubs),
      diamonds: pick(faces.diamonds),
    },
  }
}

export type RoomPhase = 'waiting' | 'playing' | 'hand-over'

export interface RoomSettings {
  smallBlind: number
  bigBlind: number
  startingStack: number
  joinOpen: boolean
}

export interface PlayerRecord {
  id: string
  name: string
  pinHash: string
  tokenHash: string | null
  seat: number | null
  stack: number
  connected: boolean
  sittingOut: boolean
  leaveAfterHand: boolean
  kicked: boolean
  cosmetics: Cosmetics
  createdAt: number
  lastSeenAt: number
}

export interface RoomState {
  epoch: number
  version: number
  settings: RoomSettings
  players: readonly PlayerRecord[]
  hand: GameState | null
  phase: RoomPhase
  paused: boolean
  ready: readonly string[]
  dealer: number | null
  handNumber: number
  invites: readonly InviteRecord[]
  /** Table-wide cosmetics set by an admin; empty fields fall back to each player's choice. */
  tableCosmetics: Cosmetics | null
}

export type RoomEvent =
  | { type: 'playerJoined'; playerId: string; name: string; seat: number }
  | { type: 'playerRemoved'; playerId: string; name: string; reason: 'kicked' | 'left' }
  | { type: 'seatChanged'; playerId: string; name: string; seat: number | null }
  | { type: 'handStarted'; handNumber: number; dealer: number; handId: string }
  | { type: 'handEnded'; handNumber: number; winners: readonly string[] }
  | { type: 'roomReset'; epoch: number }
  | { type: 'notice'; message: string }

export interface RoomError {
  code: string
  message: string
}

export interface ApplyResult {
  room: RoomState
  events: RoomEvent[]
  error: RoomError | null
}

export interface RoomContext {
  now: number
  random: () => number
  newId: () => string
}

export const DEFAULT_SETTINGS: RoomSettings = {
  smallBlind: DEFAULT_SMALL_BLIND,
  bigBlind: DEFAULT_BIG_BLIND,
  startingStack: DEFAULT_STARTING_STACK,
  joinOpen: false,
}

export function createRoom(settings: Partial<RoomSettings> = {}): RoomState {
  return {
    epoch: 1,
    version: 0,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    players: [],
    hand: null,
    phase: 'waiting',
    paused: false,
    ready: [],
    dealer: null,
    handNumber: 0,
    invites: [],
    tableCosmetics: null,
  }
}
