import type { AiPriority, Incident } from './incident'
import type { NetworkNode } from './network'

export interface AgentModeDockProps {
  active: boolean
  incidents?: Incident[]
  selectedId: string | null
  nodes?: NetworkNode[]
  plan?: RescuePlan | null
  brief?: AgentBrief | null
  loading?: boolean
  runStatus?: 'ok' | 'fallback' | null
  onToggle: () => void
  onApproveCheckIn?: (reportId: number, text: string) => Promise<'sent' | 'pending'>
}

export interface AgentEvidence {
  label: string
  detail: string
  tone: 'confirmed' | 'warning' | 'unknown'
}

export interface RoutePoint {
  lat: number
  lon: number
  label: string
  kind: 'responder' | 'waypoint' | 'civilian'
}

export interface RescuePlan {
  reportId?: number
  priority: AiPriority
  title: string
  summary: string
  approach: string
  avoid: string
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  evidence: AgentEvidence[]
  unknowns: string[]
  draft: string
  route: RoutePoint[]
  routeLabel: string
  routeNote: string
}

export interface AgentBrief {
  reportCount: number
  incidentCount: number
  insight: string
  highlights: string[]
  summary: string
  signals: string[]
  verify: string[]
  generatedAt: string
}
