import type { PortalMessage } from '../types/message'
import { ensureUtcIso } from '../utils/serverTime'
import { request } from './client'

function normalizeMessage(message: PortalMessage): PortalMessage {
  return {
    ...message,
    created_at: ensureUtcIso(message.created_at) ?? message.created_at,
  }
}

export function listMessages(opts?: {
  userId?: number
  direction?: string
  limit?: number
}): Promise<PortalMessage[]> {
  const params = new URLSearchParams()
  if (opts?.userId != null) params.set('user_id', String(opts.userId))
  if (opts?.direction) params.set('direction', opts.direction)
  if (opts?.limit != null) params.set('limit', String(opts.limit))
  const query = params.toString()
  return request<PortalMessage[]>(`/api/messages${query ? `?${query}` : ''}`).then(messages =>
    messages.map(normalizeMessage),
  )
}

export function sendMessage(payload: {
  user_id: number
  text: string
  sender?: string
  reply_to?: number
}): Promise<PortalMessage> {
  return request<PortalMessage>('/api/messages/send', {
    method: 'POST',
    body: JSON.stringify({
      user_id: payload.user_id,
      text: payload.text,
      sender: payload.sender ?? 'Portal',
      ...(payload.reply_to != null ? { reply_to: payload.reply_to } : {}),
    }),
  }).then(normalizeMessage)
}

export interface PortalUser {
  user_id: number
  name: string
  phone: string
}

export function listUsers(): Promise<PortalUser[]> {
  return request('/api/users')
}
