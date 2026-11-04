import { useEffect, useRef, useState } from 'react'
import type { ClientMessage } from '../protocol/index.ts'
import type { RoomView } from '../room/room.ts'

export type ConnectionStatus = 'connecting' | 'online' | 'offline'

/** Re-exported for the views; the schema lives in src/protocol. */
export type { AdminCommand } from '../protocol/index.ts'

interface Handlers {
  onView: (view: RoomView) => void
  onReset: (kind: 'removed' | 'reset') => void
  onError: (code: string, message: string) => void
  onUnlocked: () => void
  onAck: (command: string) => void
}

export function useRoomSocket(enabled: boolean, handlers: Handlers): {
  status: ConnectionStatus
  send: (message: ClientMessage) => boolean
} {
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const socketRef = useRef<WebSocket | null>(null)
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    if (!enabled) return
    let stopped = false
    let retryTimer: number | undefined
    let attempt = 0

    const connect = (): void => {
      if (stopped) return
      setStatus(attempt === 0 ? 'connecting' : 'offline')
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const base = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`
      let socket: WebSocket
      try {
        socket = new WebSocket(`${protocol}//${window.location.host}${base}ws`)
      } catch {
        retryTimer = window.setTimeout(connect, 1500)
        return
      }
      socketRef.current = socket
      socket.onopen = () => {
        attempt = 0
        setStatus('online')
      }
      socket.onmessage = event => {
        let message: unknown
        try {
          message = JSON.parse(String(event.data))
        } catch {
          return
        }
        if (typeof message !== 'object' || message === null) return
        const data = message as Record<string, unknown>
        switch (data.type) {
          case 'view':
            if (data.view !== undefined) handlersRef.current.onView(data.view as RoomView)
            break
          case 'admin':
            if (data.unlocked === true) handlersRef.current.onUnlocked()
            break
          case 'ack':
            if (typeof data.command === 'string') handlersRef.current.onAck(data.command)
            break
          case 'error':
            handlersRef.current.onError(
              typeof data.code === 'string' ? data.code : 'error',
              typeof data.message === 'string' ? data.message : 'Request failed',
            )
            break
          case 'removed':
            handlersRef.current.onReset('removed')
            break
          case 'roomReset':
            handlersRef.current.onReset('reset')
            break
          default:
            break
        }
      }
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null
        if (stopped) return
        setStatus('offline')
        attempt += 1
        retryTimer = window.setTimeout(connect, Math.min(8000, 1000 + attempt * 750))
      }
      socket.onerror = () => {
        try {
          socket.close()
        } catch {
          /* ignore */
        }
      }
    }

    connect()
    return () => {
      stopped = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      const socket = socketRef.current
      socketRef.current = null
      if (socket !== null) {
        socket.onclose = null
        try {
          socket.close(1000, 'client-close')
        } catch {
          /* ignore */
        }
      }
    }
  }, [enabled])

  return {
    status,
    send: message => {
      const socket = socketRef.current
      if (socket === null || socket.readyState !== WebSocket.OPEN) return false
      socket.send(JSON.stringify(message))
      return true
    },
  }
}
