import { useEffect, useMemo, useState } from 'react'
import type { Incident } from '../types/incident'
import type { ConversationSummary } from '../types/message'
import { displayName } from '../utils/groupIncidents'
import { parseServerTime } from '../utils/serverTime'
import ChatThread from '../components/ChatThread'

interface Props {
  incidents: Incident[]
  conversations: ConversationSummary[]
  loading: boolean
  error: string | null
  unreadByUser: Map<number, number>
  selectedUserId: number | null
  onSelectUser: (userId: number) => void
  composeText?: string | null
}

interface NodeGroup {
  nodeId: string
  label: string
  conversations: ConversationSummary[]
  latestAt: number
}

function nodeLabel(nodeId: string): string {
  return nodeId === 'unassigned' ? 'Unassigned' : `Node ${nodeId}`
}

function matchesQuery(
  conversation: ConversationSummary,
  nodeId: string,
  query: string,
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true

  const name = displayName(conversation.userId, conversation.userName).toLowerCase()
  const id = String(conversation.userId)
  const label = nodeLabel(nodeId).toLowerCase()
  const rawNode = nodeId.toLowerCase()
  const snippet = (conversation.lastMessage?.text ?? '').toLowerCase()

  return (
    name.includes(q) ||
    id.includes(q) ||
    label.includes(q) ||
    rawNode.includes(q) ||
    `node ${rawNode}`.includes(q) ||
    `access point ${rawNode}`.includes(q) ||
    snippet.includes(q)
  )
}

