import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'

const dataDir = await mkdtemp(path.join(tmpdir(), 'poker-smoke-'))
const port = 3199
const base = `http://127.0.0.1:${port}`
const env = {
  ...process.env,
  PORT: String(port),
  HOST: '127.0.0.1',
  DATA_DIR: dataDir,
  SESSION_SECRET: 'smoke-session-secret-0123456789abcdef',
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'smoke-test-password',
  TABLE_ADMIN_KEY: 'smoke-table-key',
  NODE_ENV: 'test',
  // Override inherited deployment settings: this smoke test serves the app at the root.
  POKER_BASE: '/',
  PUBLIC_URL: base,
}

const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
child.stdout.on('data', chunk => { output += chunk })
child.stderr.on('data', chunk => { output += chunk })

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/room`)
      if (response.ok) return
    } catch {
      // not ready yet
    }
    await wait(100)
  }
  throw new Error('server did not start')
}

function cookieFrom(response) {
  const cookies = response.headers.getSetCookie()
  return cookies.map(cookie => cookie.split(';')[0]).join('; ')
}

async function post(pathname, body, cookie = '') {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie === '' ? {} : { cookie }) },
    body: JSON.stringify(body),
  })
  const json = await response.json()
  if (!response.ok) throw new Error(`${pathname} failed: ${JSON.stringify(json)}`)
  return { json, cookie: cookieFrom(response) }
}

function connect(cookie, onView) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } })
  const messages = []
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString())
    messages.push(message)
    if (message.type === 'view') onView(socket, message.view)
  })
  socket.on('error', error => { output += `\nws error: ${error.message}` })
  return { socket, messages }
}

try {
  await waitForServer()
  const login = await post('/api/admin/login', { username: 'admin', password: 'smoke-test-password' })
  const invite = await post('/api/admin/invites', { label: 'smoke', maxUses: 2 }, login.cookie)
  const alice = await post('/api/join', { name: 'Alice', pin: '1234', invite: invite.json.code })
  const bob = await post('/api/join', { name: 'Bob', pin: '5678', invite: invite.json.code })

  let aliceSeat = null
  let bobSeat = null
  let acted = false
  let aliceReady = false
  let bobReady = false

  const aliceConn = connect(alice.cookie, (socket, view) => {
    aliceSeat = view.viewerSeat
    const text = JSON.stringify(view)
    if (text.includes('"deck"')) throw new Error('deck leaked to client')
    if ((view.phase === 'waiting' || view.phase === 'hand-over') && view.canReady) {
      if (!aliceReady) {
        aliceReady = true
        socket.send(JSON.stringify({ type: 'ready' }))
      }
    }
    if (view.canAct && view.legal !== null && !acted) {
      acted = true
      socket.send(JSON.stringify({
        type: 'act',
        handId: view.handId,
        version: view.version,
        action: view.legal.canCheck ? 'check' : 'call',
      }))
    }
  })
  const bobConn = connect(bob.cookie, (socket, view) => {
    bobSeat = view.viewerSeat
    if ((view.phase === 'waiting' || view.phase === 'hand-over') && view.canReady) {
      if (!bobReady) {
        bobReady = true
        socket.send(JSON.stringify({ type: 'ready' }))
      }
    }
    if (view.canAct && view.legal !== null && !acted) {
      acted = true
      socket.send(JSON.stringify({
        type: 'act',
        handId: view.handId,
        version: view.version,
        action: view.legal.canCheck ? 'check' : 'call',
      }))
    }
  })

  for (let attempt = 0; attempt < 100 && !(aliceSeat !== null && bobSeat !== null && acted && aliceReady && bobReady); attempt += 1) {
    await wait(100)
  }

  const aliceViews = aliceConn.messages.filter(message => message.type === 'view').map(message => message.view)
  const playing = aliceViews.find(view => view.phase === 'playing')
  if (playing === undefined) throw new Error(`table did not start: ${output}`)
  if (aliceSeat === null || bobSeat === null) throw new Error('missing viewer seats')
  if (playing.game === null) throw new Error('missing public game')
  if (playing.game.seats.flatMap(seat => seat.hole).length !== 2) throw new Error('expected exactly two visible hole cards')
  if (playing.game.seats.filter(seat => seat.inHand).some(seat => seat.holeCount !== 2)) {
    throw new Error('expected every live seat to hide two hole cards')
  }

  const errorMessages = [...aliceConn.messages, ...bobConn.messages].filter(message => message.type === 'error')
  if (errorMessages.length > 0) throw new Error(`websocket errors: ${JSON.stringify(errorMessages)}`)

  console.log('server smoke test passed')
  aliceConn.socket.close()
  bobConn.socket.close()
} catch (error) {
  console.error(error)
  console.error(output)
  process.exitCode = 1
} finally {
  child.kill('SIGTERM')
  await wait(500)
  if (child.exitCode === null) child.kill('SIGKILL')
  await rm(dataDir, { recursive: true, force: true })
}
