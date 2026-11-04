import React, { useEffect, useMemo, useState } from 'react'
import { formatTokenAmount } from '../engine/game.ts'
import type { LegalActions, PlayerAction } from '../engine/game.ts'
import type { PublicGame, RoomView } from '../room/room.ts'
import type { ClientMessage } from '../protocol/index.ts'
import type { ConnectionStatus } from './socket.ts'
import type { Translate } from './i18n.ts'
import { BankrollChips, PotChips, PlayingCard, SeatView, TableMark, seatFrom, type DisplaySeat } from './components.tsx'
import { AdminPanel } from './AdminPanel.tsx'
import { CosmeticsPanel } from './CosmeticsPanel.tsx'
import { CardArtProvider, cardArtCatalog, catalogIsEmpty } from './cardArt.tsx'

const EMPTY_SEAT: Omit<DisplaySeat, 'index'> = {
  name: '', stack: 0, hole: [], holeCount: 0, inHand: false, folded: false,
  allIn: false, streetBet: 0, result: null, connected: false, sittingOut: false,
  ready: false, isYou: false, occupied: false,
}

function mergeSeats(view: RoomView): DisplaySeat[] {
  return Array.from({ length: 8 }, (_, index) => {
    const publicSeat = view.game?.seats[index]
    if (publicSeat !== undefined && publicSeat.id !== '') return seatFrom(view.game?.seats ?? [], index)
    const lobby = view.players.find(player => player.seat === index)
    if (lobby === undefined) return { ...EMPTY_SEAT, index }
    return {
      ...EMPTY_SEAT,
      index,
      name: lobby.name,
      stack: lobby.stack,
      connected: lobby.connected,
      sittingOut: lobby.sittingOut,
      ready: lobby.ready,
      isYou: lobby.isYou,
      occupied: true,
    }
  })
}

function blindSeats(game: PublicGame | null): { small: number | null; big: number | null } {
  if (game === null) return { small: null, big: null }
  const inHand = game.seats.map((seat, index) => (seat.inHand ? index : -1)).filter(index => index >= 0)
  if (inHand.length < 2) return { small: null, big: null }
  const next = (from: number): number | null => {
    for (let step = 1; step <= game.seats.length; step += 1) {
      const index = (from + step) % game.seats.length
      if (game.seats[index]?.inHand === true) return index
    }
    return null
  }
  const small = inHand.length === 2 ? game.dealer : next(game.dealer)
  return { small, big: small === null ? null : next(small) }
}

function streetLabel(street: PublicGame['street'], t: Translate): string {
  switch (street) {
    case 'preflop': return t('roomStreetPreflop')
    case 'flop': return t('roomStreetFlop')
    case 'turn': return t('roomStreetTurn')
    case 'river': return t('roomStreetRiver')
    case 'hand-over': return t('roomStreetHandOver')
    default: return street
  }
}

function normalizedRaiseTo(value: number, legal: LegalActions, step: number): number {
  const bounded = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, value))
  const snapped = legal.minRaiseTo + Math.round((bounded - legal.minRaiseTo) / Math.max(1, step)) * Math.max(1, step)
  return Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, snapped))
}

