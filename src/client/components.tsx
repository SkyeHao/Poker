import React from 'react'
import type { Card } from '../engine/poker.ts'
import { cardText, isRed } from '../engine/poker.ts'
import { formatTokenAmount } from '../engine/game.ts'
import type { PublicSeat } from '../room/room.ts'
import type { Translate } from './i18n.ts'
import { backUrl, faceSetUrl, useCardArt } from './cardArt.tsx'

export function PlayingCard({ card, hidden = false, empty = false }: {
  card?: Card | undefined
  hidden?: boolean
  empty?: boolean
}): React.ReactElement {
  const art = useCardArt()
  if (empty) {
    return <span className="ai-card ai-card-empty"><span className="ai-card-mark">·</span></span>
  }
  if (hidden || card === undefined) {
    if (art.back !== undefined) {
      return (
        <span
          className="ai-card ai-card-back ai-card-art"
          aria-label="hidden card"
          style={{ backgroundImage: `url(${backUrl(art.back.id)})` }}
        />
      )
    }
    return <span className="ai-card ai-card-back"><span className="ai-card-mark">♠</span></span>
  }
  const faceSet = art.faceSets[card.suit]
  if (faceSet !== undefined && (card.rank === 11 || card.rank === 12 || card.rank === 13)) {
    const position = card.rank === 11 ? '0%' : card.rank === 12 ? '50%' : '100%'
    return (
      <span
        className="ai-card ai-card-face-art"
        role="img"
        aria-label={cardText(card)}
        style={{
          backgroundImage: `url(${faceSetUrl(card.suit, faceSet.id)})`,
          backgroundPosition: `${position} 0`,
        }}
      />
    )
  }
  const text = cardText(card)
  return (
    <span className="ai-card" data-red={String(isRed(card))}>
      <span className="ai-card-rank">{text.slice(0, -1)}</span>
      <span className="ai-card-suit">{text.slice(-1)}</span>
    </span>
  )
}

type ChipTone = 'blue' | 'ink' | 'red' | 'gold'

function ChipStack({ tone, height }: { tone: ChipTone; height: number }): React.ReactElement {
  return (
    <span className="ai-pot-chip-column" data-tone={tone}>
      {Array.from({ length: height }, (_, index) => <i key={index} />)}
    </span>
  )
}

export function BankrollChips({ amount, startingStack }: { amount: number; startingStack: number }): React.ReactElement | null {
  if (amount <= 0) return null
  const ratio = amount / Math.max(1, startingStack)
  const columns = Math.max(2, Math.min(4, Math.ceil(ratio * 4)))
  const peak = Math.max(3, Math.min(8, Math.ceil(ratio * 6)))
  const tones: readonly ChipTone[] = ['blue', 'ink', 'red', 'gold']
  return (
    <span className="ai-bankroll" aria-hidden>
      {Array.from({ length: columns }, (_, index) => (
        <ChipStack key={tones[index]} tone={tones[index] as ChipTone} height={Math.max(2, peak - index)} />
      ))}
    </span>
  )
}

export function PotChips({ amount, bigBlind, minimumLevel = 1 }: { amount: number; bigBlind: number; minimumLevel?: number }): React.ReactElement {
  const level = Math.max(minimumLevel, Math.min(6, Math.ceil(amount / Math.max(1, bigBlind * 3))))
  const stacks = Math.max(1, Math.min(3, Math.ceil(level / 2)))
  return (
    <span className="ai-pot-chips" aria-hidden>
      <ChipStack tone="blue" height={Math.min(6, level + 1)} />
      {stacks >= 2 ? <ChipStack tone="ink" height={Math.max(3, level - 1)} /> : null}
      {stacks >= 3 ? <ChipStack tone="red" height={Math.max(2, level - 2)} /> : null}
    </span>
  )
}

export function TableMark(): React.ReactElement {
  return (
    <div className="ai-table-logo">
      <span className="ai-card-mark">♠</span>
      <span>POKER ROOM</span>
    </div>
  )
}

export interface DisplaySeat {
  index: number
  name: string
  stack: number
  hole: readonly Card[]
  holeCount: number
  inHand: boolean
  folded: boolean
  allIn: boolean
  streetBet: number
  result: string | null
  connected: boolean
  sittingOut: boolean
  ready: boolean
  isYou: boolean
  occupied: boolean
}

