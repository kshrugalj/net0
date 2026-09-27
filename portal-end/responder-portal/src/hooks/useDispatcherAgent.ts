import { useEffect, useRef, useState } from 'react'
import { dispatcherBoard, dispatcherNext, type DispatcherAction } from '../api/agent'
import type { Incident } from '../types/incident'

const STEP_CAP = 24
const MOVE_MS = 700
const BOARD_POLL_MS = 4000

interface Options {
  enabled: boolean
  dispatchIdsRef: { current: string[] }
  setDispatchIds: (ids: string[]) => void
  incidentsRef: { current: Incident[] }
  selectIncident: (id: string) => void
  runDispatch: () => Promise<number[]>
  openThread: (userId: number) => void
  showHome: () => void
  sendText: (userId: number, text: string) => Promise<void>
  expandUser: (userId: number) => void
  setCompose: (text: string | null) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function describe(action: DispatcherAction): string {
  if (action.type === 'focus') return `focus report ${action.report_id}`
  if (action.type === 'queue') return `queue reports ${action.report_ids.join(',')}`
  if (action.type === 'message') return `message user ${action.user_id}`
  if (action.type === 'open_messages') return `open messages for user ${action.user_id}`
  if (action.type === 'dispatch') return 'dispatch'
  return 'none'
}

function stepPastRepeat(
  action: DispatcherAction,
  queuedIds: string[],
  incidents: Incident[],
): DispatcherAction | null {
  if (action.type === 'focus' && action.report_id != null) {
    const id = String(action.report_id)
    if (!queuedIds.includes(id)) {
      return {
        ...action,
        type: 'queue',
        report_ids: [action.report_id],
        thought: 'That report is already on screen. Adding it to the run.',
      }
    }
    if (queuedIds.length) {
      return { ...action, type: 'dispatch', thought: 'Those reports are queued. Sending the run.' }
    }
  }
  if (action.type === 'open_messages' && action.user_id != null) {
    const ids = incidents
      .filter(item => item.userId === action.user_id && item.status !== 'RESOLVED')
      .map(item => Number(item.id))
      .filter(id => Number.isFinite(id) && !queuedIds.includes(String(id)))
    if (ids.length) {
      return { ...action, type: 'queue', report_ids: ids, thought: 'Thread is open. Queueing their reports.' }
    }
    if (queuedIds.length) {
      return { ...action, type: 'dispatch', thought: 'Sending the queued run.' }
    }
  }
  return null
}

function signature(action: DispatcherAction): string {
  if (action.type === 'queue') return `queue:${[...action.report_ids].sort((a, b) => a - b).join(',')}`
  if (action.type === 'focus') return `focus:${action.report_id}`
  if (action.type === 'message') return `message:${action.user_id}:${action.text}`
  if (action.type === 'open_messages') return `open:${action.user_id}`
  return action.type
}

async function moveTo(selector: string, setCursor: (point: { x: number; y: number }) => void): Promise<void> {
  const el = document.querySelector(selector)
  if (!(el instanceof HTMLElement)) return
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  const rect = el.getBoundingClientRect()
  setCursor({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
  await sleep(MOVE_MS)
}

function pointFor(id: string): string {
  if (document.querySelector(`[data-map-pin="${id}"]`)) return `[data-map-pin="${id}"]`
  return `[data-report-id="${id}"]`
}

export function useDispatcherAgent(options: Options): {
  thought: string
  cursor: { x: number; y: number } | null
} {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const [thought, setThought] = useState('')
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const [generation, setGeneration] = useState(0)
  const pausedFingerprint = useRef<string | null>(null)
  const running = useRef(false)
  const suppressedRef = useRef(new Set<number>())
  const continuing = useRef(false)
  const passes = useRef(0)

  useEffect(() => {
    if (!options.enabled) {
      pausedFingerprint.current = null
      continuing.current = false
      suppressedRef.current = new Set()
      setCursor(null)
      setThought('')
      return
    }

    let cancelled = false
    const poll = window.setInterval(() => {
      if (cancelled || running.current || pausedFingerprint.current == null) return
      void dispatcherBoard()
        .then(board => {
          if (cancelled || running.current || pausedFingerprint.current == null) return
          if (board.fingerprint !== pausedFingerprint.current) {
            pausedFingerprint.current = null
            setGeneration(current => current + 1)
          }
        })
        .catch(() => {})
    }, BOARD_POLL_MS)

    return () => {
      cancelled = true
      window.clearInterval(poll)
    }
  }, [options.enabled])

  useEffect(() => {
    if (!options.enabled) return
    let cancelled = false
    if (!continuing.current) {
      suppressedRef.current = new Set()
      passes.current = 0
    }
    continuing.current = false
    const suppressed = suppressedRef.current

    async function play(action: DispatcherAction): Promise<void> {
      const api = optionsRef.current
      if (action.type === 'focus' && action.report_id != null) {
        const id = String(action.report_id)
        const incident = api.incidentsRef.current.find(item => item.id === id)
        await showBoard(api)
        if (cancelled) return
        if (incident) api.expandUser(incident.userId)
        await sleep(80)
        if (cancelled) return
        api.selectIncident(id)
        await sleep(480)
        if (cancelled) return
        await moveTo(pointFor(id), setCursor)
        return
      }

      if (action.type === 'queue') {
        const ids = action.report_ids.map(String)
        await showBoard(api)
        if (cancelled) return
        for (const id of ids) {
          const incident = api.incidentsRef.current.find(item => item.id === id)
          if (incident) api.expandUser(incident.userId)
        }
        await sleep(80)
        if (cancelled) return
        if (ids[0]) {
          api.selectIncident(ids[0])
          await sleep(480)
          if (cancelled) return
          await moveTo(pointFor(ids[0]), setCursor)
        }
        api.dispatchIdsRef.current = ids
        api.setDispatchIds(ids)
        await sleep(280)
        return
      }

      if (action.type === 'dispatch') {
        await showBoard(api)
        await sleep(80)
        if (cancelled) return
        await moveTo('.dispatch-send', setCursor)
        if (cancelled) return
        const notified = await api.runDispatch()
        for (const userId of notified) suppressed.add(userId)
        return
      }

      if (action.type === 'open_messages' && action.user_id != null) {
        await openInbox(action.user_id, api)
        return
      }

      if (action.type === 'message' && action.user_id != null && action.text) {
        await openInbox(action.user_id, api)
        if (cancelled) return
        api.setCompose(null)
        await sleep(80)
        if (cancelled) return
        await moveTo('[data-chat-input]', setCursor)
        if (cancelled) return
        api.setCompose(action.text)
        await sleep(Math.max(900, Math.min(1400, 280 + action.text.length * 12)))
        if (cancelled) return
        await moveTo('.chat-composer button[type="submit"]', setCursor)
        if (cancelled) return
        await api.sendText(action.user_id, action.text)
        api.setCompose(null)
      }
    }

    async function showBoard(api: Options): Promise<void> {
      if (!document.querySelector('.messages-mode')) {
        api.showHome()
        return
      }
      await moveTo('[data-nav="home"]', setCursor)
      if (cancelled) return
      api.showHome()
      await sleep(280)
    }

    async function openInbox(userId: number, api: Options): Promise<void> {
      await moveTo('[data-nav="messages"]', setCursor)
      if (cancelled) return
      api.openThread(userId)
      await sleep(360)
      if (cancelled) return
      if (document.querySelector(`[data-conversation-user="${userId}"]`)) {
        await moveTo(`[data-conversation-user="${userId}"]`, setCursor)
      }
    }

    async function loop() {
      running.current = true
      setThought('Looking at open reports.')
      let lastSignature = ''
      let previousAction = ''
      const seenFingerprints = new Set<string>()
      try {
        for (let step = 0; step < STEP_CAP; step += 1) {
          if (cancelled) return
          const queued = optionsRef.current.dispatchIdsRef.current
            .map(Number)
            .filter(id => Number.isFinite(id))
          let action: DispatcherAction
          try {
            action = await dispatcherNext({
              queued_report_ids: queued,
              suppressed_user_ids: [...suppressed],
              previous_action: previousAction,
            })
          } catch {
            if (!cancelled) setThought('Could not reach the dispatcher. Agent paused.')
            return
          }
          if (cancelled) return
          seenFingerprints.add(action.fingerprint)
          if (!action.gemini_ok) {
            setThought(action.thought || 'Gemini did not respond. Agent paused.')
            pausedFingerprint.current = action.fingerprint
            return
          }

          const queuedIds = optionsRef.current.dispatchIdsRef.current
          let nextAction = action
          if (
            action.type === 'queue' &&
            action.report_ids.length > 0 &&
            action.report_ids.every(id => queuedIds.includes(String(id)))
          ) {
            nextAction = { ...action, type: 'dispatch' }
          }
          if (nextAction.type === 'wait') {
            setThought(nextAction.thought || 'Waiting for the next report.')
            pausedFingerprint.current = nextAction.fingerprint
            return
          }

          let sig = signature(nextAction)
          if (sig === lastSignature) {
            const stepped = stepPastRepeat(
              nextAction,
              queuedIds,
              optionsRef.current.incidentsRef.current,
            )
            if (!stepped || signature(stepped) === lastSignature) {
              setThought(
                nextAction.type === 'message'
                  ? 'Already sent that text. Waiting for something new.'
                  : 'That run was already sent. Waiting for something new.',
              )
              pausedFingerprint.current = nextAction.fingerprint
              return
            }
            nextAction = stepped
            sig = signature(nextAction)
          }
          lastSignature = sig
          previousAction = describe(nextAction)
          setThought(nextAction.thought || 'Working the board.')
          await play(nextAction)
        }
        const stillOpen = optionsRef.current.incidentsRef.current.some(item => item.status !== 'RESOLVED')
        const stillQueued = optionsRef.current.dispatchIdsRef.current.length > 0
        passes.current += 1
        if (!cancelled && passes.current < 8 && (stillOpen || stillQueued)) {
          continuing.current = true
          setGeneration(current => current + 1)
          return
        }
        if (!cancelled) {
          setThought('Pausing this pass. I will continue when the board changes.')
          const board = await dispatcherBoard().catch(() => null)
          pausedFingerprint.current = board?.fingerprint ?? 'capped'
        }
      } finally {
        running.current = false
      }
    }

    void loop()
    return () => {
      cancelled = true
    }
  }, [options.enabled, generation])

  return { thought, cursor: options.enabled ? cursor : null }
}
