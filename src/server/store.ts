import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RoomState } from '../room/room.ts'
import { normalizeCosmetics } from '../room/types.ts'

export interface AdminAccount {
  username: string
  passwordHash: string
  totpSecret: string | null
  createdAt: number
}

export interface AuditEntry {
  at: number
  actor: string
  source: 'account' | 'tableKey' | 'system'
  action: string
  detail: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRoomState(value: unknown): value is RoomState {
  if (!isRecord(value)) return false
  return typeof value.epoch === 'number'
    && typeof value.version === 'number'
    && Array.isArray(value.players)
    && Array.isArray(value.invites)
    && (value.hand === null || isRecord(value.hand))
    && isRecord(value.settings)
    && (value.phase === 'waiting' || value.phase === 'playing' || value.phase === 'hand-over')
    && Array.isArray(value.ready)
}

function isAdminAccount(value: unknown): value is AdminAccount {
  if (!isRecord(value)) return false
  return typeof value.username === 'string'
    && typeof value.passwordHash === 'string'
    && typeof value.createdAt === 'number'
    && (value.totpSecret === null || typeof value.totpSecret === 'string')
}

export class Store {
  private readonly roomFile: string
  private readonly adminFile: string
  private readonly auditFile: string

  private timer: NodeJS.Timeout | null = null
  private pending: RoomState | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly dataDir: string) {
    this.roomFile = path.join(dataDir, 'room.json')
    this.adminFile = path.join(dataDir, 'admin.json')
    this.auditFile = path.join(dataDir, 'admin-audit.jsonl')
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true })
  }

  async loadRoom(): Promise<RoomState | null> {
    let text: string
    try {
      text = await readFile(this.roomFile, 'utf8')
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (!isRoomState(parsed)) throw new Error('room.json has an unexpected shape')
      return restoreRoom(parsed)
    } catch (error) {
      const backup = `${this.roomFile}.corrupt-${Date.now()}`
      await rename(this.roomFile, backup).catch(() => undefined)
      console.error(`[store] could not read room.json; moved it to ${backup}`, error)
      return null
    }
  }

  async loadAdmin(): Promise<AdminAccount | null> {
    let text: string
    try {
      text = await readFile(this.adminFile, 'utf8')
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (!isAdminAccount(parsed)) throw new Error('admin.json has an unexpected shape')
      return parsed
    } catch (error) {
      console.error('[store] could not read admin.json', error)
      return null
    }
  }

  async saveAdmin(account: AdminAccount): Promise<void> {
    await writeAtomic(this.adminFile, `${JSON.stringify(account, null, 2)}\n`)
  }

  scheduleRoomSave(room: RoomState): void {
    this.pending = room
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.commitRoom()
    }, 200)
    this.timer.unref()
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.commitRoom()
    await this.writing
  }

  async audit(entry: AuditEntry): Promise<void> {
    try {
      await appendFile(this.auditFile, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      console.error('[store] could not append audit entry', error)
    }
  }

  private async commitRoom(): Promise<void> {
    const room = this.pending
    if (room === null) return
    this.pending = null
    const snapshot = `${JSON.stringify(room, null, 2)}\n`
    this.writing = this.writing
      .then(() => writeAtomic(this.roomFile, snapshot))
      .catch(error => console.error('[store] could not write room.json', error))
    await this.writing
  }
}

function restoreRoom(room: RoomState): RoomState {
  return {
    ...room,
    players: room.players.map(player => ({
      ...player,
      connected: false,
      cosmetics: normalizeCosmetics(player.cosmetics),
    })),
    tableCosmetics: room.tableCosmetics == null ? null : normalizeCosmetics(room.tableCosmetics),
    paused: room.phase === 'playing' ? true : room.paused,
  }
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

async function writeAtomic(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, file)
}