export function seatFrom(seats: readonly PublicSeat[], index: number): DisplaySeat {
  const seat = seats[index]
  if (seat === undefined) {
    return {
      index, name: '', stack: 0, hole: [], holeCount: 0, inHand: false, folded: false,
      allIn: false, streetBet: 0, result: null, connected: false, sittingOut: false,
      ready: false, isYou: false, occupied: false,
    }
  }
  return {
    index,
    name: seat.name,
    stack: seat.stack,
    hole: seat.hole,
    holeCount: seat.holeCount,
    inHand: seat.inHand,
    folded: seat.folded,
    allIn: seat.allIn,
    streetBet: seat.streetBet,
    result: seat.result,
    connected: seat.connected,
    sittingOut: seat.sittingOut,
    ready: seat.ready,
    isYou: seat.isYou,
    occupied: seat.id !== '',
  }
}

export function SeatView({ seat, position, badges, acting, hero, bigBlind, startingStack, canSit, onSit, t }: {
  seat: DisplaySeat
  position: number
  badges: readonly string[]
  acting: boolean
  hero: boolean
  bigBlind: number
  startingStack: number
  canSit: boolean
  onSit: (seat: number) => void
  t: Translate
}): React.ReactElement {
  const angle = (position / 8) * Math.PI * 2
  // The felt is shorter than the seat ellipse, so the top-centre seat would
  // float above the table edge. Pull position 4 onto the same row as the two
  // upper-corner seats.
  const radiusY = position === 4 ? 23.5 : 33
  const style: React.CSSProperties = {
    left: `${50 - 33 * Math.sin(angle)}%`,
    top: `${50 + radiusY * Math.cos(angle)}%`,
  }

  if (!seat.occupied) {
    return (
      <div className="ai-seat" data-pos={position} data-empty="true" style={style}>
        <div
          className="ai-player"
          role={canSit ? 'button' : undefined}
          tabIndex={canSit ? 0 : undefined}
          onClick={canSit ? () => { onSit(seat.index) } : undefined}
          onKeyDown={canSit ? event => { if (event.key === 'Enter' || event.key === ' ') onSit(seat.index) } : undefined}
          title={canSit ? t('roomSit') : undefined}
        >
          <span className="ai-avatar" data-character={position % 6}>+</span>
          <span className="ai-player-meta">
            <span className="ai-player-name">{t('roomEmptySeat')}</span>
            <span className="ai-stack">{t('roomSeat', { seat: seat.index + 1 })}</span>
          </span>
          {canSit ? <span className="ai-badges"><span className="ai-badge">{t('roomSit')}</span></span> : <span />}
        </div>
      </div>
    )
  }

  const hiddenCount = seat.hole.length === 0 ? seat.holeCount : 0
  return (
    <div
      className="ai-seat"
      data-pos={position}
      data-folded={String(seat.folded)}
      data-hero={String(hero)}
      data-acting={String(acting)}
      style={style}
    >
      <div className="ai-hole">
        {seat.hole.map((card, index) => (
          <PlayingCard key={`${card.rank}-${card.suit}-${index}`} card={card} />
        ))}
        {hiddenCount > 0
          ? Array.from({ length: hiddenCount }, (_, index) => <PlayingCard key={`back-${index}`} hidden />)
          : null}
      </div>
      {seat.streetBet > 0 ? (
        <div className="ai-bet">
          <PotChips amount={seat.streetBet} bigBlind={bigBlind} minimumLevel={3} />
          <span className="ai-bet-value">{formatTokenAmount(seat.streetBet)}</span>
        </div>
      ) : null}
      <BankrollChips amount={seat.stack} startingStack={startingStack} />
      <div className="ai-player">
        <span className="ai-avatar" data-character={position % 6} title={seat.connected ? t('roomOnline') : t('roomOfflineTag')}>
          {hero ? <span className="ai-card-mark">♠</span> : null}
        </span>
        <span className="ai-player-meta">
          <span className="ai-player-name">
            {seat.name}
            {seat.isYou ? ` · ${t('roomYou')}` : ''}
            {!seat.connected ? <i className="poker-dot" title={t('roomOfflineTag')} /> : null}
          </span>
          <span className="ai-stack">
            {formatTokenAmount(seat.stack)}
            {seat.sittingOut ? ` · ${t('roomSittingOut')}` : ''}
            {seat.allIn ? ` · ${t('roomAllIn')}` : ''}
          </span>
        </span>
        {badges.length > 0 ? (
          <span className="ai-badges">
            {badges.map(badge => <span key={badge} className="ai-badge" data-role={badge}>{badge}</span>)}
          </span>
        ) : <span />}
      </div>
      {seat.result !== null && seat.result !== '' ? <div className="ai-result">{seat.result}</div> : null}
    </div>
  )
}
