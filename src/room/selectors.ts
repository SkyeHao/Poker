import {
  advanceStreet,
  MAX_SEATS,
  type GameState,
} from '../engine/index.ts'
import type { PlayerRecord, RoomState } from './types.ts'

export function playerById(room: RoomState, id: string): PlayerRecord | undefined {
  return room.players.find(player => player.id === id)
}

export function playerAtSeat(room: RoomState, seat: number): PlayerRecord | undefined {
  return room.players.find(player => player.seat === seat)
}

export function normalizeName(name: string): string {
  return name.trim()
}

export function sameName(a: string, b: string): boolean {
  return a.toLocaleLowerCase() === b.toLocaleLowerCase()
}

export function isEligible(player: PlayerRecord): boolean {
  return player.seat !== null
    && player.connected
    && !player.sittingOut
    && !player.leaveAfterHand
    && !player.kicked
    && player.stack > 0
}

export function eligibleSeats(room: RoomState): number[] {
  return room.players
    .filter(player => isEligible(player))
    .map(player => player.seat as number)
    .sort((a, b) => a - b)
}

export function occupiedSeats(room: RoomState): Set<number> {
  const seats = new Set<number>()
  for (const player of room.players) {
    if (player.seat !== null) seats.add(player.seat)
  }
  return seats
}

export function firstEmptySeat(room: RoomState): number | null {
  const occupied = occupiedSeats(room)
  for (let seat = 0; seat < MAX_SEATS; seat += 1) {
    if (!occupied.has(seat)) return seat
  }
  return null
}

export function handIdOf(room: RoomState): string | null {
  return room.hand === null ? null : `${room.epoch}:${room.handNumber}`
}

/** Stack to display for a player; the live hand seat wins while a hand is running. */
export function displayStack(room: RoomState, player: PlayerRecord): number {
  if (room.phase === 'playing' && player.seat !== null) {
    const seat = room.hand?.seats[player.seat]
    if (seat !== undefined && seat.id === player.id) return seat.stack
  }
  return player.stack
}

export function pickDealer(room: RoomState, eligible: readonly number[]): number {
  const sorted = [...eligible].sort((a, b) => a - b)
  const last = room.dealer
  if (last === null) return sorted[sorted.length - 1] as number
  return sorted.find(seat => seat > last) ?? (sorted[0] as number)
}

/** Run the board forward while nobody is left to act (all-in runout). */
export function advanceHand(hand: GameState): GameState {
  let next = hand
  for (let guard = 0; guard < 8 && next.street !== 'hand-over' && next.actingSeat === null; guard += 1) {
    next = advanceStreet(next)
  }
  return next
}

export function canStart(room: RoomState): boolean {
  if (room.paused || room.phase === 'playing') return false
  const eligible = eligibleSeats(room)
  if (eligible.length < 2) return false
  const ready = new Set(room.ready)
  return eligible.every(seat => {
    const player = playerAtSeat(room, seat)
    return player !== undefined && ready.has(player.id)
  })
}
