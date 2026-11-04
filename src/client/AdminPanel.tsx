import React, { useEffect, useState } from 'react'
import { formatTokenAmount } from '../engine/game.ts'
import type { RoomView } from '../room/room.ts'
import type { AdminCommand, ClientMessage } from '../protocol/index.ts'
import type { Translate } from './i18n.ts'
import { CosmeticsPicker } from './CosmeticsPanel.tsx'
import { EMPTY_COSMETICS, catalogIsEmpty, type CardArtCatalog } from './cardArt.tsx'

export function AdminPanel({ view, send, t, catalog, unlocked, onUnlocked, onClose }: {
  view: RoomView
  send: (message: ClientMessage) => boolean
  t: Translate
  catalog: CardArtCatalog
  unlocked: boolean
  onUnlocked: (value: boolean) => void
  onClose: () => void
}): React.ReactElement {
  const [key, setKey] = useState('')
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [smallBlind, setSmallBlind] = useState(String(view.settings.smallBlind))
  const [bigBlind, setBigBlind] = useState(String(view.settings.bigBlind))
  const [startingStack, setStartingStack] = useState(String(view.settings.startingStack))

  useEffect(() => { setSmallBlind(String(view.settings.smallBlind)) }, [view.settings.smallBlind])
  useEffect(() => { setBigBlind(String(view.settings.bigBlind)) }, [view.settings.bigBlind])
  useEffect(() => { setStartingStack(String(view.settings.startingStack)) }, [view.settings.startingStack])

  const admin = (command: AdminCommand): void => { send({ type: 'admin', command }) }
  const seated = [...view.players].filter(player => player.seat !== null).sort((a, b) => (a.seat ?? 99) - (b.seat ?? 99))

  const amountFor = (playerId: string): number => {
    const raw = amounts[playerId]
    const parsed = raw === undefined ? Number.NaN : Number(raw.replaceAll(',', '').trim())
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0
  }

  if (!unlocked) {
    return (
      <div className="poker-modal-backdrop" role="presentation" onClick={onClose}>
        <div className="poker-modal" role="dialog" aria-modal="true" aria-label={t('adminTitle')} onClick={event => { event.stopPropagation() }}>
          <div className="poker-modal-head">
            <h2>{t('adminTitle')}</h2>
            <button type="button" className="poker-btn" data-size="sm" onClick={onClose}>{t('close')}</button>
          </div>
          <p className="poker-note">{t('adminUnlockHint')}</p>
          <form
            className="poker-form"
            onSubmit={event => {
              event.preventDefault()
              if (key.trim().length === 0) return
              send({ type: 'adminUnlock', key: key.trim() })
            }}
          >
            <label className="poker-field">
              <span>{t('adminKey')}</span>
              <input className="poker-input" type="password" autoComplete="off" value={key} onChange={event => { setKey(event.currentTarget.value) }} />
            </label>
            <div className="poker-admin-actions">
              <button type="submit" className="poker-btn" data-variant="primary">{t('adminUnlock')}</button>
              <button type="button" className="poker-btn" data-variant="ghost" onClick={onClose}>{t('cancel')}</button>
            </div>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div className="poker-modal-backdrop" role="presentation" onClick={onClose}>
      <div className="poker-modal" role="dialog" aria-modal="true" aria-label={t('adminTitle')} onClick={event => { event.stopPropagation() }}>
        <div className="poker-modal-head">
          <div>
            <h2>{t('adminTitle')}</h2>
            <p className="poker-note">{t('adminUnlocked')}</p>
          </div>
          <div className="poker-admin-actions">
            <button type="button" className="poker-btn" data-size="sm" onClick={() => { onUnlocked(false) }}>{t('adminLock')}</button>
            <button type="button" className="poker-btn" data-size="sm" onClick={onClose}>{t('close')}</button>
          </div>
        </div>

        <section className="poker-drawer-section">
          <h3>{t('adminTable')}</h3>
          <div className="poker-admin-actions">
            <button
              type="button"
              className="poker-btn"
              onClick={() => {
                if (window.confirm(t('adminConfirmRedeal'))) admin({ type: 'redeal' })
              }}
            >
              {t('adminRedeal')}
            </button>
            <button
              type="button"
              className="poker-btn"
              data-variant="danger"
              onClick={() => {
                if (window.confirm(t('adminConfirmResetTable'))) admin({ type: 'resetTable' })
              }}
            >
              {t('adminResetTable')}
            </button>
            <button type="button" className="poker-btn" onClick={() => { admin({ type: 'pause', paused: !view.paused }) }}>
              {view.paused ? t('adminResume') : t('adminPause')}
            </button>
          </div>
          <div className="poker-admin-grid">
            <label className="poker-field">
              <span>{t('adminBlinds')}</span>
              <div className="poker-admin-row">
                <input className="poker-input" inputMode="numeric" value={smallBlind} onChange={event => { setSmallBlind(event.currentTarget.value) }} />
                <input className="poker-input" inputMode="numeric" value={bigBlind} onChange={event => { setBigBlind(event.currentTarget.value) }} />
                <button
                  type="button"
                  className="poker-btn"
                  data-size="sm"
                  onClick={() => {
                    const small = Number(smallBlind)
                    const big = Number(bigBlind)
                    if (!Number.isFinite(small) || !Number.isFinite(big)) return
                    admin({ type: 'setBlinds', smallBlind: Math.trunc(small), bigBlind: Math.trunc(big) })
                  }}
                >
                  {t('adminApply')}
                </button>
              </div>
            </label>
            <label className="poker-field">
              <span>{t('adminStartingStack')}</span>
              <div className="poker-admin-row">
                <input className="poker-input" inputMode="numeric" value={startingStack} onChange={event => { setStartingStack(event.currentTarget.value) }} />
                <button
                  type="button"
                  className="poker-btn"
                  data-size="sm"
                  onClick={() => {
                    const value = Number(startingStack)
                    if (Number.isFinite(value)) admin({ type: 'setStartingStack', startingStack: Math.trunc(value) })
                  }}
                >
                  {t('adminApply')}
                </button>
              </div>
            </label>
          </div>
        </section>

        {!catalogIsEmpty(catalog) ? (
          <section className="poker-drawer-section">
            <h3>{t('adminCosmetics')}</h3>
            <p className="poker-note">{t('adminCosmeticsHint')}</p>
            {view.cosmeticsOverride !== null
              ? <p className="poker-pill" data-tone="warn">{t('adminCosmeticsActive')}</p>
              : null}
            <CosmeticsPicker
              catalog={catalog}
              value={view.cosmeticsOverride ?? EMPTY_COSMETICS}
              onChange={cosmetics => { admin({ type: 'setTableCosmetics', cosmetics }) }}
              t={t}
            />
            {view.cosmeticsOverride !== null ? (
              <div className="poker-admin-actions">
                <button
                  type="button"
                  className="poker-btn"
                  data-variant="ghost"
                  onClick={() => { admin({ type: 'setTableCosmetics', cosmetics: null }) }}
                >
                  {t('adminCosmeticsClear')}
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="poker-drawer-section">
          <h3>{t('adminPlayers')}</h3>
          {seated.length === 0 ? <p className="poker-note">{t('adminNoPlayers')}</p> : null}
          {seated.map(player => (
            <div key={player.id} className="poker-admin-player">
              <div className="poker-admin-player-head">
                <strong>{player.name}{player.isYou ? ` · ${t('roomYou')}` : ''}</strong>
                <span>{t('adminSeat', { seat: (player.seat ?? 0) + 1 })} · {formatTokenAmount(player.stack)}</span>
              </div>
              <div className="poker-admin-row">
                <input
                  className="poker-input"
                  inputMode="numeric"
                  placeholder={t('adminAmount')}
                  value={amounts[player.id] ?? ''}
                  onChange={event => {
                    const value = event.currentTarget.value
                    setAmounts(current => ({ ...current, [player.id]: value }))
                  }}
                />
                <button
                  type="button"
                  className="poker-btn"
                  data-size="sm"
                  onClick={() => {
                    const amount = amountFor(player.id)
                    if (amount > 0) admin({ type: 'topUp', playerId: player.id, amount })
                  }}
                >
                  {t('adminTopUp')}
                </button>
                <button
                  type="button"
                  className="poker-btn"
                  data-size="sm"
                  onClick={() => {
                    const raw = amounts[player.id]
                    const stack = raw === undefined ? Number.NaN : Number(raw)
                    if (Number.isFinite(stack) && stack >= 0) admin({ type: 'setStack', playerId: player.id, stack: Math.trunc(stack) })
                  }}
                >
                  {t('adminSetStack')}
                </button>
                <button type="button" className="poker-btn" data-size="sm" onClick={() => { admin({ type: 'forceAction', playerId: player.id, action: 'check' }) }}>
                  {t('adminForceCheck')}
                </button>
                <button type="button" className="poker-btn" data-size="sm" onClick={() => { admin({ type: 'forceAction', playerId: player.id, action: 'fold' }) }}>
                  {t('adminForceFold')}
                </button>
                <button
                  type="button"
                  className="poker-btn"
                  data-size="sm"
                  data-variant="danger"
                  onClick={() => {
                    if (window.confirm(t('adminConfirmKick', { name: player.name }))) admin({ type: 'kick', playerId: player.id })
                  }}
                >
                  {t('adminKick')}
                </button>
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  )
}