function RaiseSizer({ legal, pot, currentBet, step, value, onChange, t }: {
  legal: LegalActions
  pot: number
  currentBet: number
  step: number
  value: number
  onChange: (value: number) => void
  t: Translate
}): React.ReactElement {
  const formatDraft = (amount: number): string => amount.toLocaleString('en-US')
  const [draft, setDraft] = useState(formatDraft(value))
  useEffect(() => { setDraft(formatDraft(value)) }, [value])
  const choose = (target: number): void => {
    const next = normalizedRaiseTo(target, legal, step)
    onChange(next)
    setDraft(formatDraft(next))
  }
  const potTarget = (fraction: number): number => currentBet + (pot + legal.toCall) * fraction
  const commitDraft = (): void => {
    const parsed = Number(draft.replaceAll(',', '').trim())
    if (Number.isFinite(parsed)) choose(parsed)
    else setDraft(formatDraft(value))
  }
  return (
    <div className="ai-raise-sizer" aria-label={t('raiseSizing')}>
      <div className="ai-raise-presets">
        <button type="button" onClick={() => { choose(legal.minRaiseTo) }}>{t('min')}</button>
        <button type="button" onClick={() => { choose(potTarget(0.5)) }}>{t('half')}</button>
        <button type="button" onClick={() => { choose(potTarget(0.75)) }}>{t('threeQuarter')}</button>
        <button type="button" onClick={() => { choose(potTarget(1)) }}>{t('pot')}</button>
        <button type="button" onClick={() => { choose(legal.maxRaiseTo) }}>{t('max')}</button>
      </div>
      <input
        className="ai-raise-range"
        type="range"
        min={legal.minRaiseTo}
        max={legal.maxRaiseTo}
        step={Math.max(1, step)}
        value={value}
        aria-label={t('raiseAmount')}
        onChange={event => { choose(Number(event.currentTarget.value)) }}
      />
      <label className="ai-raise-input">
        <span>{t('raiseTo')}</span>
        <input
          type="text"
          inputMode="numeric"
          value={draft}
          aria-label={t('raiseAmount')}
          onChange={event => { setDraft(event.currentTarget.value) }}
          onBlur={commitDraft}
          onKeyDown={event => { if (event.key === 'Enter') commitDraft() }}
        />
      </label>
    </div>
  )
}

