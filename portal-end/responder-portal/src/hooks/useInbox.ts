import { useCallback, useEffect, useMemo, useState } from 'react'
import { listMessages, listUsers } from '../api/messages'
import type { ConversationSummary, PortalMessage } from '../types/message'

const INBOX_POLL_MS = 4000

export interface InboxSeedUser {
  userId: number
  userName?: string
}

function buildSummaries(
  messages: PortalMessage[],
  nameById: Map<number, string>,
  seeds: InboxSeedUser[],
): ConversationSummary[] {
  const byUser = new Map<number, PortalMessage[]>()
  for (const msg of messages) {
    if (msg.user_id == null) continue
    const list = byUser.get(msg.user_id)
    if (list) list.push(msg)
    else byUser.set(msg.user_id, [msg])
  }

  const summaries = new Map<number, ConversationSummary>()

  for (const [userId, thread] of byUser) {
    const sorted = [...thread].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )
    summaries.set(userId, {
      userId,
      userName: nameById.get(userId),
      lastMessage: sorted[0],
      messageCount: thread.length,
    })
  }

  for (const seed of seeds) {
    if (summaries.has(seed.userId)) {
      const existing = summaries.get(seed.userId)!
      if (!existing.userName && seed.userName) existing.userName = seed.userName
      continue
    }
    summaries.set(seed.userId, {
      userId: seed.userId,
      userName: seed.userName ?? nameById.get(seed.userId),
      messageCount: 0,
    })
  }

  return [...summaries.values()].sort((a, b) => {
    const aTime = a.lastMessage ? new Date(a.lastMessage.created_at).getTime() : 0
    const bTime = b.lastMessage ? new Date(b.lastMessage.created_at).getTime() : 0
    if (bTime !== aTime) return bTime - aTime
    return a.userId - b.userId
  })
}

export function useInbox(active: boolean, seeds: InboxSeedUser[]) {
  const [messages, setMessages] = useState<PortalMessage[]>([])
  const [nameById, setNameById] = useState<Map<number, string>>(() => new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const [remote, users] = await Promise.all([
        listMessages({ limit: 500 }),
        listUsers().catch(() => [] as Awaited<ReturnType<typeof listUsers>>),
      ])
      setMessages(remote)
      if (users.length) {
        setNameById(new Map(users.map(u => [u.user_id, u.name])))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load inbox')
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!active) return
    void refresh(false)
    const tick = () => {
      if (document.visibilityState === 'hidden') return
      void refresh(true)
    }
    const timer = window.setInterval(tick, INBOX_POLL_MS)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active, refresh])

  const conversations = useMemo(
    () => buildSummaries(messages, nameById, seeds),
    [messages, nameById, seeds],
  )

  return { conversations, messages, loading, error, refresh }
}
