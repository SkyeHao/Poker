import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply, createRoom, type RoomContext, type RoomState } from '../src/room/index.ts'
import { Store } from '../src/server/store.ts'

function makeContext(): RoomContext {
  let id = 0
  return {
    now: 1_000_000,
    random: () => 0.5,
    newId: () => `p${++id}`,
  }
}

function must(result: ReturnType<typeof apply>): RoomState {
  assert.equal(result.error, null, result.error?.message)
  return result.room
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'poker-store-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Build a room with three players and a live hand. */
function startedRoom(): RoomState {
  const ctx = makeContext()
  let room = createRoom({ joinOpen: true })
  for (const name of ['Alice', 'Bob', 'Carol']) {
    room = must(apply(room, {
      type: 'join',
      name,
      pinHash: `pin:${name}`,
      tokenHash: `token:${name}`,
      inviteCodeHash: null,
      seat: null,
    }, ctx))
  }
  for (const player of room.players) {
    room = must(apply(room, { type: 'ready', playerId: player.id }, ctx))
  }
  assert.equal(room.phase, 'playing')
  return room
}

test('room.json survives a write/read round-trip and restores an offline table', async () => {
  await withTempDir(async dir => {
    const room = startedRoom()
    const store = new Store(dir)
    await store.init()
    store.scheduleRoomSave(room)
    await store.flush()

    const raw = JSON.parse(await readFile(path.join(dir, 'room.json'), 'utf8')) as RoomState
    assert.equal(raw.players.length, 3)
    assert.equal(raw.phase, 'playing')
    assert.equal(raw.hand?.dealer, room.hand?.dealer)
    assert.equal(raw.players[0]?.pinHash, 'pin:Alice')

    const restored = await new Store(dir).loadRoom()
    assert.ok(restored)
    assert.equal(restored.epoch, room.epoch)
    assert.equal(restored.version, room.version)
    assert.equal(restored.phase, 'playing')
    assert.equal(restored.paused, true, 'a live hand is paused after restart')
    assert.equal(restored.players.every(player => player.connected === false), true)
    assert.equal(restored.hand?.seats.filter(seat => seat.inHand).length, 3)
    for (const seat of restored.hand?.seats ?? []) {
      if (seat.inHand) assert.equal(seat.hole.length, 2)
    }
    assert.equal(restored.hand?.pot, room.hand?.pot)
    assert.equal(restored.settings.startingStack, room.settings.startingStack)

    await store.flush()
  })
})

test('admin.json round-trips and keeps the password hash intact', async () => {
  await withTempDir(async dir => {
    const store = new Store(dir)
    await store.init()
    await store.saveAdmin({
      username: 'admin',
      passwordHash: 'scrypt$salt$hash',
      totpSecret: null,
      createdAt: 123,
    })
    const loaded = await new Store(dir).loadAdmin()
    assert.deepEqual(loaded, {
      username: 'admin',
      passwordHash: 'scrypt$salt$hash',
      totpSecret: null,
      createdAt: 123,
    })
  })
})

test('a corrupt room.json is moved aside instead of crashing the server', async () => {
  await withTempDir(async dir => {
    const store = new Store(dir)
    await store.init()
    await writeFile(path.join(dir, 'room.json'), '{"epoch": "nope"}', 'utf8')
    const originalError = console.error
    const logged: unknown[] = []
    console.error = (...args: unknown[]) => { logged.push(args) }
    try {
      const loaded = await store.loadRoom()
      assert.equal(loaded, null)
    } finally {
      console.error = originalError
    }
    assert.equal(logged.length > 0, true, 'the failure is logged')
    const files = await readdir(dir)
    assert.equal(files.some(file => file.startsWith('room.json.corrupt-')), true)
  })
})

test('room writes are debounced but flush persists the latest snapshot', async () => {
  await withTempDir(async dir => {
    const store = new Store(dir)
    await store.init()
    let room = createRoom({ joinOpen: true })
    const ctx = makeContext()
    room = must(apply(room, {
      type: 'join',
      name: 'Alice',
      pinHash: 'pin:Alice',
      tokenHash: 'token:Alice',
      inviteCodeHash: null,
      seat: null,
    }, ctx))
    store.scheduleRoomSave(room)
    room = must(apply(room, {
      type: 'join',
      name: 'Bob',
      pinHash: 'pin:Bob',
      tokenHash: 'token:Bob',
      inviteCodeHash: null,
      seat: null,
    }, ctx))
    store.scheduleRoomSave(room)
    await store.flush()
    const loaded = await new Store(dir).loadRoom()
    assert.equal(loaded?.players.length, 2, 'flush writes the latest debounced snapshot')
  })
})
