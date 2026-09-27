export type Emergency =
  | 'Medical'
  | 'Fire'
  | 'Trapped'
  | 'Flood'
  | 'Structural'
  | 'Security'
  | 'Hazmat'
  | 'Other'
  | 'Unknown'

export type IncidentStatus = 'NEW' | 'ACKNOWLEDGED' | 'RESPONDING' | 'RESOLVED'

export type AiResponder =
  | 'medical_ems'
  | 'fire_rescue'
  | 'law_enforcement'
  | 'technical_sar'
  | 'humanitarian_care'
  | 'coast_guard'

/** AI dispatch priority 1–5 (1 = lowest, 5 = immediate life threat). Null until AI writes it. */
export type AiPriority = 1 | 2 | 3 | 4 | 5

export interface Incident {
  id: string
  msgId?: number
  userId: number
  userName?: string
  phone?: string
  /** Category shown in the queue. AI category when it exists, otherwise the device category. */
  type: Emergency
  /** Category the device sent, before AI. */
  reportedType?: Emergency
  people: number
  /** Decoded `needs` bit flags from the report packet. */
  needs?: string[]
  node: string
  /** ISO timestamp when the report arrived (`created_at`). */
  arrivedAt: string
  /** ISO timestamp when the phone was acked, if recorded. */
  ackedAt?: string | null
  status: IncidentStatus
  /** Free-text location from the report. */
  location: string
  placeName?: string
  locationDetail?: string
  /** Raw message text from the field. */
  report: string
  /** AI summary. Null until the model writes it. */
  aiSummary?: string | null
  path: string[]
  aiResponders: AiResponder[]
  /** False when `ai_responders` is still null. True once AI has written the list, even if empty. */
  respondersReady?: boolean
  /** Matches backend `ai_priority`. Null until AI writes it. */
  priority: AiPriority | null
  /** Backend cluster id when Agent Mode groups nearby reports. */
  clusterId?: string
  /** Gemini summary for the whole cluster area. */
  clusterSummary?: string | null
  /** Responder types needed across the cluster. */
  clusterResponders?: AiResponder[]
  lat?: number | null
  lon?: number | null
  gpsAccuracy?: number | null
  attempt?: number
  x?: number
  y?: number
}
