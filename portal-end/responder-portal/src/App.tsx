import { useEffect, useMemo, useRef, useState } from 'react'
import Header from './components/Header'
import IncidentQueue from './components/IncidentQueue'
import IncidentMap from './components/IncidentMap'
import NavRail, { type AppView } from './components/NavRail'
import MessagesView from './views/MessagesView'
import AgentModeDock from './components/AgentModeDock'
import AgentCursor from './components/AgentCursor'
import DispatchDock from './components/DispatchDock'
import { useLivePortal } from './hooks/useLivePortal'
import { useInbox } from './hooks/useInbox'
import { useDeviceLocation } from './hooks/useDeviceLocation'
import { useDispatcherAgent } from './hooks/useDispatcherAgent'
import type { AiResponder, Incident } from './types/incident'
import { filterByResponders } from './utils/groupIncidents'
import { sendMessage } from './api/messages'
import { latestMessageId, markConversationRead, totalUnread, unreadCountsByUser } from './utils/messageRead'
import { dispatchCode } from './utils/dispatchOrder'
import { formatArrival, orderByLocation } from './utils/streetRoute'
import './App.css'

function App() {
  const { incidents, nodes, loading, error, link, acknowledge, resolveReports } = useLivePortal()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedFilters, setSelectedFilters] = useState<AiResponder[]>([])
  const [view, setView] = useState<AppView>('home')
  const [peekUserId, setPeekUserId] = useState<number | null>(null)
  const [messagesUserId, setMessagesUserId] = useState<number | null>(null)
  const [agentMode, setAgentMode] = useState(false)
  const [agentExpandedUsers, setAgentExpandedUsers] = useState<number[]>([])
  const [agentCompose, setAgentCompose] = useState<string | null>(null)
  const [dispatchIds, setDispatchIds] = useState<string[]>([])
  const [orderNumber, setOrderNumber] = useState(1)
  const [highlightedDispatchId, setHighlightedDispatchId] = useState<string | null>(null)
  const [dispatchFocus, setDispatchFocus] = useState<{ id: string; token: number } | null>(null)
  const [dispatchEtas, setDispatchEtas] = useState<Record<string, number>>({})
  const [dispatchNotice, setDispatchNotice] = useState<string | null>(null)
  const devicePosition = useDeviceLocation()

  const openIncidents = useMemo(
    () => incidents.filter(incident => incident.status !== 'RESOLVED'),
    [incidents],
  )

  const filteredIncidents = useMemo(
    () => filterByResponders(openIncidents, selectedFilters),
    [openIncidents, selectedFilters],
  )

  const seedUsers = useMemo(() => {
    const map = new Map<number, string | undefined>()
    for (const incident of openIncidents) {
      if (!map.has(incident.userId)) map.set(incident.userId, incident.userName)
    }
    return map
  }, [openIncidents])

  const inboxSeeds = useMemo(
    () => [...seedUsers.entries()].map(([userId, userName]) => ({ userId, userName })),
    [seedUsers],
  )
  const {
    conversations,
    messages: inboxMessages,
    loading: inboxLoading,
    error: inboxError,
  } = useInbox(true, inboxSeeds)
  const viewingUserId = view === 'messages' ? messagesUserId : null
  const [readEpoch, setReadEpoch] = useState(0)

  useEffect(() => {
    if (viewingUserId == null) return
    const advanced = markConversationRead(viewingUserId, latestMessageId(inboxMessages, viewingUserId))
    if (advanced) setReadEpoch(epoch => epoch + 1)
  }, [viewingUserId, inboxMessages])

  const unreadByUser = useMemo(
    () => unreadCountsByUser(inboxMessages, viewingUserId),
    [inboxMessages, viewingUserId, readEpoch],
  )
  const unreadTotal = totalUnread(unreadByUser)

  const dispatchIncidents = useMemo(() => {
    const chosen = dispatchIds.flatMap(id => {
      const incident = incidents.find(item => item.id === id)
      return incident ? [incident] : []
    })
    const located = chosen.filter(hasFix)
    const missing = chosen.filter(incident => !hasFix(incident))
    const start = devicePosition
      ? ([Number(devicePosition[0].toFixed(4)), Number(devicePosition[1].toFixed(4))] as [number, number])
      : null
    return [...orderByLocation(start, located), ...missing]
  }, [devicePosition, dispatchIds, incidents])

  const dispatchStops = useMemo(
    () => dispatchIncidents.filter(hasFix).map(incident => ({ id: incident.id, lat: incident.lat, lon: incident.lon })),
    [dispatchIncidents],
  )

  const dispatchIdsRef = useRef(dispatchIds)
  const dispatchIncidentsRef = useRef(dispatchIncidents)
  const incidentsRef = useRef(incidents)
  dispatchIncidentsRef.current = dispatchIncidents
  incidentsRef.current = incidents
  useEffect(() => {
    dispatchIdsRef.current = dispatchIds
  }, [dispatchIds])

  useEffect(() => {
    if (!incidents.length) return
    const live = new Set(incidents.map(incident => incident.id))
    setDispatchIds(current => {
      const next = current.filter(id => live.has(id))
      return next.length === current.length ? current : next
    })
  }, [incidents])

  useEffect(() => {
    if (!dispatchNotice) return
    const timer = window.setTimeout(() => setDispatchNotice(null), 6000)
    return () => window.clearTimeout(timer)
  }, [dispatchNotice])

  function selectIncident(id: string) {
    setSelectedId(id)
    setPeekUserId(null)
    void acknowledge(id)
  }

  function acknowledgeIncident(id: string) {
    void acknowledge(id)
  }

  function changeFilters(next: AiResponder[]) {
    setSelectedFilters(next)
    setSelectedId(current => {
      if (current == null) return current
      const visible = filterByResponders(openIncidents, next)
      if (visible.some(incident => incident.id === current)) return current
      return null
    })
  }

  function openMessages(userId: number) {
    setPeekUserId(null)
    setMessagesUserId(userId)
    setView('messages')
  }

  function changeView(next: AppView) {
    setView(next)
    if (next === 'messages') {
      setPeekUserId(null)
      if (messagesUserId == null && seedUsers.size) {
        setMessagesUserId([...seedUsers.keys()][0])
      }
    }
  }

  function releaseDispatchFocus(id: string) {
    if (dispatchFocus?.id !== id) return
    setDispatchFocus(null)
    setHighlightedDispatchId(current => (current === id ? null : current))
  }

  function toggleDispatch(id: string) {
    setDispatchIds(current => {
      if (current.includes(id)) return current.filter(item => item !== id)
      return [...current, id]
    })
    if (dispatchIds.includes(id)) releaseDispatchFocus(id)
  }

  function removeFromDispatch(id: string) {
    setDispatchIds(current => current.filter(item => item !== id))
    releaseDispatchFocus(id)
  }

  function focusDispatchStop(id: string) {
    setHighlightedDispatchId(id)
    setDispatchFocus(current => ({ id, token: (current?.token ?? 0) + 1 }))
  }

  async function sendDispatch(): Promise<number[]> {
    const queued = dispatchIncidentsRef.current
    if (!queued.length) return []
    const etas = dispatchEtas
    const code = dispatchCode(orderNumber)
    const ids = queued.map(incident => incident.id)
    dispatchIdsRef.current = []
    setDispatchIds([])
    setDispatchEtas({})
    setHighlightedDispatchId(null)
    setOrderNumber(number => number + 1)
    if (selectedId && ids.includes(selectedId)) setSelectedId(null)
    const notified = await notifyDispatch(queued, etas, code)
    await resolveReports(ids)
    return notified
  }

  async function notifyDispatch(queued: Incident[], etas: Record<string, number>, code: string): Promise<number[]> {
    const seen = new Set<number>()
    const unique = queued.filter(incident => {
      if (seen.has(incident.userId)) return false
      seen.add(incident.userId)
      return true
    })
    const results = await Promise.all(
      unique.map(async incident => {
        const minutes = etas[incident.id]
        const arrival =
          minutes != null
            ? ` Estimated arrival is about ${formatArrival(minutes)}.`
            : ' Help is on the way.'
        const text = `Dispatch #${code} sent for your ${incident.type.toLowerCase()} report.${arrival}`
        try {
          await sendMessage({
            user_id: incident.userId,
            text,
            sender: 'Portal',
            reply_to: incident.msgId,
          })
          return true
        } catch {
          return false
        }
      }),
    )
    const failed = results.filter(ok => !ok).length
    setDispatchNotice(
      failed
        ? `Dispatch sent. ${failed} ${failed === 1 ? 'notification failed' : 'notifications failed'}.`
        : 'Dispatch sent. Each person was told help is on the way.',
    )
    return unique.map(incident => incident.userId)
  }

  function expandAgentUser(userId: number) {
    setAgentExpandedUsers(current => (current.includes(userId) ? current : [...current, userId]))
  }

  async function sendAgentText(userId: number, text: string) {
    const incident = incidentsRef.current.find(item => item.userId === userId && item.status !== 'RESOLVED')
    await sendMessage({
      user_id: userId,
      text,
      sender: 'Net0 Agent',
      reply_to: incident?.msgId,
    })
  }

  const { thought: agentThought, cursor: agentCursor } = useDispatcherAgent({
    enabled: agentMode,
    dispatchIdsRef,
    setDispatchIds,
    incidentsRef,
    selectIncident,
    runDispatch: sendDispatch,
    openThread: openMessages,
    showHome: () => setView('home'),
    sendText: sendAgentText,
    expandUser: expandAgentUser,
    setCompose: setAgentCompose,
  })

  function toggleAgentMode() {
    setAgentMode(current => !current)
  }

  useEffect(() => {
    if (!agentMode) return
    const previousOverflow = document.documentElement.style.overflow
    document.documentElement.style.overflow = 'hidden'

    const allowToggle = (target: EventTarget | null) =>
      target instanceof Element && Boolean(target.closest('.agent-dock-toggle'))

    const blockPointer = (event: Event) => {
      if (allowToggle(event.target)) return
      event.preventDefault()
      event.stopPropagation()
    }
    const blockKeys = (event: KeyboardEvent) => {
      if (allowToggle(event.target)) return
      const scrolling = [' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']
      if (scrolling.includes(event.key) || event.key === 'Tab') {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    window.addEventListener('wheel', blockPointer, { capture: true, passive: false })
    window.addEventListener('touchmove', blockPointer, { capture: true, passive: false })
    window.addEventListener('keydown', blockKeys, true)
    return () => {
      document.documentElement.style.overflow = previousOverflow
      window.removeEventListener('wheel', blockPointer, true)
      window.removeEventListener('touchmove', blockPointer, true)
      window.removeEventListener('keydown', blockKeys, true)
    }
  }, [agentMode])

  const emptyMessage =
    openIncidents.length > 0
      ? 'No reports match these filters.'
      : error
        ? error
        : loading
          ? 'Connecting to the portal server…'
          : 'No reports yet. New emergencies will appear here.'

  return (
    <div className={`app-shell ${agentMode ? 'agent-watching' : ''}`}>
      <div className="agent-stage" inert={agentMode ? true : undefined}>
      <NavRail view={view} unreadCount={unreadTotal} onChange={changeView} />
      <div className="dashboard">
        <Header nodes={nodes} link={link} />
        <main className={`dashboard-content ${view === 'messages' ? 'messages-mode' : ''}`}>
          {view === 'home' ? (
            <div className="workspace">
              <IncidentQueue
                incidents={openIncidents}
                filteredIncidents={filteredIncidents}
                selectedFilters={selectedFilters}
                onFiltersChange={changeFilters}
                selectedId={selectedId}
                onSelect={selectIncident}
                onClearSelect={() => {
                  setSelectedId(null)
                }}
                onAcknowledge={acknowledgeIncident}
                peekUserId={peekUserId}
                onPeekUser={setPeekUserId}
                onOpenMessages={openMessages}
                notice={dispatchNotice ?? (error && openIncidents.length > 0 ? error : null)}
                emptyMessage={emptyMessage}
                agentMode={agentMode}
                agentExpandedUsers={agentExpandedUsers}
                dispatchIds={dispatchIds}
                onToggleDispatch={toggleDispatch}
              />
              <IncidentMap
                incidents={filteredIncidents}
                selectedId={selectedId}
                onSelectIncident={selectIncident}
                onClearSelection={() => setSelectedId(null)}
                devicePosition={devicePosition}
                dispatchStops={dispatchStops}
                dispatchOrder={dispatchIncidents.map(incident => incident.id)}
                highlightedDispatchId={highlightedDispatchId}
                dispatchFocus={dispatchFocus}
                onDispatchEtas={setDispatchEtas}
              />
            </div>
          ) : (
            <MessagesView
              incidents={openIncidents}
              conversations={conversations}
              loading={inboxLoading}
              error={inboxError}
              unreadByUser={unreadByUser}
              selectedUserId={messagesUserId}
              onSelectUser={setMessagesUserId}
              composeText={agentCompose}
            />
          )}
        </main>
      </div>
      </div>
      <AgentCursor point={agentCursor} />
      <div className="corner-stack">
        {agentMode ? <div className="agent-lock" aria-hidden /> : null}
        <AgentModeDock active={agentMode} thought={agentThought} onToggle={toggleAgentMode} />
        {dispatchIncidents.length > 0 ? (
          <DispatchDock
            orderNumber={orderNumber}
            incidents={dispatchIncidents}
            hasDeviceFix={devicePosition != null}
            etas={dispatchEtas}
            onRemove={removeFromDispatch}
            onSend={sendDispatch}
            onHighlight={setHighlightedDispatchId}
            onFocus={focusDispatchStop}
          />
        ) : null}
      </div>
    </div>
  )
}

function hasFix(incident: Incident): incident is Incident & { lat: number; lon: number } {
  return incident.lat != null && incident.lon != null && Number.isFinite(incident.lat) && Number.isFinite(incident.lon)
}

export default App
