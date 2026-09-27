import type { Incident } from '../types/incident'
import type { UserIncidentGroup } from '../utils/groupIncidents'
import { displayName, groupAgeLabel } from '../utils/groupIncidents'
import { formatClock, formatRelativeTime } from '../utils/relativeTime'
import ResponderPills from './ResponderPills'
import PriorityMeter from './PriorityMeter'

interface Props {
  group: UserIncidentGroup
  now: number
  expanded: boolean
  selectedId: string | null
  dispatchIds: string[]
  onToggle: () => void
  onSelectReport: (id: string) => void
  onToggleDispatch: (id: string) => void
  onMessage: (userId: number) => void
  messaging: boolean
}

export default function UserIncidentGroupRow({
  group,
  now,
  expanded,
  selectedId,
  dispatchIds,
  onToggle,
  onSelectReport,
  onToggleDispatch,
  onMessage,
  messaging,
}: Props) {
  const name = displayName(group.userId, group.userName)
  const age = groupAgeLabel(group, now)

  return (
    <div className={`user-group ${expanded ? 'open' : ''} ${messaging ? 'messaging' : ''}`} data-user-id={group.userId}>
      <div className="user-row">
        <button type="button" className="user-row-main" onClick={onToggle} aria-expanded={expanded}>
          <span className={`user-chevron ${expanded ? 'open' : ''}`} aria-hidden>
            <ChevronIcon />
          </span>
          <span className="user-identity">
            <strong>{name}</strong>
            <span className="user-meta">
              {group.reports.length} {group.reports.length === 1 ? 'report' : 'reports'}
              {age ? ` · ${age}` : ''}
            </span>
            <span className="user-priority-row">
              <PriorityMeter level={group.maxPriority} />
              {group.responders.length > 0 ? (
                <ResponderPills responders={group.responders} className="user-pills" />
              ) : group.reports.every(report => report.respondersReady === false) ? (
                <span className="ai-pending-label">AI pending</span>
              ) : null}
            </span>
          </span>
          {group.hasNew && <span className="user-status new">NEW</span>}
        </button>
        <button
          type="button"
          className={`user-message-btn ${messaging ? 'active' : ''}`}
          data-message-user={group.userId}
          aria-label={`Message ${name}`}
          title="Message"
          onClick={event => {
            event.stopPropagation()
            onMessage(group.userId)
          }}
        >
          <MessageIcon />
        </button>
      </div>
      {expanded && (
        <div className="user-reports">
          {group.reports.map(report => (
            <ReportRow
              key={report.id}
              report={report}
              now={now}
              selected={selectedId === report.id}
              inDispatch={dispatchIds.includes(report.id)}
              onSelect={() => onSelectReport(report.id)}
              onToggleDispatch={() => onToggleDispatch(report.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ReportRow({
  report,
  now,
  selected,
  inDispatch,
  onSelect,
  onToggleDispatch,
}: {
  report: Incident
  now: number
  selected: boolean
  inDispatch: boolean
  onSelect: () => void
  onToggleDispatch: () => void
}) {
  return (
    <div data-report-id={report.id} className={`report-row ${selected ? 'selected' : ''}`}>
      <button type="button" className="report-row-hit" aria-pressed={selected} onClick={onSelect}>
        {report.status === 'NEW' && <span className="report-status new">NEW</span>}
        <span className="report-main">
          <span className="report-row-top">
            <span className="report-body">
              <span className="report-place">{report.placeName || report.location || 'Location not provided'}</span>
            </span>
            <PriorityMeter level={report.priority} />
            <span className="report-age" title={formatClock(report.arrivedAt) || undefined}>
              {formatRelativeTime(report.arrivedAt, now)}
            </span>
          </span>
          {report.aiResponders.length > 0 ? (
            <ResponderPills responders={report.aiResponders} className="report-pills" />
          ) : report.respondersReady === false ? (
            <span className="ai-pending-label">AI pending</span>
          ) : null}
        </span>
      </button>
      <button
        type="button"
        className={`report-dispatch-btn ${inDispatch ? 'on' : ''}`}
        aria-pressed={inDispatch}
        aria-label={inDispatch ? 'Remove from dispatch' : 'Add to dispatch'}
        title={inDispatch ? 'Remove from dispatch' : 'Add to dispatch'}
        onClick={onToggleDispatch}
      >
        {inDispatch ? '✓' : '+'}
      </button>
    </div>
  )
}

function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M4.25 2.5 7.75 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function MessageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 3.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H5.2L2.5 13.5v-9a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}