export default function MessagesView({
  incidents,
  conversations,
  loading,
  error,
  unreadByUser,
  selectedUserId,
  onSelectUser,
  composeText = null,
}: Props) {
  const seeds = useMemo(() => {
    const map = new Map<number, { userName?: string; node: string }>()
    for (const incident of incidents) {
      const existing = map.get(incident.userId)
      if (!existing) {
        map.set(incident.userId, { userName: incident.userName, node: incident.node })
      } else if (!existing.userName && incident.userName) {
        existing.userName = incident.userName
      }
    }
    return [...map.entries()].map(([userId, meta]) => ({
      userId,
      userName: meta.userName,
      node: meta.node,
    }))
  }, [incidents])

  const nodeByUser = useMemo(() => {
    const map = new Map<number, string>()
    for (const seed of seeds) map.set(seed.userId, seed.node)
    return map
  }, [seeds])

  const [query, setQuery] = useState('')
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (!query.trim()) return
    setCollapsedNodes(new Set())
  }, [query])

  useEffect(() => {
    if (selectedUserId == null) return
    const nodeId = nodeByUser.get(selectedUserId)
    if (!nodeId) return
    setCollapsedNodes(current => {
      if (!current.has(nodeId)) return current
      const next = new Set(current)
      next.delete(nodeId)
      return next
    })
  }, [selectedUserId, nodeByUser])

  const filtered = conversations.filter(conversation => {
    const nodeId = nodeByUser.get(conversation.userId) ?? 'unassigned'
    return matchesQuery(conversation, nodeId, query)
  })

  const nodeGroups = useMemo(() => {
    const groups = new Map<string, NodeGroup>()
    for (const conversation of filtered) {
      const nodeId = nodeByUser.get(conversation.userId) ?? 'unassigned'
      const existing = groups.get(nodeId)
      const latestAt = conversation.lastMessage
        ? new Date(conversation.lastMessage.created_at).getTime()
        : 0
      if (existing) {
        existing.conversations.push(conversation)
        existing.latestAt = Math.max(existing.latestAt, latestAt)
      } else {
        groups.set(nodeId, {
          nodeId,
          label: nodeLabel(nodeId),
          conversations: [conversation],
          latestAt,
        })
      }
    }
    return [...groups.values()]
      .map(group => ({
        ...group,
        conversations: [...group.conversations].sort((a, b) => {
          const aTime = a.lastMessage ? new Date(a.lastMessage.created_at).getTime() : 0
          const bTime = b.lastMessage ? new Date(b.lastMessage.created_at).getTime() : 0
          return bTime - aTime
        }),
      }))
      .sort((a, b) => b.latestAt - a.latestAt || a.label.localeCompare(b.label))
  }, [filtered, nodeByUser])

  const active =
    conversations.find(c => c.userId === selectedUserId) ??
    (selectedUserId != null
      ? {
          userId: selectedUserId,
          userName: seeds.find(s => s.userId === selectedUserId)?.userName,
          messageCount: 0,
        }
      : null)

  function toggleGroup(nodeId: string) {
    setCollapsedNodes(current => {
      const next = new Set(current)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }

  function conversationUnreadCount(conversation: ConversationSummary): number {
    return unreadByUser.get(conversation.userId) ?? 0
  }

  return (
    <section className="messages-view" aria-label="Messages">
      <aside className="messages-inbox">
        <div className="messages-inbox-header">
          <h2>Connected nodes</h2>
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search nodes or users"
            aria-label="Search conversations"
          />
        </div>
        {loading && conversations.length === 0 && <p className="chat-muted">Loading…</p>}
        {error && <p className="chat-error">{error}</p>}
        <div className="conversation-list">
          {nodeGroups.map(group => {
            const expanded = !collapsedNodes.has(group.nodeId)
            const groupUnread = group.conversations.some(conversation => conversationUnreadCount(conversation) > 0)
            return (
              <div key={group.nodeId} className={`node-group ${expanded ? 'open' : ''}`}>
                <button
                  type="button"
                  className="node-group-header"
                  aria-expanded={expanded}
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.label}${groupUnread ? ', unread messages' : ''}`}
                  onClick={() => toggleGroup(group.nodeId)}
                >
                  <span className="node-group-title">
                    <span className={`node-chevron ${expanded ? 'open' : ''}`} aria-hidden>
                      <ChevronIcon />
                    </span>
                    <strong>{group.label}</strong>
                    {groupUnread && <span className="unread-dot" aria-hidden />}
                  </span>
                  <span className="small-label">
                    {group.conversations.length}{' '}
                    {group.conversations.length === 1 ? 'person' : 'people'}
                  </span>
                </button>
                {expanded &&
                  group.conversations.map(conversation => {
                    const name = displayName(conversation.userId, conversation.userName)
                    const snippet = conversation.lastMessage?.text ?? 'No messages yet'
                    const when = conversation.lastMessage
                      ? relativeTime(conversation.lastMessage.created_at)
                      : ''
                    const isSelected = selectedUserId === conversation.userId
                    const unread = conversationUnreadCount(conversation) > 0
                    return (
                      <button
                        key={conversation.userId}
                        type="button"
                        className={`conversation-row ${isSelected ? 'selected' : ''} ${unread ? 'unread' : ''}`}
                        data-conversation-user={conversation.userId}
                        onClick={() => onSelectUser(conversation.userId)}
                      >
                        <span className="conversation-top">
                          <span className="conversation-name">
                            {unread ? <span className="unread-dot" aria-hidden /> : <span className="unread-dot-spacer" aria-hidden />}
                            <strong>{name}</strong>
                          </span>
                          <span className="small-label">{when}</span>
                        </span>
                        <span className="conversation-snippet">{snippet}</span>
                      </button>
                    )
                  })}
              </div>
            )
          })}
          {!loading && nodeGroups.length === 0 && (
            <p className="chat-muted">
              {query.trim() ? 'No nodes or users match that search.' : 'No connected users yet.'}
            </p>
          )}
        </div>
      </aside>
      <div className="messages-thread">
        {active ? (
          <>
            <div className="messages-thread-header">
              <div>
                <strong>{displayName(active.userId, active.userName)}</strong>
                <span className="small-label">
                  ID {active.userId}
                  {nodeByUser.get(active.userId)
                    ? ` · Node ${nodeByUser.get(active.userId)}`
                    : ''}
                </span>
              </div>
            </div>
            <ChatThread userId={active.userId} active composeText={composeText} />
          </>
        ) : (
          <div className="messages-empty">
            <p>Select a person on a connected node to message them.</p>
          </div>
        )}
      </div>
    </section>
  )
}

function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M4.25 2.5 7.75 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function relativeTime(iso: string): string {
  const then = parseServerTime(iso)
  if (then == null) return ''
  const ms = Date.now() - then
  if (ms < 0) return 'now'
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}
