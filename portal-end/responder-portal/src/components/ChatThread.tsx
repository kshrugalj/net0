import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useConversation } from '../hooks/useConversation'
import { MESSAGE_MAX } from '../types/message'
import type { PortalMessage } from '../types/message'
import { parseServerTime } from '../utils/serverTime'

interface Props {
  userId: number
  active?: boolean
  compact?: boolean
  composeText?: string | null
}

function formatTime(iso: string): string {
  const ms = parseServerTime(iso)
  if (ms == null) return ''
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export default function ChatThread({ userId, active = true, compact = false, composeText = null }: Props) {
  const { messages, loading, sending, error, send } = useConversation(userId, active)
  const [draft, setDraft] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const typed = useRef<string | null>(null)

  useEffect(() => {
    if (!composeText) {
      if (typed.current) {
        typed.current = null
        setDraft('')
      }
      return
    }
    if (typed.current === composeText) return
    typed.current = composeText
    let index = 0
    const step = Math.max(1, Math.ceil(composeText.length / 36))
    setDraft('')
    const timer = window.setInterval(() => {
      index = Math.min(composeText.length, index + step)
      setDraft(composeText.slice(0, index))
      if (index >= composeText.length) window.clearInterval(timer)
    }, 28)
    return () => window.clearInterval(timer)
  }, [composeText])

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, userId])

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (!text || text.length > MESSAGE_MAX || sending) return
    setDraft('')
    try {
      await send(text)
    } catch {
      setDraft(text)
    }
  }

  return (
    <div className={`chat-thread ${compact ? 'compact' : ''}`}>
      <div className="chat-scroll" ref={scroller}>
        {loading && messages.length === 0 && <p className="chat-muted">Loading…</p>}
        {!loading && messages.length === 0 && (
          <p className="chat-muted">No messages yet. Send a downlink to this user.</p>
        )}
        {messages.map(message => (
          <Bubble key={message.id} message={message} />
        ))}
      </div>
      {error && <p className="chat-error">{error}</p>}
      <form className="chat-composer" onSubmit={handleSubmit}>
        <textarea
          data-chat-input
          value={draft}
          onChange={event => setDraft(event.target.value.slice(0, MESSAGE_MAX))}
          placeholder="Message…"
          rows={compact ? 2 : 3}
          maxLength={MESSAGE_MAX}
          aria-label="Message text"
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void handleSubmit(event)
            }
          }}
        />
        <div className="composer-meta">
          <span className={draft.length >= MESSAGE_MAX ? 'over' : ''}>
            {draft.length}/{MESSAGE_MAX}
          </span>
          <button type="submit" disabled={!draft.trim() || sending || draft.length > MESSAGE_MAX}>
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  )
}

function Bubble({ message }: { message: PortalMessage }) {
  const outgoing = message.direction === 'downlink'
  return (
    <div className={`chat-bubble ${outgoing ? 'out' : 'in'}`}>
      <p>{message.text}</p>
      <span className="bubble-meta">
        {outgoing ? message.sender || 'Portal' : 'Civilian'}
        {message.created_at ? ` · ${formatTime(message.created_at)}` : ''}
        {outgoing && message.status ? ` · ${message.status}` : ''}
      </span>
    </div>
  )
}
