import type { AiResponder, AiPriority, Incident } from '../types/incident'
import { formatRelativeTime } from './relativeTime'
import { parseServerTime } from './serverTime'

export type IncidentSort = 'arrival' | 'priority'

export interface UserIncidentGroup {
  userId: number
  userName?: string
  reports: Incident[]
  newestArrivedAt: string
  maxPriority: AiPriority | null
  hasNew: boolean
  responders: AiResponder[]
}

/** Keep reports that include any of the selected responders. Empty selection = all. */
export function filterByResponders(
  incidents: Incident[],
  selected: readonly AiResponder[],
): Incident[] {
  if (selected.length === 0) return incidents
  const set = new Set(selected)
  return incidents.filter(incident => incident.aiResponders.some(r => set.has(r)))
}

function timeMs(iso: string): number {
  return parseServerTime(iso) ?? 0
}

function maxPriorityOf(reports: Incident[]): AiPriority | null {
  return reports.reduce<AiPriority | null>((max, report) => {
    if (report.priority == null) return max
    if (max == null || report.priority > max) return report.priority
    return max
  }, null)
}

function newestTimestamp(reports: Incident[]): string {
  return reports.reduce((newest, report) => {
    return timeMs(report.arrivedAt) > timeMs(newest) ? report.arrivedAt : newest
  }, reports[0]?.arrivedAt ?? '')
}

/** Newest report first. This order stays fixed when the queue sort changes. */
function compareReports(a: Incident, b: Incident): number {
  const timeDelta = timeMs(b.arrivedAt) - timeMs(a.arrivedAt)
  if (timeDelta !== 0) return timeDelta
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Group filtered incidents by userId. Reports stay in arrival order inside the group. */
export function groupByUser(incidents: Incident[]): UserIncidentGroup[] {
  const map = new Map<number, Incident[]>()
  for (const incident of incidents) {
    const list = map.get(incident.userId)
    if (list) list.push(incident)
    else map.set(incident.userId, [incident])
  }

  const groups: UserIncidentGroup[] = []
  for (const [userId, reports] of map) {
    groups.push({
      userId,
      userName: reports.find(r => r.userName)?.userName,
      reports: [...reports].sort(compareReports),
      newestArrivedAt: newestTimestamp(reports),
      maxPriority: maxPriorityOf(reports),
      hasNew: reports.some(r => r.status === 'NEW'),
      responders: [...new Set(reports.flatMap(r => r.aiResponders))],
    })
  }

  return groups
}

/**
 * Order people, not the reports inside them.
 * Arrival: latest report first.
 * Priority: highest overall priority first. Same priority means the older last
 * report comes first, so the two sorts do not collapse into one list.
 */
export function sortGroups(groups: UserIncidentGroup[], sort: IncidentSort): UserIncidentGroup[] {
  const copy = [...groups]
  copy.sort((a, b) => {
    const priorityDelta = (b.maxPriority ?? 0) - (a.maxPriority ?? 0)
    const timeDelta = timeMs(b.newestArrivedAt) - timeMs(a.newestArrivedAt)
    if (sort === 'priority') {
      if (priorityDelta !== 0) return priorityDelta
      if (timeDelta !== 0) return -timeDelta
    } else {
      if (timeDelta !== 0) return timeDelta
      if (priorityDelta !== 0) return priorityDelta
    }
    return a.userId - b.userId
  })
  return copy
}

export function displayName(userId: number, userName?: string): string {
  return userName?.trim() || `User ${userId}`
}

export function groupAgeLabel(group: UserIncidentGroup, now = Date.now()): string {
  return formatRelativeTime(group.newestArrivedAt, now)
}
