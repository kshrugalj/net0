import { request } from './client'

export interface ApiReportUser {
  user_id: number
  name?: string | null
  phone?: string | null
  origin?: number | null
}

/** Mirrors `ReportDetail` from portal-end/backend/schemas/report.py. */
export interface ApiReport {
  id: number
  msg_id: number
  attempt?: number | null
  user_id: number
  origin?: number | null
  path?: number[] | null
  category?: number | null
  people?: number | null
  needs?: number | null
  gps_lat?: number | null
  gps_lon?: number | null
  gps_accuracy?: number | null
  location?: string | null
  message?: string | null
  status?: string | null
  resolved?: boolean | null
  ai_priority?: number | null
  ai_category?: number | null
  ai_summary?: string | null
  ai_responders?: string[] | null
  cluster_id?: string | null
  cluster_summary?: string | null
  cluster_responders?: string[] | null
  created_at?: string | null
  acked_at?: string | null
  user?: ApiReportUser | null
}

export function listReports(limit = 500, sort: 'created_at' | 'priority' = 'created_at'): Promise<ApiReport[]> {
  return request(`/api/reports?limit=${limit}&sort=${sort}`)
}

export function updateReport(
  id: number,
  patch: { status?: string; resolved?: boolean },
): Promise<ApiReport> {
  return request(`/api/reports/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}
