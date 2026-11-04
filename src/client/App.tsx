import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api, BASE, type MePlayer, type RoomSummary } from './api.ts'
import { AdminConsole } from './AdminConsole.tsx'
import { createTranslator, detectLanguage, type Language } from './i18n.ts'
import { JoinScreen } from './Join.tsx'
import { RoomScreen } from './Table.tsx'
import { useRoomSocket, type ConnectionStatus } from './socket.ts'
import { localizeError, localizeServerError } from './errors.ts'
import type { RoomView } from '../room/room.ts'

function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => {
    const stored = localStorage.getItem('poker.theme')
    if (stored === 'dark' || stored === 'light') return stored === 'dark'
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    localStorage.setItem('poker.theme', dark ? 'dark' : 'light')
  }, [dark])
  return [dark, () => { setDark(value => !value) }]
}

const ADMIN_PATH = `${BASE}admin`.replace(/\/+$/, '')

export function App(): React.ReactElement {
  const isAdminPath = window.location.pathname.replace(/\/+$/, '') === ADMIN_PATH
  return isAdminPath ? <AdminConsole /> : <RoomApp />
}

function RoomApp(): React.ReactElement {
  const [language, setLanguage] = useState<Language>(() => detectLanguage())
  const t = useMemo(() => createTranslator(language), [language])
  const [dark, toggleTheme] = useTheme()

  const [booted, setBooted] = useState(false)
  const [me, setMe] = useState<MePlayer | null>(null)
  const [room, setRoom] = useState<RoomSummary | null>(null)
  const [view, setView] = useState<RoomView | null>(null)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [adminUnlocked, setAdminUnlocked] = useState(false)
  const [inviteCode, setInviteCode] = useState(() => new URLSearchParams(window.location.search).get('invite') ?? '')

  useEffect(() => {
    localStorage.setItem('poker.lang', language)
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
  }, [language])

  const refreshMe = useCallback(async (): Promise<void> => {
    try {
      const result = await api.me()
      setMe(result.player)
      setRoom(result.room)
    } catch (cause) {
      setJoinError(localizeError(cause, t))
    }
  }, [t])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const result = await api.me()
        if (!alive) return
        setMe(result.player)
        setRoom(result.room)
      } catch (cause) {
        if (alive) setJoinError(localizeError(cause, t))
      } finally {
        if (alive) setBooted(true)
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const socket = useRoomSocket(me !== null, {
    onView: next => {
      setView(next)
      setRoom(current => current ?? {
        joinOpen: next.settings.joinOpen,
        phase: next.phase,
        paused: next.paused,
        handNumber: next.handNumber,
        players: next.players.length,
        seats: 8,
        smallBlind: next.settings.smallBlind,
        bigBlind: next.settings.bigBlind,
        startingStack: next.settings.startingStack,
      })
    },
    onReset: kind => {
      setView(null)
      setMe(null)
      setAdminUnlocked(false)
      setNotice(kind === 'removed' ? t('errorRemoved') : t('errorRoomReset'))
      void refreshMe()
    },
    onError: (code, message) => { setToast(localizeServerError(code, message, t)) },
    onUnlocked: () => { setAdminUnlocked(true) },
    onAck: () => { /* the next view message already reflects the change */ },
  })

  useEffect(() => {
    if (socket.status !== 'online') setAdminUnlocked(false)
  }, [socket.status])

  useEffect(() => {
    if (toast === null) return
    const timer = window.setTimeout(() => { setToast(null) }, 4500)
    return () => { window.clearTimeout(timer) }
  }, [toast])

  const toggleLanguage = (): void => { setLanguage(current => current === 'zh' ? 'en' : 'zh') }

  const handleJoin = async (name: string, pin: string, invite: string): Promise<void> => {
    setBusy(true)
    setJoinError(null)
    try {
      await api.join({ name, pin, ...(invite === '' ? {} : { invite }) })
      const result = await api.me()
      if (result.player === null) {
        setJoinError(t('errorGeneric'))
        return
      }
      setMe(result.player)
      setRoom(result.room)
      setView(null)
      setNotice(null)
      setInviteCode('')
      if (window.location.search !== '') window.history.replaceState(null, '', BASE)
    } catch (cause) {
      setJoinError(localizeError(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const handleLogout = async (): Promise<void> => {
    try {
      await api.logout()
    } catch {
      /* ignore */
    }
    setMe(null)
    setView(null)
    setAdminUnlocked(false)
    await refreshMe()
  }

  if (!booted) {
    return (
      <div className="poker-auth">
        <div className="poker-auth-card">
          <div className="poker-brand-row">
            <span className="poker-brandmark">♠</span>
            <h1>{t('appName')}</h1>
          </div>
          <p className="poker-note">{t('loading')}</p>
        </div>
      </div>
    )
  }

  if (me === null) {
    return (
      <>
        <JoinScreen
          room={room}
          inviteCode={inviteCode}
          error={joinError}
          busy={busy}
          notice={notice}
          t={t}
          language={language}
          onLanguage={toggleLanguage}
          dark={dark}
          onTheme={toggleTheme}
          onJoin={(name, pin, invite) => { void handleJoin(name, pin, invite) }}
        />
        {toast !== null ? <div className="poker-toast" role="status">{toast}</div> : null}
      </>
    )
  }

  if (view === null) {
    return (
      <div className="poker-auth">
        <div className="poker-auth-card">
          <div className="poker-brand-row">
            <span className="poker-brandmark">♠</span>
            <h1>{t('appName')}</h1>
          </div>
          <p className="poker-note">{socket.status === 'online' ? t('loading') : connectionLabel(socket.status, t)}</p>
          <div className="poker-admin-actions">
            <button type="button" className="poker-btn" data-variant="ghost" onClick={() => { void handleLogout() }}>{t('cancel')}</button>
          </div>
        </div>
        {toast !== null ? <div className="poker-toast" role="status">{toast}</div> : null}
      </div>
    )
  }

  return (
    <>
      <RoomScreen
        view={view}
        status={socket.status}
        send={socket.send}
        t={t}
        language={language}
        onLanguage={toggleLanguage}
        dark={dark}
        onTheme={toggleTheme}
        adminUnlocked={adminUnlocked}
        onAdminUnlocked={setAdminUnlocked}
        onLogout={() => { void handleLogout() }}
      />
      {toast !== null ? <div className="poker-toast" role="status">{toast}</div> : null}
    </>
  )
}

function connectionLabel(status: ConnectionStatus, t: ReturnType<typeof createTranslator>): string {
  if (status === 'online') return t('loading')
  if (status === 'offline') return t('roomOffline')
  return t('roomConnecting')
}
