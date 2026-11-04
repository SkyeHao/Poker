import React, { useEffect, useState } from 'react'
import { formatTokenAmount } from '../engine/game.ts'
import type { RoomSummary } from './api.ts'
import type { Translate } from './i18n.ts'

export function JoinScreen({ room, inviteCode, error, busy, notice, t, language, onLanguage, dark, onTheme, onJoin }: {
  room: RoomSummary | null
  inviteCode: string
  error: string | null
  busy: boolean
  notice: string | null
  t: Translate
  language: 'en' | 'zh'
  onLanguage: () => void
  dark: boolean
  onTheme: () => void
  onJoin: (name: string, pin: string, invite: string) => void
}): React.ReactElement {
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [invite, setInvite] = useState(inviteCode)
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => { setInvite(inviteCode) }, [inviteCode])

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed.length === 0) { setLocalError(t('errorName')); return }
    if (!/^\d{4}$/.test(pin)) { setLocalError(t('errorPinFormat')); return }
    setLocalError(null)
    onJoin(trimmed, pin, invite.trim())
  }

  const shownError = error ?? localError

  return (
    <div className="poker-auth">
      <div className="poker-auth-card">
        <div className="poker-auth-head">
          <div className="poker-brand-row">
            <span className="poker-brandmark">♠</span>
            <div>
              <h1>{t('joinTitle')}</h1>
              <p>{t('tagline')}</p>
            </div>
          </div>
          <p>{t('joinSubtitle')}</p>
        </div>

        {room !== null ? (
          <div className="poker-admin-actions">
            <span className="poker-pill" data-tone={room.joinOpen ? 'ok' : 'warn'}>
              {room.joinOpen ? t('roomJoinOpen') : t('roomJoinClosed')}
            </span>
            <span className="poker-pill">
              {formatTokenAmount(room.smallBlind)}/{formatTokenAmount(room.bigBlind)}
            </span>
            <span className="poker-pill">{room.players}/{room.seats} · {t('seatsOpen', { count: Math.max(0, room.seats - room.players) })}</span>
          </div>
        ) : null}

        {notice !== null ? <p className="poker-error">{notice}</p> : null}
        {room !== null && !room.joinOpen ? <p className="poker-note">{t('roomClosed')}</p> : null}

        <form className="poker-form" onSubmit={submit}>
          <label className="poker-field">
            <span>{t('name')}</span>
            <input
              className="poker-input"
              value={name}
              maxLength={24}
              autoComplete="nickname"
              placeholder={t('namePlaceholder')}
              onChange={event => { setName(event.currentTarget.value) }}
            />
          </label>
          <label className="poker-field">
            <span>{t('pin')}</span>
            <input
              className="poker-input"
              value={pin}
              inputMode="numeric"
              maxLength={4}
              autoComplete="off"
              placeholder={t('pinPlaceholder')}
              onChange={event => { setPin(event.currentTarget.value.replace(/\D/g, '').slice(0, 4)) }}
            />
            <small>{t('pinHint')}</small>
          </label>
          <label className="poker-field">
            <span>{t('invite')} · {t('inviteOptional')}</span>
            <input
              className="poker-input"
              value={invite}
              autoComplete="off"
              onChange={event => { setInvite(event.currentTarget.value.trim()) }}
            />
            <small>{t('inviteHint')}</small>
          </label>

          {shownError !== null ? <p className="poker-error">{shownError}</p> : null}

          <button type="submit" className="poker-btn" data-variant="primary" disabled={busy}>
            {busy ? t('joining') : t('join')}
          </button>
        </form>

        <div className="poker-auth-actions">
          <button
            type="button"
            className="poker-btn"
            data-variant="ghost"
            data-size="sm"
            title={dark ? t('themeToLight') : t('themeToDark')}
            aria-label={dark ? t('themeToLight') : t('themeToDark')}
            onClick={onTheme}
          >
            <span aria-hidden>{dark ? '☀' : '☾'}</span>
            <span>{dark ? t('themeLight') : t('themeDark')}</span>
          </button>
          <div className="poker-lang">
            <button type="button" data-active={language === 'zh'} onClick={onLanguage}>{language === 'zh' ? '中文' : 'English'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
