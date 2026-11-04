# Poker Room

Single-room, server-authoritative Texas Hold'em for 2–8 friends. Node.js + Fastify + WebSocket on the server, React + Vite in the browser, JSON files on disk. No database, no bots, no real money.

The product and security decisions live in [SPEC.md](SPEC.md); this file covers how to run, test and deploy the app.

## Features

- Invite-only room by default (nickname + 4-digit PIN, long-lived HttpOnly token).
- Invite management: create per-group links, revoke them (kept in the list for audit) or delete them permanently.
- 2–8 seats, no action timer; a disconnected player pauses the table instead of being auto-folded.
- Hands, blinds, side pots, showdown and chip conservation handled by a pure engine.
- Server-side view redaction: the deck never leaves the server, opponents' hole cards are only revealed at showdown.
- Disconnect/reconnect keeps seat, stack and hole cards; server restart restores the room and pauses a live hand.
- Two admin channels: `/admin` account (invites, join-open, room reset) and in-table `TABLE_ADMIN_KEY` (redeal, reset table, top-up, kick, pause, forced action).
- Three reset levels (redeal hand / reset table / reset room) with different blast radius.
- Chinese + English UI, dark/light theme, mobile layout.

## Requirements

- Node.js 22 or newer (the repo uses `node --import tsx --test`).
- npm (a `package-lock.json` is committed).
- Optional for production: Caddy, systemd, a domain.

## Architecture

```
src/
├─ engine/       pure Texas Hold'em rules: cards, hand ranking, betting rounds, side pots
├─ protocol/     Zod schemas = single source of truth; z.infer types for commands and WS frames
├─ room/         pure room reducer, split into:
│   ├─ types.ts      RoomState / PlayerRecord / createRoom
│   ├─ selectors.ts  eligibility, seats, hand id, display stack
│   ├─ commands.ts   apply(room, command, ctx) and all handlers
│   └─ view.ts       viewFor(room, viewerId) — the only place that redacts cards
├─ server/       Fastify adapters:
│   ├─ config.ts     env parsing + PUBLIC_URL / POKER_BASE validation
│   ├─ app.ts        createServer(options) — routes, WS, persistence wiring
│   ├─ index.ts      process bootstrap (listen + signals)
│   ├─ store.ts      atomic room.json / admin.json / audit JSONL
│   └─ security.ts   scrypt, SHA-256, constant-time compare, rate limiter
└─ client/       React UI (Vite root)
```

Dependency direction is `client → room` (view types), `client → protocol` (wire and HTTP types), and both reach down to `engine`; `server → room` and `server → protocol`. `engine` has no imports from the other layers. The one business seam is:

```ts
apply(room, command, ctx) -> { room, events, error }
```

`version` is incremented only when state an action depends on changes: the current hand, phase, pause flag or readiness round. Presence changes (connect, disconnect, token rotation), joining, seat moves and between-hand stack edits do not invalidate an in-flight action.

## Quick start (development)

```bash
npm install

# Create the permanent administrator (writes data/admin.json; password >= 12 chars).
npm run admin:create -- admin "change-this-password"

# Terminal 1 + 2 in one command: Fastify on :3000, Vite on :5173.
npm run dev
```

Open <http://localhost:5173>. The room starts invite-only, so either:

1. sign in at <http://localhost:5173/admin>, create an invite and open the generated link, or
2. turn on **Allow joining without an invite** in the admin console.

`npm run dev` runs `tsx watch src/server/index.ts` and `vite` with `/api` and `/ws` proxied to `:3000`.

