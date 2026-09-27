import { request } from './client'

export interface ApiNode {
  node_id: number
  role?: number | null
  status?: string | null
  path?: number[] | null
  last_seen?: string | null
}

export function listNodes(): Promise<ApiNode[]> {
  return request('/api/nodes')
}
