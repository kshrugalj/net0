import { useEffect, useMemo, useRef, useState } from 'react'
import type { AiResponder, Incident } from '../types/incident'
import { groupByUser, sortGroups, type IncidentSort } from '../utils/groupIncidents'
import { useNow } from '../hooks/useRelativeTime'
import ResponderFilter from './ResponderFilter'
import UserIncidentGroupRow from './UserIncidentGroup'
import ChatPeek from './ChatPeek'
import IncidentDetails from './IncidentDetails'

interface Props {
  incidents: Incident[]
  filteredIncidents: Incident[]
  selectedFilters: AiResponder[]
  onFiltersChange: (next: AiResponder[]) => void
  selectedId: string | null
  onSelect: (id: string) => void
  onClearSelect: () => void
  onAcknowledge: (id: string) => void
  peekUserId: number | null
  onPeekUser: (userId: number | null) => void
  onOpenMessages: (userId: number) => void
  notice?: string | null
  emptyMessage?: string
  agentMode?: boolean
  agentExpandedUsers?: number[]
  dispatchIds: string[]
  onToggleDispatch: (id: string) => void
}

export default function IncidentQueue({
  incidents,
  filteredIncidents,
  selectedFilters,
  onFiltersChange,
  selectedId,
  onSelect,
  onClearSelect,
  onAcknowledge,
  peekUserId,
  onPeekUser,
  onOpenMessages,
  notice = null,
  emptyMessage = 'No reports match these filters.',
  agentMode = false,
  agentExpandedUsers = [],
  dispatchIds,
  onToggleDispatch,
}: Props) {
  const [expandedUsers, setExpandedUsers] = useState<Set<number>>(() => new Set())

  useEffect(() => {
    if (!agentExpandedUsers.length) return
    setExpandedUsers(current => {
      let changed = false
      const next = new Set(current)
      for (const userId of agentExpandedUsers) {
        if (!next.has(userId)) {
          next.add(userId)
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [agentExpandedUsers])
  const [sort, setSort] = useState<IncidentSort>('arrival')
  const [sortOpen, setSortOpen] = useState(false)
  const [caretY, setCaretY] = useState(48)
  const sortMenuRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const peekRef = useRef<HTMLDivElement>(null)
  const now = useNow()

  const groups = useMemo(
    () => sortGroups(groupByUser(filteredIncidents), agentMode ? 'priority' : sort),
    [agentMode, filteredIncidents, sort],
  )

  useEffect(() => {
    const feed = panelRef.current?.querySelector('.incident-feed')
    if (feed) feed.scrollTop = 0
  }, [sort])

  const selectedIncident = incidents.find(incident => incident.id === selectedId) ?? null
  const selectedUserId = selectedIncident?.userId

  useEffect(() => {
    if (selectedUserId == null) return
    setExpandedUsers(current => {
      if (current.has(selectedUserId)) return current
      const next = new Set(current)
      next.add(selectedUserId)
      return next
    })
  }, [selectedUserId])

  useEffect(() => {
    if (!sortOpen) return
    function onPointerDown(event: PointerEvent) {
      if (sortMenuRef.current && !sortMenuRef.current.contains(event.target as Node)) {
        setSortOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [sortOpen])

  useEffect(() => {
    if (!selectedId || !panelRef.current) return
    const feed = panelRef.current.querySelector('.incident-feed')
    let observer: ResizeObserver | null = null

    function updateCaret() {
      const row = panelRef.current?.querySelector(`[data-report-id="${selectedId}"]`) as HTMLElement | null
      const peek = peekRef.current
      if (!row || !peek) return
      const peekBox = peek.getBoundingClientRect()
      const rowBox = row.getBoundingClientRect()
      const rowMid = rowBox.top + rowBox.height / 2
      const pad = 28
      setCaretY(Math.max(pad, Math.min(rowMid - peekBox.top, peekBox.height - pad)))
    }

    const row = panelRef.current.querySelector(`[data-report-id="${selectedId}"]`) as HTMLElement | null
    row?.scrollIntoView({ block: 'nearest' })

    const frame = window.requestAnimationFrame(() => {
      updateCaret()
      if (peekRef.current) {
        observer = new ResizeObserver(updateCaret)
        observer.observe(peekRef.current)
      }
    })
    feed?.addEventListener('scroll', updateCaret, { passive: true })
    window.addEventListener('resize', updateCaret)

    return () => {
      window.cancelAnimationFrame(frame)
      feed?.removeEventListener('scroll', updateCaret)
      window.removeEventListener('resize', updateCaret)
      observer?.disconnect()
    }
  }, [selectedId, expandedUsers])

  const peekGroup = peekUserId != null ? groups.find(group => group.userId === peekUserId) : undefined
  const peekName =
    peekGroup?.userName ??
    incidents.find(incident => incident.userId === peekUserId)?.userName

  function toggleUser(userId: number) {
    setExpandedUsers(current => {
      const next = new Set(current)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })
  }

  return (
    <div className="queue-stack">
      <section className="panel queue-panel" aria-labelledby="queue-heading" ref={panelRef}>
        <div className="panel-heading">
          <h2 id="queue-heading">Incidents</h2>
          <div className="queue-heading-actions">
            <span className="small-label">{filteredIncidents.length} reports</span>
            {!agentMode && (
              <div className="sort-menu" ref={sortMenuRef}>
                <button
                  type="button"
                  className={`sort-toggle ${sortOpen ? 'open' : ''}`}
                  aria-label={sort === 'priority' ? 'Sort incidents, currently priority' : 'Sort incidents, currently arrival time'}
                  aria-haspopup="menu"
                  aria-expanded={sortOpen}
                  title={sort === 'priority' ? 'Sorted by priority' : 'Sorted by arrival time'}
                  onClick={() => setSortOpen(open => !open)}
                >
                  <SortIcon />
                  <span className="sort-current">{sort === 'priority' ? 'Priority' : 'Arrival'}</span>
                </button>
                {sortOpen && (
                  <div className="sort-dropdown" role="menu">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={sort === 'arrival'}
                      className={sort === 'arrival' ? 'active' : ''}
                      onPointerDown={event => {
                        event.preventDefault()
                        event.stopPropagation()
                        setSort('arrival')
                        setSortOpen(false)
                      }}
                    >
                      Arrival time
                    </button>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={sort === 'priority'}
                      className={sort === 'priority' ? 'active' : ''}
                      onPointerDown={event => {
                        event.preventDefault()
                        event.stopPropagation()
                        setSort('priority')
                        setSortOpen(false)
                      }}
                    >
                      Priority
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        {agentMode ? (
          <div className="agent-queue-banner" role="status">
            <span className="agent-banner-spark" aria-hidden>
              ✦
            </span>
            <span>
              <strong>Agent triage active</strong> · highest-risk reports first
            </span>
          </div>
        ) : (
          <ResponderFilter selected={selectedFilters} onChange={onFiltersChange} />
        )}
        {notice ? (
          <p className="connection-note" role="status">
            {notice}
          </p>
        ) : null}
        <div className="incident-feed">
          {groups.length === 0 ? (
            <p className="queue-empty">{emptyMessage}</p>
          ) : (
            groups.map(group => (
              <UserIncidentGroupRow
                key={group.userId}
                group={group}
                now={now}
                expanded={expandedUsers.has(group.userId)}
                selectedId={selectedId}
                onToggle={() => toggleUser(group.userId)}
                onSelectReport={onSelect}
                dispatchIds={dispatchIds}
                onToggleDispatch={onToggleDispatch}
                onMessage={userId => onPeekUser(peekUserId === userId ? null : userId)}
                messaging={peekUserId === group.userId}
              />
            ))
          )}
        </div>
      </section>

      {selectedIncident && (
        <div
          className="report-detail-peek"
          role="dialog"
          aria-label="Report details"
          ref={peekRef}
          style={{ ['--peek-caret-y' as string]: `${caretY}px` }}
        >
          <span className="report-detail-peek-stem" aria-hidden />
          <span className="report-detail-peek-caret" aria-hidden />
          <div className="report-detail-peek-card">
            <div className="report-detail-peek-header">
              <strong>Report details</strong>
              <button type="button" className="icon-btn" aria-label="Close details" onClick={onClearSelect}>
                ×
              </button>
            </div>
            <div className="report-detail-peek-body">
              <IncidentDetails
                key={selectedIncident.id}
                incident={selectedIncident}
                inDispatch={dispatchIds.includes(selectedIncident.id)}
                onAcknowledge={onAcknowledge}
                onToggleDispatch={onToggleDispatch}
              />
            </div>
          </div>
        </div>
      )}

      {peekUserId != null && (
        <ChatPeek
          userId={peekUserId}
          userName={peekName}
          onClose={() => onPeekUser(null)}
          onOpenFull={() => onOpenMessages(peekUserId)}
        />
      )}
    </div>
  )
}

function SortIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M2 4h8M2 8h5M2 12h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M11 3.5v9M11 12.5l2.2-2.2M11 12.5l-2.2-2.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