> The app does not load `.env` automatically. Copy [.env.example](.env.example) for reference, but export the variables in your shell or let systemd provide them.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | server watch + Vite dev server |
| `npm run build` | `vite build` + esbuild bundle `dist/server.js` |
| `npm start` | `node dist/server.js` |
| `npm test` | engine/room/store/config/server tests + WebSocket smoke test |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run smoke:server` | spawn a real server, join two players over WS, assert redaction |
| `npm run admin:create -- <user> <password>` | bootstrap `data/admin.json` |

## Card art

The client ships with 16 deck backs and 24 *Friends of Jimbo* face sets (72 face cards). They live in `src/client/assets/card-art/` and are imported at build time (`import.meta.glob` + `?url`), so Vite inlines the small ones as data URIs and emits the rest into `dist/public/assets/`. Anything that ships `dist/` therefore carries the art with it — there is no separate folder to copy and no runtime manifest request.

Each player picks a card back and one face set per suit from the in-table **Style** button. Face cards always stay personal; the in-table admin key can only pin the table card back for everyone. Both are stored on the room record, so they survive reconnects and restarts.

```
src/client/assets/card-art/
├─ manifest.json                 # { backs: [{id,label}], faces: [{suit,id,label}] }
├─ backs/<id>.png                # 71x95 card back
└─ faces/<suit>-<id>.png         # 426x190 sprite of J, Q, K (142x190 each)
```

Only entries whose file is present in the bundle are offered, so a partial set degrades gracefully to the CSS-drawn cards.

Regenerate the folder from the raw downloads in `assets-private/` (git-ignored):

```bash
node scripts/build-card-art.mjs
```

The art is third-party fan material (Balatro deck backs and *Friends of Jimbo* collaborations). It is fine for a private table among friends; don't publish the build or the repository publicly.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | HTTP/WS port |
| `HOST` | `0.0.0.0` | bind address; production usually `127.0.0.1` behind Caddy |
| `NODE_ENV` | — | `production` requires `PUBLIC_URL` |
| `DATA_DIR` | `./data` | `room.json`, `admin.json`, `admin-audit.jsonl` |
| `PUBLIC_DIR` | `./dist/public` | built client; SPA fallback serves `index.html` |
| `PUBLIC_URL` | — | **full** public base including sub-path, no trailing slash, e.g. `https://host/poker`; used for invite links. Required in production and whenever `POKER_BASE` is set. |
| `POKER_BASE` | `/` | Vite build base **and** runtime check, e.g. `/poker/` |
| `COOKIE_SECURE` | `true` in production | set `false` only for plain-HTTP local testing |
| `TRUST_PROXY` | `true` | set `false` if not behind a reverse proxy |
| `SESSION_SECRET` | random | signs admin cookies; without it, admin sessions die on restart |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | — | one-time bootstrap of `data/admin.json` (password >= 12 chars) |
| `TABLE_ADMIN_KEY` | empty | in-table admin key; empty disables that channel |

Startup validation fails fast when `PUBLIC_URL` is missing in production, or when `POKER_BASE` is a sub-path and `PUBLIC_URL` does not end with it. This guarantees invite links point at the app rather than at a bare origin.

## Production build and run

```bash
# Build once; the base must match the public path.
POKER_BASE=/poker/ npm run build

# Runtime configuration (systemd EnvironmentFile / exported shell vars).
export NODE_ENV=production
export PORT=3100
export HOST=127.0.0.1
export PUBLIC_URL=https://tangping.work:8443/poker
export POKER_BASE=/poker/
export SESSION_SECRET=<32+ random bytes>
export TABLE_ADMIN_KEY=<another long random value>
export ADMIN_USERNAME=admin
export ADMIN_PASSWORD=<strong password>

node dist/server.js
```

On Windows PowerShell use `$env:POKER_BASE = '/poker/'` before `npm run build`.

The server serves `PUBLIC_DIR` at `/` and upgrades `/ws`. When mounted under a sub-path, the reverse proxy must strip the prefix before forwarding (Caddy `handle_path` below does this), because the app itself has no knowledge of the mount point at request time.

### systemd + Caddy

Templates live in [`deploy/`](deploy/):

- [`deploy/poker-room.service`](deploy/poker-room.service) — systemd unit (`/srv/poker`, user `poker`, data-only write access).
- [`deploy/poker.env.example`](deploy/poker.env.example) — production environment file.
- [`deploy/Caddyfile`](deploy/Caddyfile) — `handle_path /poker/*` reverse proxy with WebSocket support.

