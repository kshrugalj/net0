import type { ApiNode } from '../api/nodes'
import type { ApiReport } from '../api/reports'
import type { AiPriority, AiResponder, Emergency, Incident, IncidentStatus } from '../types/incident'
import type { NetworkNode } from '../types/network'
import { AI_RESPONDERS } from './responders'
import { ensureUtcIso } from './serverTime'

const RESPONDER_SET = new Set<string>(AI_RESPONDERS)

const CATEGORY_LABEL: Record<number, Emergency> = {
  0: 'Unknown',
  1: 'Medical',
  2: 'Trapped',
  3: 'Fire',
  4: 'Flood',
  5: 'Structural',
  6: 'Security',
  7: 'Hazmat',
  8: 'Other',
}

const NEED_BITS: [string, number][] = [
  ['injured', 1],
  ['rescue', 2],
  ['mobility', 4],
  ['meds', 8],
  ['water', 16],
  ['shelter', 32],
  ['vulnerable', 64],
]

export function categoryLabel(code: number | null | undefined): Emergency {
  if (code == null || !Number.isInteger(code)) return 'Unknown'
  return CATEGORY_LABEL[code] ?? 'Unknown'
}

export function decodeNeeds(needs: number | null | undefined): string[] {
  const value = needs ?? 0
  if (!Number.isFinite(value)) return []
  return NEED_BITS.filter(([, bit]) => (value & bit) !== 0).map(([name]) => name)
}

export function nodeName(id: number, role?: number | null): string {
  if (role === 3) return 'Gateway'
  if (role === 1) return `Relay ${id}`
  if (role === 2) return `Access Node ${id}`
  return `Node ${id}`
}

function mapStatus(status: string | null | undefined): IncidentStatus {
  const key = status?.trim().toLowerCase() ?? ''
  if (key === 'acknowledged' || key === 'ack') return 'ACKNOWLEDGED'
  if (key === 'responding' || key === 'dispatched') return 'RESPONDING'
  if (key === 'resolved' || key === 'closed') return 'RESOLVED'
  return 'NEW'
}

function mapPriority(value: number | null | undefined): AiPriority | null {
  if (value == null || !Number.isInteger(value) || value < 1 || value > 5) return null
  return value as AiPriority
}

function mapResponders(value: string[] | null | undefined): AiResponder[] {
  if (!Array.isArray(value)) return []
  const out: AiResponder[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !RESPONDER_SET.has(item) || out.includes(item as AiResponder)) continue
    out.push(item as AiResponder)
  }
  return out
}

function displayCategory(reported: Emergency, ai: Emergency | null): Emergency {
  if (ai && ai !== 'Unknown') return ai
  return reported
}

function finiteCoord(value: number | null | undefined, limit: number): number | null {
  if (value == null || !Number.isFinite(value) || Math.abs(value) > limit) return null
  return value
}

export function reportToIncident(report: ApiReport, roles: Map<number, number>): Incident {
  const reportedType = categoryLabel(report.category)
  const aiCategory = report.ai_category == null ? null : categoryLabel(report.ai_category)
  const lat = finiteCoord(report.gps_lat, 90)
  const lon = finiteCoord(report.gps_lon, 180)
  const locationText = report.location?.trim() ?? ''
  const path = Array.isArray(report.path) ? report.path.filter(id => typeof id === 'number') : []
  const origin = report.origin ?? report.user?.origin ?? null
  const name = report.user?.name?.trim() || undefined
  const phone = report.user?.phone?.trim() || undefined

  return {
    id: String(report.id),
    msgId: report.msg_id,
    userId: report.user_id,
    userName: name,
    phone,
    type: displayCategory(reportedType, aiCategory),
    reportedType,
    people: report.people ?? 0,
    needs: decodeNeeds(report.needs),
    node: origin == null ? 'unassigned' : String(origin),
    arrivedAt: ensureUtcIso(report.created_at) ?? '',
    ackedAt: ensureUtcIso(report.acked_at),
    status: report.resolved ? 'RESOLVED' : mapStatus(report.status),
    location: locationText,
    placeName: locationText || undefined,
    report: report.message?.trim() ?? '',
    aiSummary: report.ai_summary?.trim() || null,
    path: path.map(id => nodeName(id, roles.get(id))),
    aiResponders: mapResponders(report.ai_responders),
    respondersReady: Array.isArray(report.ai_responders),
    priority: mapPriority(report.ai_priority),
    clusterId: report.cluster_id?.trim() || undefined,
    clusterSummary: report.cluster_summary?.trim() || null,
    clusterResponders: mapResponders(report.cluster_responders),
    lat,
    lon,
    gpsAccuracy: report.gps_accuracy == null || !Number.isFinite(report.gps_accuracy) ? null : report.gps_accuracy,
    attempt: report.attempt ?? 0,
  }
}

export function toNetworkNode(node: ApiNode): NetworkNode {
  const online = node.status?.trim().toLowerCase() === 'online'
  return {
    id: String(node.node_id),
    name: nodeName(node.node_id, node.role),
    status: online ? 'ONLINE' : 'OFFLINE',
  }
}
