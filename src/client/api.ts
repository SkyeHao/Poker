import type { CreateInviteInput, InviteMeta, JoinInput } from '../protocol/index.ts'

export type { CreateInviteInput, InviteMeta, JoinInput }

export interface MePlayer {
  id: string
  name: string
  seat: number | null
  stack: number
  connected: boolean
}

export interface RoomSummary {
  joinOpen: boolean
  phase: 'waiting' | 'playing' | 'hand-over'
  paused: boolean
  handNumber: number
  players: number
  seats: number
  smallBlind: number
  bigBlind: number
  startingStack: number
}

export interface MeResponse {
  player: MePlayer | null
  admin: boolean
  room: RoomSummary
}

export interface CreateInviteResult {
  invite: InviteMeta
  code: string
  url: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string | undefined

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

const BASE_RAW = import.meta.env.BASE_URL
export const BASE = BASE_RAW.endsWith('/') ? BASE_RAW : `${BASE_RAW}/`

function withBase(path: string): string {
  return `${BASE}${path.replace(/^\/+/, '')}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    const options: RequestInit = { credentials: 'same-origin', ...init }
    if (init?.body !== undefined) options.headers = { 'Content-Type': 'application/json' }
    response = await fetch(withBase(path), options)
  } catch {
    throw new ApiError(0, 'network')
  }
  const text = await response.text()
  let payload: unknown = null
  if (text !== '') {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }
  if (!response.ok) {
    const body = payload as { error?: unknown; code?: unknown } | null
    const message = typeof body?.error === 'string' ? body.error : `Request failed (${response.status})`
    const code = typeof body?.code === 'string' ? body.code : undefined
    throw new ApiError(response.status, message, code)
  }
  return payload as T
}

export const api = {
  me: () => request<MeResponse>('/api/me'),
  join: (input: JoinInput) => request<{ ok: true; playerId: string | null; name: string }>('/api/join', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),
  adminLogin: (username: string, password: string) => request<{ ok: true; username: string }>('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  }),
  adminLogout: () => request<{ ok: true }>('/api/admin/logout', { method: 'POST' }),
  invites: () => request<{ invites: InviteMeta[] }>('/api/admin/invites'),
  createInvite: (input: CreateInviteInput) => request<CreateInviteResult>('/api/admin/invites', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  revokeInvite: (id: string) => request<{ ok: true }>(`/api/admin/invites/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
  }),
  deleteInvite: (id: string) => request<{ ok: true }>(`/api/admin/invites/${encodeURIComponent(id)}/delete`, {
    method: 'POST',
  }),
  revokeAllInvites: () => request<{ ok: true }>('/api/admin/invites/revoke-all', { method: 'POST' }),
  resetRoom: () => request<{ ok: true; epoch: number }>('/api/admin/room/reset', {
    method: 'POST',
    body: JSON.stringify({ confirm: 'RESET' }),
  }),
  setJoinOpen: (joinOpen: boolean) => request<{ ok: true; joinOpen: boolean }>('/api/admin/room/open', {
    method: 'POST',
    body: JSON.stringify({ joinOpen }),
  }),
}
