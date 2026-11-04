import { ApiError } from './api.ts'
import type { Translate } from './i18n.ts'

export function localizeError(error: unknown, t: Translate): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return t('errorNetwork')
    if (error.status === 429 || error.status === 423) return t('errorRate')
    if (error.status === 401 && /pin/i.test(error.message)) return t('errorPin')
    const message = error.message.toLowerCase()
    if (message.includes('wrong pin')) return t('errorPin')
    if (message.includes('invite is required') || message.includes('not accepting')) return t('errorClosed')
    if (message.includes('invite') || message.includes('bound to another nickname')) return t('errorInvite')
    if (message.includes('no seats')) return t('errorFull')
    if (message.includes('nickname')) return t('errorName')
    if (message.includes('pin must')) return t('errorPinFormat')
    return error.message
  }
  if (error instanceof Error && error.message !== '') return error.message
  return t('errorGeneric')
}

export function localizeServerError(code: string, message: string, t: Translate): string {
  if (code === 'rate-limited') return t('errorRate')
  if (code === 'stale-version' || code === 'stale-hand') return `${message} · ${t('errorGeneric')}`
  return message !== '' ? message : t('errorGeneric')
}
