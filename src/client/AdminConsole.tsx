import React, { useEffect, useMemo, useState } from 'react'
import { formatTokenAmount } from '../engine/game.ts'
import { api, BASE, type CreateInviteInput, type CreateInviteResult, type InviteMeta, type RoomSummary } from './api.ts'
import { detectLanguage, createTranslator, type Language } from './i18n.ts'
import { localizeError } from './errors.ts'

function formatDate(timestamp: number, language: Language): string {
  return new Date(timestamp).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')
}

export function AdminConsole(): React.ReactElement {
  const [language, setLanguage] = useState<Language>(() => detectLanguage())
  const t = useMemo(() => createTranslator(language), [language])
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark')

  const [loading, setLoading] = useState(true)
  const [admin, setAdmin] = useState(false)
  const [room, setRoom] = useState<RoomSummary | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [invites, setInvites] = useState<InviteMeta[]>([])
  const [created, setCreated] = useState<CreateInviteResult | null>(null)
  const [copied, setCopied] = useState(false)
  const [resetText, setResetText] = useState('')
  const [form, setForm] = useState({ label: '', nickname: '', maxUses: '1', expiresInHours: '' })

  useEffect(() => {
    localStorage.setItem('poker.lang', language)
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
  }, [language])

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    localStorage.setItem('poker.theme', dark ? 'dark' : 'light')
  }, [dark])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const me = await api.me()
        if (!alive) return
        setAdmin(me.admin)
        setRoom(me.room)
        if (me.admin) {
          const result = await api.invites()
          if (alive) setInvites(result.invites)
        }
      } catch (cause) {
        if (alive) setError(localizeError(cause, t))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadInvites = async (): Promise<void> => {
    const result = await api.invites()
    setInvites(result.invites)
  }

  const login = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.adminLogin(username.trim(), password)
      setAdmin(true)
      setPassword('')
      const me = await api.me()
      setRoom(me.room)
      await loadInvites()
    } catch (cause) {
      setError(localizeError(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const logout = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.adminLogout()
    } finally {
      setAdmin(false)
      setInvites([])
      setCreated(null)
      setBusy(false)
    }
  }

  const createInvite = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const input: CreateInviteInput = {}
      if (form.label.trim() !== '') input.label = form.label.trim()
      if (form.nickname.trim() !== '') input.nickname = form.nickname.trim()
      const maxUses = Number(form.maxUses)
      if (Number.isFinite(maxUses) && maxUses >= 1) input.maxUses = Math.trunc(maxUses)
      const expires = Number(form.expiresInHours)
      if (form.expiresInHours.trim() !== '' && Number.isFinite(expires) && expires >= 1) input.expiresInHours = Math.trunc(expires)
      const result = await api.createInvite(input)
      setCreated(result)
      setForm({ label: '', nickname: '', maxUses: '1', expiresInHours: '' })
      await loadInvites()
    } catch (cause) {
      setError(localizeError(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      await api.revokeInvite(id)
      await loadInvites()
    } catch (cause) {
      setError(localizeError(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (invite: InviteMeta): Promise<void> => {
    const label = invite.label !== '' ? invite.label : invite.id.slice(0, 8)
    if (!window.confirm(t('confirmDeleteInvite', { label }))) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteInvite(invite.id)
      setCreated(current => current !== null && current.invite.id === invite.id ? null : current)
      await loadInvites()
    } catch (cause) {
      setError(localizeError(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const revokeAll = async (): Promise<void> => {
    if (!window.confirm(t('revokeAll'))) return
    setBusy(true)
    try {
      await api.revokeAllInvites()
      await loadInvites()
    } catch (cause) {
      setError(localizeError(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const toggleOpen = async (): Promise<void> => {
    if (room === null) return
    setBusy(true)
    try {
      const result = await api.setJoinOpen(!room.joinOpen)
      setRoom({ ...room, joinOpen: result.joinOpen })
    } catch (cause) {
      setError(localizeError(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const resetRoom = async (): Promise<void> => {
    if (resetText !== 'RESET') return
    setBusy(true)
    setError(null)
    try {
      await api.resetRoom()
      setResetText('')
      setCreated(null)
      const me = await api.me()
      setRoom(me.room)
      await loadInvites()
    } catch (cause) {
      setError(localizeError(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1600)
    } catch {
      setError(t('errorGeneric'))
    }
  }

  return (
    <div className="poker-console">
      <div className="poker-console-inner">
        <div className="poker-console-head">
          <div>
            <h1>{t('consoleTitle')}</h1>
            <p className="poker-note">{t('consoleSubtitle')}</p>
          </div>
          <div className="poker-console-actions">
            <a className="poker-btn" href={BASE}>{t('backToTable')}</a>
            <button
              type="button"
              className="poker-btn"
              title={dark ? t('themeToLight') : t('themeToDark')}
              aria-label={dark ? t('themeToLight') : t('themeToDark')}
              onClick={() => { setDark(value => !value) }}
            >
              <span aria-hidden>{dark ? '☀' : '☾'}</span>
              <span>{dark ? t('themeLight') : t('themeDark')}</span>
            </button>
            <div className="poker-lang poker-lang-segmented" role="group" aria-label={t('language')}>
              <button type="button" data-active={language === 'en'} onClick={() => { setLanguage('en') }}>EN</button>
              <button type="button" data-active={language === 'zh'} onClick={() => { setLanguage('zh') }}>中文</button>
            </div>
            {admin ? <button type="button" className="poker-btn" onClick={() => { void logout() }} disabled={busy}>{t('consoleLogout')}</button> : null}
          </div>
        </div>

        {error !== null ? <p className="poker-error" role="alert">{error}</p> : null}
        {loading ? <p className="poker-note">{t('loading')}</p> : null}

        {!loading && !admin ? (
          <section className="poker-panel poker-login-panel">
            <h2>{t('consoleLogin')}</h2>
            <form className="poker-form" onSubmit={event => { void login(event) }}>
              <label className="poker-field">
                <span>{t('username')}</span>
                <input className="poker-input" value={username} autoComplete="username" onChange={event => { setUsername(event.currentTarget.value) }} />
              </label>
              <label className="poker-field">
                <span>{t('password')}</span>
                <input className="poker-input" type="password" value={password} autoComplete="current-password" onChange={event => { setPassword(event.currentTarget.value) }} />
              </label>
              <button type="submit" className="poker-btn" data-variant="primary" disabled={busy || username.trim() === '' || password === ''}>
                {t('consoleLogin')}
              </button>
            </form>
          </section>
        ) : null}

        {!loading && admin ? (
          <>
            <div className="poker-console-grid">
              <section className="poker-panel">
                <h2>{t('roomSettings')}</h2>
                <p className="poker-note">
                  {t('roomBlinds')} {formatTokenAmount(room?.smallBlind ?? 0)}/{formatTokenAmount(room?.bigBlind ?? 0)}
                  {' · '}{t('roomStack')} {formatTokenAmount(room?.startingStack ?? 0)}
                  {' · '}{room?.players ?? 0}/{room?.seats ?? 8}
                  {' · '}{room?.joinOpen ? t('roomJoinOpen') : t('roomJoinClosed')}
                </p>
                <label className="poker-toggle">
                  <input type="checkbox" checked={room?.joinOpen ?? false} disabled={busy} onChange={() => { void toggleOpen() }} />
                  <span>{t('joinOpen')}</span>
                </label>
                <p className="poker-note">{t('joinOpenHint')}</p>
                <div className="poker-admin-actions">
                  <button type="button" className="poker-btn" data-variant="danger" onClick={() => { void revokeAll() }} disabled={busy}>
                    {t('revokeAll')}
                  </button>
                </div>
              </section>

              <section className="poker-panel">
                <h2>{t('resetRoom')}</h2>
                <p className="poker-note">{t('resetRoomHint')}</p>
                <p className="poker-note">{t('adminResetRoomConfirm')}</p>
                <div className="poker-admin-row">
                  <input className="poker-input" value={resetText} placeholder={t('adminResetWord')} onChange={event => { setResetText(event.currentTarget.value) }} />
                  <button type="button" className="poker-btn" data-variant="danger" disabled={busy || resetText !== 'RESET'} onClick={() => { void resetRoom() }}>
                    {t('resetConfirm')}
                  </button>
                </div>
              </section>
            </div>

            <section className="poker-panel">
              <h2>{t('createInvite')}</h2>
              <form className="poker-form" onSubmit={event => { void createInvite(event) }}>
                <div className="poker-admin-grid">
                  <label className="poker-field">
                    <span>{t('inviteLabel')}</span>
                    <input className="poker-input" value={form.label} placeholder={t('inviteLabelPlaceholder')} onChange={event => { setForm({ ...form, label: event.currentTarget.value }) }} />
                  </label>
                  <label className="poker-field">
                    <span>{t('inviteNickname')}</span>
                    <input className="poker-input" value={form.nickname} placeholder={t('inviteNicknamePlaceholder')} onChange={event => { setForm({ ...form, nickname: event.currentTarget.value }) }} />
                  </label>
                  <label className="poker-field">
                    <span>{t('inviteMaxUses')}</span>
                    <input className="poker-input" type="number" min={1} max={1000} value={form.maxUses} onChange={event => { setForm({ ...form, maxUses: event.currentTarget.value }) }} />
                  </label>
                  <label className="poker-field">
                    <span>{t('inviteExpires')}</span>
                    <input className="poker-input" type="number" min={1} max={8760} value={form.expiresInHours} placeholder={t('noExpiry')} onChange={event => { setForm({ ...form, expiresInHours: event.currentTarget.value }) }} />
                    <small>{t('inviteExpiresHint')}</small>
                  </label>
                </div>
                <div className="poker-admin-actions">
                  <button type="submit" className="poker-btn" data-variant="primary" disabled={busy}>{t('inviteCreate')}</button>
                </div>
              </form>

              {created !== null ? (
                <div className="poker-drawer-section">
                  <h3>{t('inviteCreated')}</h3>
                  <p className="poker-note">{t('inviteOnceHint')} {t('inviteLinkHint')}</p>
                  <div className="poker-code">
                    <span>{created.url}</span>
                    <button type="button" className="poker-btn" data-size="sm" onClick={() => { void copy(created.url) }}>
                      {copied ? t('copied') : t('copy')}
                    </button>
                  </div>
                  {created.invite.nickname !== null ? <p className="poker-note">{t('inviteNicknameLocked', { name: created.invite.nickname })}</p> : null}
                </div>
              ) : null}
            </section>

            <section className="poker-panel">
              <h2>{t('consoleInvites')} · {invites.length}</h2>
              {invites.length === 0 ? <p className="poker-note">{t('noInvites')}</p> : null}
              <div className="poker-invite-list">
                {invites.map(invite => (
                  <div key={invite.id} className="poker-invite" data-revoked={String(invite.revoked)}>
                    <div>
                      <strong>{invite.label !== '' ? invite.label : invite.id.slice(0, 8)}</strong>
                      {invite.revoked ? <span className="poker-pill" data-tone="bad">{t('revoked')}</span> : null}
                      <small>
                        {t('used', { used: invite.usedCount, max: invite.maxUses })}
                        {' · '}{invite.expiresAt === null ? t('noExpiry') : t('expires', { date: formatDate(invite.expiresAt, language) })}
                        {invite.nickname !== null ? ` · ${t('inviteNicknameLocked', { name: invite.nickname })}` : ''}
                      </small>
                    </div>
                    <div className="poker-invite-actions">
                      <button
                        type="button"
                        className="poker-btn"
                        data-size="sm"
                        data-variant="danger"
                        disabled={busy || invite.revoked}
                        onClick={() => { void revoke(invite.id) }}
                      >
                        {t('revoke')}
                      </button>
                      <button
                        type="button"
                        className="poker-btn"
                        data-size="sm"
                        data-variant="danger"
                        disabled={busy}
                        onClick={() => { void remove(invite) }}
                      >
                        {t('delete')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </>
        ) : null}
      </div>
    </div>
  )
}