Typical server layout:

```
/srv/poker/
├─ dist/            # built server.js + public/
├─ node_modules/    # production dependencies (dist/server.js externalizes packages)
├─ data/            # room.json, admin.json, admin-audit.jsonl (writable)
└─ poker.env        # chmod 600
```

Deploy steps (abbreviated):

```bash
# Option A: build locally (dev dependencies required), then ship the output.
POKER_BASE=/poker/ npm run build
rsync -av --exclude node_modules --exclude data ./ user@host:/srv/poker/
ssh user@host
cd /srv/poker
npm ci --omit=dev
sudo systemctl restart poker-room
```

```bash
# Option B: build on the server, then drop dev dependencies.
cd /srv/poker
npm ci
POKER_BASE=/poker/ npm run build
npm prune --omit=dev
sudo systemctl restart poker-room
```

Adjust `ExecStart` in [`deploy/poker-room.service`](deploy/poker-room.service) to the server's real Node path (`command -v node`) and create the `poker` user before enabling the unit. Ensure `/srv/poker/data` exists and is owned by the service user. Back up `data/admin.json` and `data/room.json`; `admin-audit.jsonl` is append-only.

## Data and resets

| Action | Scope |
| --- | --- |
| Redeal hand | refund each player's current-hand `committed`, reshuffle, keep seats and blinds |
| Reset table | drop the hand, restore `startingStack` for seated players, keep accounts/seats/invites |
| Reset room | delete players, PINs/tokens, seats, invites and the hand; `epoch + 1` invalidates old tokens; admin account and audit log survive |

`room.json` is written atomically (temp file + rename) with a 200 ms debounce and flushed on shutdown. On boot, every player is marked offline; a live hand is restored as paused.

## Tests

```bash
npm test              # 50 tests + smoke
npm run typecheck
```

- `tests/game.test.ts` — seeded RNG, 2–8 seats, betting rules, side pots, chip conservation.
- `tests/room.test.ts` — invites, readiness, redaction, resets, permissions, stale commands, version semantics.
- `tests/store.test.ts` — `room.json`/`admin.json` round-trip, corrupt-file recovery, debounced flush.
- `tests/config.test.ts` — `PUBLIC_URL`/`POKER_BASE`/`PORT` validation.
- `tests/server.test.ts` — Fastify `inject` HTTP flow (invite, PIN rotation) and a real WebSocket hand + reconnect.
- `scripts/smoke-server.mjs` — black-box server boot with two WS clients; runs as part of `npm test`.

## Security notes

- PINs and tokens are stored as scrypt / SHA-256 hashes; invites only as SHA-256. Comparisons are constant-time where it matters.
- Player and admin cookies are `HttpOnly`, `SameSite=Lax`, signed (admin), and `Secure` in production.
- WebSocket handshakes require a valid player cookie; the table key only unlocks the current connection.
- CSP, `no-referrer`, `X-Frame-Options: DENY` and `noindex` are set on every response.
- Rate limits: join per IP, admin login per IP, table-key unlock per player, PIN failures per player (5 tries → 10 min lock).
- Caddy Basic Auth is an optional outer gate and is intentionally not implemented in the app.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Startup exits with `PUBLIC_URL is required` | set `PUBLIC_URL` (production or any `POKER_BASE` sub-path) |
| Invite link points to the wrong host/path | `PUBLIC_URL` must include the sub-path, e.g. `https://host:8443/poker` |
| `/admin` back link or assets 404 under a sub-path | rebuild with the matching `POKER_BASE`, and use `handle_path` so the prefix is stripped |
| `503 Client build is missing` | run `npm run build` or fix `PUBLIC_DIR` |
| Admin login says no administrator configured | set `ADMIN_USERNAME`/`ADMIN_PASSWORD` on first boot or run `npm run admin:create` |
| Players stuck on "Reconnecting" | check `/ws` proxy/upgrade config and cookie `Secure` flag vs HTTP |
