import { request } from './client'

export interface AgentApiEvidence {
  label: string
  detail: string
  tone: 'confirmed' | 'warning' | 'unknown'
}

export interface AgentApiRoutePoint {
  lat: number
  lon: number
  label: string
  kind: 'responder' | 'waypoint' | 'civilian'
}

export interface AgentApiPlan {
  report_id: number
  cluster_id: string
  priority: 1 | 2 | 3 | 4 | 5
  title: string
  summary: string
  approach: string
  avoid: string
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  evidence: AgentApiEvidence[]
  unknowns: string[]
  draft: string
  route: AgentApiRoutePoint[]
  route_label: string
  route_note: string
  generated_at: string
}

export interface AgentApiBrief {
  report_count: number
  incident_count: number
  insight: string
  highlights: string[]
  summary: string
  signals: string[]
  verify: string[]
  generated_at: string
}

export interface AgentRunResponse {
  plan: AgentApiPlan | null
  brief: AgentApiBrief
  processed_reports: number
  status: 'ok' | 'fallback'
}

export function runAgent(reportId?: number): Promise<AgentRunResponse> {
  const body = {
    ...(reportId == null ? {} : { report_id: reportId }),
  }
  return request('/api/ai/agent/run', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export interface DispatcherAction {
  thought: string
  type: 'focus' | 'queue' | 'dispatch' | 'message' | 'open_messages' | 'wait'
  report_id: number | null
  report_ids: number[]
  user_id: number | null
  text: string | null
  fingerprint: string
  gemini_ok: boolean
}

export interface DispatcherBoard {
  fingerprint: string
  unresolved_count: number
  pending_replies: number
}

export function dispatcherBoard(): Promise<DispatcherBoard> {
  return request('/api/ai/dispatcher/board')
}

export function dispatcherNext(body: {
  queued_report_ids: number[]
  suppressed_user_ids: number[]
  previous_action?: string
}): Promise<DispatcherAction> {
  return request('/api/ai/dispatcher/next', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function sendAgentCheckIn(
  reportId: number,
  text: string,
): Promise<{ message_id: number; status: 'sent' | 'pending'; text: string }> {
  return request('/api/ai/check-in/send', {
    method: 'POST',
    body: JSON.stringify({ report_id: reportId, text, approved: true }),
  })
}
