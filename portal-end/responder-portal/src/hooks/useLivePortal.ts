import { useCallback, useEffect, useRef, useState } from 'react'
import { listNodes } from '../api/nodes'
import { listReports, updateReport } from '../api/reports'
import type { Incident, IncidentStatus } from '../types/incident'
import type { NetworkNode } from '../types/network'
import { reportToIncident, toNetworkNode } from '../utils/fromReport'

const POLL_MS = 4000

export type PortalLink = 'connecting' | 'live' | 'offline'

function explain(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  return 'Cannot reach the portal server on this laptop.'
}

export function useLivePortal() {
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [nodes, setNodes] = useState<NetworkNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState<PortalLink>('connecting')
  const overrides = useRef<Map<string, IncidentStatus>>(new Map())
  const incidentsRef = useRef(incidents)
  const seq = useRef(0)
  incidentsRef.current = incidents

  const applyOverrides = useCallback((list: Incident[]): Incident[] => {
    const pending = overrides.current
    if (pending.size === 0) return list
    const ids = new Set(list.map(item => item.id))
    for (const [id, status] of pending) {
      if (status === 'RESOLVED' && !ids.has(id)) pending.delete(id)
    }
    return list.map(item => {
      const next = pending.get(item.id)
      if (!next) return item
      if (next === 'RESOLVED') {
        if (item.status === 'RESOLVED') pending.delete(item.id)
        else return { ...item, status: 'RESOLVED' }
        return item
      }
      if (item.status !== 'NEW') {
        pending.delete(item.id)
        return item
      }
      return { ...item, status: next }
    })
  }, [])

  const refresh = useCallback(async (silent = false) => {
    const token = ++seq.current
    if (!silent) setLoading(true)
    try {
      const [reports, nodeRows] = await Promise.all([listReports(), listNodes()])
      if (token !== seq.current) return
      const roles = new Map(nodeRows.map(node => [node.node_id, node.role ?? 0]))
      const next = applyOverrides(reports.map(report => reportToIncident(report, roles)))
      incidentsRef.current = next
      setIncidents(next)
      setNodes(nodeRows.map(toNetworkNode))
      setError(null)
      setLink('live')
    } catch (err) {
      if (token !== seq.current) return
      setError(explain(err))
      setLink(incidentsRef.current.length > 0 ? 'live' : 'offline')
    } finally {
      if (token === seq.current) setLoading(false)
    }
  }, [applyOverrides])

  useEffect(() => {
    void refresh(false)
    const tick = () => {
      if (document.visibilityState === 'hidden') return
      void refresh(true)
    }
    const timer = window.setInterval(tick, POLL_MS)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      seq.current += 1
    }
  }, [refresh])

  const acknowledge = useCallback(async (id: string) => {
    const current = incidentsRef.current.find(item => item.id === id)
    if (!current || current.status !== 'NEW') return
    const numericId = Number(id)
    if (!Number.isFinite(numericId)) return
    overrides.current.set(id, 'ACKNOWLEDGED')
    setIncidents(list =>
      list.map(item => (item.id === id && item.status === 'NEW' ? { ...item, status: 'ACKNOWLEDGED' } : item)),
    )
    try {
      await updateReport(numericId, { status: 'acknowledged' })
    } catch (err) {
      overrides.current.delete(id)
      setError(explain(err))
      void refresh(true)
    }
  }, [refresh])

  const resolveReports = useCallback(async (ids: string[]) => {
    const numericIds = ids.map(Number).filter(id => Number.isFinite(id))
    if (!numericIds.length) return
    for (const id of ids) overrides.current.set(id, 'RESOLVED')
    setIncidents(list => list.map(item => (ids.includes(item.id) ? { ...item, status: 'RESOLVED' } : item)))
    try {
      await Promise.all(numericIds.map(id => updateReport(id, { resolved: true, status: 'resolved' })))
    } catch (err) {
      for (const id of ids) overrides.current.delete(id)
      setError(explain(err))
      void refresh(true)
    }
  }, [refresh])

  return { incidents, nodes, loading, error, link, acknowledge, resolveReports }
}