export function RoomScreen({ view, status, send, t, language, onLanguage, dark, onTheme, adminUnlocked, onAdminUnlocked, onLogout }: {
  view: RoomView
  status: ConnectionStatus
  send: (message: ClientMessage) => boolean
  t: Translate
  language: 'en' | 'zh'
  onLanguage: () => void
  dark: boolean
  onTheme: () => void
  adminUnlocked: boolean
  onAdminUnlocked: (value: boolean) => void
  onLogout: () => void
}): React.ReactElement {
  const [playersOpen, setPlayersOpen] = useState(false)
  const [adminOpen, setAdminOpen] = useState(false)
  const [cosmeticsOpen, setCosmeticsOpen] = useState(false)
  const [raiseTo, setRaiseTo] = useState(0)

  const catalog = cardArtCatalog()
  const hasArt = !catalogIsEmpty(catalog)

  const game = view.game
  const seats = useMemo(() => mergeSeats(view), [view])
  const blinds = blindSeats(game)
  const rotation = view.viewerSeat ?? 0
  const you = seats.find(seat => seat.isYou) ?? null
  const legal = view.legal
  const heroTurn = view.canAct && legal !== null && game !== null

  useEffect(() => {
    if (legal !== null) setRaiseTo(legal.raiseTo)
  }, [legal?.raiseTo, view.handId, view.version])

  const act = (action: PlayerAction, target?: number): void => {
    if (view.handId === null) return
    const message: ClientMessage = target === undefined
      ? { type: 'act', handId: view.handId, version: view.version, action }
      : { type: 'act', handId: view.handId, version: view.version, action, raiseTo: target }
    send(message)
  }

  const sit = (seat: number): void => { send({ type: 'sit', seat }) }

  const phaseLabel = view.paused
    ? t('roomPaused')
    : game === null
      ? view.eligibleCount < 2 ? t('roomWaiting') : t('roomWaitingStart')
      : game.street === 'hand-over'
        ? t('roomShowdown')
        : streetLabel(game.street, t)

  const statusLabel = status === 'online' ? t('roomConnected') : status === 'connecting' ? t('roomConnecting') : t('roomOffline')
  const statusTone = status === 'online' ? 'ok' : 'warn'

  const actingSeat = game?.actingSeat ?? null
  const actingPlayer = actingSeat === null ? null : seats[actingSeat] ?? null
  const offlineActing = actingPlayer !== null && actingPlayer.occupied && !actingPlayer.connected

  const latestLogs = game?.logs ?? []
  const latest = latestLogs[latestLogs.length - 1] ?? t('roomLogEmpty')
  const previous = latestLogs.slice(-4, -1).join(' · ')

  const canSit = view.phase !== 'playing'

  return (
    <CardArtProvider catalog={catalog} cosmetics={view.cosmetics}>
    <section className="ai-overlay poker-room" role="region" aria-label={t('appName')}>
      <div className="ai-shell">
        <header className="ai-topbar">
          <div className="poker-brand-row">
            <span className="poker-brandmark">♠</span>
            <div className="ai-brand">
              <div className="ai-title">
                {t('appName')} · {formatTokenAmount(view.settings.smallBlind)}/{formatTokenAmount(view.settings.bigBlind)}
                {game !== null ? ` · #${game.handNumber}` : ''}
              </div>
              <div className="ai-subtitle">
                {phaseLabel}
                {view.phase === 'playing' || view.eligibleCount < 2 ? '' : ` · ${t('roomReadyCount', { ready: view.readyCount, eligible: view.eligibleCount })}`}
                {view.you?.seat !== null && view.you !== null ? ` · ${t('roomSeat', { seat: (view.you.seat ?? 0) + 1 })}` : ''}
              </div>
            </div>
          </div>
          <div className="poker-top-actions">
            <span className="poker-pill" data-tone={statusTone}>{statusLabel}</span>
            {view.paused ? <span className="poker-pill" data-tone="warn">{t('roomPaused')}</span> : null}
            <button type="button" className="poker-btn" data-size="sm" data-mobile="hide" onClick={() => { setPlayersOpen(true) }}>{t('roomPlayers')}</button>
            {hasArt ? (
              <button type="button" className="poker-btn" data-size="sm" onClick={() => { setCosmeticsOpen(true) }}>{t('cosmeticsShort')}</button>
            ) : null}
            <button type="button" className="poker-btn" data-size="sm" onClick={() => { setAdminOpen(true) }}>{t('roomAdmin')}</button>
            <button type="button" className="poker-btn" data-variant="ghost" data-size="sm" data-mobile="hide" data-compact="hide" onClick={onLanguage}>{language === 'zh' ? 'EN' : '中'}</button>
            <button
              type="button"
              className="poker-btn"
              data-variant="ghost"
              data-size="sm"
              data-mobile="hide"
              data-compact="hide"
              title={dark ? t('themeToLight') : t('themeToDark')}
              aria-label={dark ? t('themeToLight') : t('themeToDark')}
              onClick={onTheme}
            >
              {dark ? '☀' : '☾'}
            </button>
            {view.you !== null && view.you.seat !== null ? (
              <button type="button" className="poker-btn" data-size="sm" onClick={() => { send({ type: 'stand' }) }}>{t('roomLeave')}</button>
            ) : null}
            <button type="button" className="poker-btn" data-variant="ghost" data-size="sm" onClick={onLogout}>{t('logout')}</button>
          </div>
        </header>

        <main className="ai-stage">
          <div className="ai-table-wrap">
            <div className="ai-table">
              <div className="ai-felt-layout" aria-hidden>
                <span className="ai-felt-center" />
                <span className="ai-felt-orbit" />
                {[0, 1, 2, 3, 4, 5, 6, 7].map(position => <i key={position} data-pos={position} />)}
              </div>
              <TableMark />
            </div>

            {game !== null ? (
              <>
                <div className="ai-pot">
                  <PotChips amount={game.pot} bigBlind={game.bigBlind} />
                  <div className="ai-pot-copy">
                    <span className="ai-pot-label">{t('roomPot')}</span>
                    <span className="ai-pot-value">{formatTokenAmount(game.pot)}</span>
                  </div>
                </div>
                <div className="ai-board">
                  {[0, 1, 2, 3, 4].map(index => (
                    <PlayingCard key={index} card={game.board[index]} empty={game.board[index] === undefined} />
                  ))}
                </div>
              </>
            ) : view.eligibleCount < 2 ? (
              <div className="poker-center-note">
                <strong>{t('roomWaiting')}</strong>
                <span>{t('roomWaitingHint', { count: Math.max(0, 2 - view.eligibleCount) })}</span>
              </div>
            ) : null}

            {seats.map(seat => {
              const position = (seat.index - rotation + 8) % 8
              const badges: string[] = []
              if (game !== null) {
                if (game.dealer === seat.index) badges.push('D')
                if (blinds.small === seat.index) badges.push('SB')
                if (blinds.big === seat.index) badges.push('BB')
              }
              return (
                <SeatView
                  key={seat.index}
                  seat={seat}
                  position={position}
                  badges={badges}
                  acting={game?.actingSeat === seat.index}
                  hero={seat.isYou}
                  bigBlind={view.settings.bigBlind}
                  startingStack={view.settings.startingStack}
                  canSit={canSit}
                  onSit={sit}
                  t={t}
                />
              )
            })}

            {seats.map(seat => seat.folded && seat.hole.length > 0 ? (
              <div
                key={`muck-${seat.index}`}
                className="ai-mucked-hand"
                data-pos={(seat.index - rotation + 8) % 8}
                data-hero={String(seat.isYou)}
                aria-label={t('roomFolded')}
              >
                {seat.hole.map((card, index) => <PlayingCard key={`${card.rank}-${card.suit}-${index}`} card={card} />)}
                {seat.isYou ? <span className="ai-muck-label">{t('roomFolded')}</span> : null}
              </div>
            ) : null)}
          </div>

          {view.paused ? <div className="poker-banner" data-tone="warn">{t('roomPaused')} · {t('roomPausedHint')}</div> : null}
          {status !== 'online' ? <div className="poker-banner">{statusLabel}…</div> : null}
          {status === 'online' && offlineActing && actingPlayer !== null
            ? <div className="poker-banner" data-tone="warn">{t('roomWaitOffline', { name: actingPlayer.name })}</div>
            : null}
        </main>

        <footer className="ai-bottombar">
          <div className="ai-log"><strong>{latest}</strong>{previous}</div>
          <div className="ai-action-stack">
            {heroTurn && legal !== null ? (
              <RaiseSizer
                legal={legal}
                pot={game?.pot ?? 0}
                currentBet={game?.currentBet ?? 0}
                step={view.settings.smallBlind}
                value={raiseTo}
                onChange={setRaiseTo}
                t={t}
              />
            ) : null}
            {view.canAct && legal !== null ? (
              <div className="ai-controls">
                <button type="button" className="ai-action" data-danger="true" onClick={() => { act('fold') }}>{t('fold')}</button>
                <button type="button" className="ai-action" disabled={!legal.canCheck} onClick={() => { act('check') }}>{t('check')}</button>
                <button type="button" className="ai-action" disabled={!legal.canCall} onClick={() => { act('call') }}>
                  {t('call')} {formatTokenAmount(legal.toCall)}
                </button>
                <button type="button" className="ai-action" data-primary="true" disabled={!legal.canRaise} onClick={() => { act('raise', raiseTo) }}>
                  {t('raise')} {formatTokenAmount(raiseTo)}
                </button>
                <button type="button" className="ai-action" data-danger="true" disabled={!legal.canAllIn} onClick={() => { act('all-in') }}>{t('allIn')}</button>
              </div>
            ) : view.canReady ? (
              view.eligibleCount >= 2 ? (
                <div className="poker-ready" data-state={view.you?.ready === true ? 'ready' : 'action'}>
                  <div className="poker-ready-copy">
                    <strong>{view.phase === 'hand-over' ? t('roomShowdown') : t('roomWaitingStart')}</strong>
                    <span>
                      {view.readyCount >= view.eligibleCount
                        ? t('roomAllReady')
                        : view.you?.ready === true
                          ? t('roomWaitingOthers')
                          : t('roomReadyHint')}
                    </span>
                  </div>
                  <div className="poker-ready-actions">
                    {view.you?.ready === true ? (
                      <span className="poker-ready-badge">{t('roomReady')} ✓</span>
                    ) : (
                      <button type="button" className="poker-btn" data-variant="primary" onClick={() => { send({ type: 'ready' }) }}>
                        {t('roomNextHand')}
                      </button>
                    )}
                    <span className="poker-pill">{t('roomReadyCount', { ready: view.readyCount, eligible: view.eligibleCount })}</span>
                  </div>
                </div>
              ) : null
            ) : (
              <div className="ai-controls">
                <div className="ai-spectating">
                  <span className="ai-spectating-dot" />
                  {you === null
                    ? t('roomClickSeat')
                    : game?.street === 'hand-over'
                      ? t('roomShowdown')
                      : actingPlayer !== null && actingPlayer.name !== ''
                        ? t('roomActing', { name: actingPlayer.name })
                        : t('roomSpectating')}
                </div>
              </div>
            )}
          </div>
          <div className="ai-hand-meta">
            <strong>{heroTurn ? t('yourTurn') : phaseLabel}</strong>
            {t('roomBlinds')} {formatTokenAmount(view.settings.smallBlind)}/{formatTokenAmount(view.settings.bigBlind)}
            {' · '}{t('roomStack')} {formatTokenAmount(view.settings.startingStack)}
            {game !== null ? ` · #${game.handNumber}` : ''}
          </div>
        </footer>
      </div>

      {playersOpen ? (
        <div className="poker-drawer" role="dialog" aria-label={t('roomPlayers')}>
          <div className="poker-drawer-head">
            <strong>{t('roomPlayers')} · {view.players.length}</strong>
            <button type="button" className="poker-btn" data-size="sm" onClick={() => { setPlayersOpen(false) }}>{t('close')}</button>
          </div>
          <div className="poker-drawer-section">
            <h3>{t('roomStack')}</h3>
            {view.players.length === 0 ? <p className="poker-note">{t('roomNoPlayers')}</p> : null}
            {[...view.players].sort((a, b) => (a.seat ?? 99) - (b.seat ?? 99)).map(player => (
              <div key={player.id} className="poker-player-row" data-you={String(player.isYou)}>
                <div className="poker-player-main">
                  <span className="poker-player-name">
                    <i className="poker-dot" data-online={String(player.connected)} data-ready={String(player.ready)} />
                    {player.name}{player.isYou ? ` · ${t('roomYou')}` : ''}
                  </span>
                  <span className="poker-player-meta">
                    {player.seat === null ? t('roomSpectating') : t('roomSeat', { seat: player.seat + 1 })}
                    {' · '}{formatTokenAmount(player.stack)}
                    {player.sittingOut ? ` · ${t('roomSittingOut')}` : ''}
                  </span>
                </div>
                <span className="poker-pill" data-tone={player.connected ? (player.ready ? 'ok' : undefined) : 'bad'}>
                  {player.connected ? (player.ready ? t('roomReadyTag') : t('roomOnline')) : t('roomOfflineTag')}
                </span>
              </div>
            ))}
          </div>
          <button type="button" className="poker-btn" data-variant="ghost" onClick={onLogout}>{t('logout')}</button>
        </div>
      ) : null}

      {adminOpen ? (
        <AdminPanel
          view={view}
          send={send}
          t={t}
          catalog={catalog}
          unlocked={adminUnlocked}
          onUnlocked={onAdminUnlocked}
          onClose={() => { setAdminOpen(false) }}
        />
      ) : null}

      {cosmeticsOpen && hasArt ? (
        <CosmeticsPanel
          catalog={catalog}
          value={view.cosmetics}
          overridden={view.cosmeticsOverride !== null}
          onApply={cosmetics => { send({ type: 'setCosmetics', cosmetics }) }}
          onClose={() => { setCosmeticsOpen(false) }}
          t={t}
        />
      ) : null}
    </section>
    </CardArtProvider>
  )
}
