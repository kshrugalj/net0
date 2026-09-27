import { useNow } from '../hooks/useRelativeTime'
import type { Incident } from '../types/incident'
import { deviceName } from '../utils/networkLabels'
import { getPrimaryResponse } from '../utils/primaryResponse'
import { formatClock, formatRelativeTime } from '../utils/relativeTime'
import EmergencyIcon from './EmergencyIcon'
import PriorityMeter from './PriorityMeter'
import ResponderPills from './ResponderPills'

function needLabel(name: string): string {
  if (name === 'meds') return 'Medication'
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function coordinatesLabel(incident: Incident): string {
  if (incident.lat == null || incident.lon == null) return 'No GPS fix'
  const coords = `${incident.lat.toFixed(5)}, ${incident.lon.toFixed(5)}`
  if (incident.gpsAccuracy == null) return coords
  return `${coords} (±${incident.gpsAccuracy} m)`
}

export default function IncidentDetails({
  incident,
  inDispatch = false,
  onAcknowledge,
  onToggleDispatch,
}: {
  incident: Incident
  inDispatch?: boolean
  onAcknowledge: (id: string) => void
  onToggleDispatch?: (id: string) => void
}) {
  const now = useNow()
  const reported = formatRelativeTime(incident.arrivedAt, now)
  const arrivedClock = formatClock(incident.arrivedAt)
  const delivered = incident.ackedAt ? formatRelativeTime(incident.ackedAt, now) : ''
  const deliveredClock = formatClock(incident.ackedAt)
  const isNew = incident.status === 'NEW'
  const reportedType = incident.reportedType ?? incident.type
  const categoryDiffers = reportedType !== incident.type
  const summary = incident.aiSummary?.trim() ?? ''
  const needs = incident.needs ?? []
  const sosId = incident.msgId != null ? incident.msgId : incident.id

  return (
    <section className={`panel details-panel ${incident.type.toLowerCase()}`} aria-labelledby="details-heading">
      <div className="panel-heading">
        <h2 id="details-heading">Incident Details</h2>
      </div>
      <div className="details-body">
        <div className="incident-top">
          <span className="incident-id">SOS / {sosId}</span>
          {isNew ? (
            <span className="incident-status new" role="status">
              NEW
            </span>
          ) : null}
        </div>
        <div className="detail-emergency">
          <span className="emergency-icon">
            <EmergencyIcon type={incident.type} />
          </span>
          <h3>{incident.type}</h3>
        </div>
        {categoryDiffers ? <p className="field-note">Field category: {reportedType}</p> : null}
        {incident.people > 0 ? (
          <p className="people-detail">
            <strong>{incident.people}</strong> {incident.people === 1 ? 'person' : 'people'} needing help
          </p>
        ) : (
          <p className="people-detail detail-muted">People count not provided</p>
        )}
        <p className="priority-detail detail-priority-line">
          <PriorityMeter level={incident.priority} size="md" />
          <span>{incident.priority == null ? 'Priority pending' : `Priority P${incident.priority}`}</span>
        </p>

        <section className="detail-block">
          <h4>AI insight</h4>
          <div className={`ai-insight ${summary ? '' : 'pending'}`}>
            <p>
              {summary ||
                'Summary has not been added yet. Use the field report below until the model finishes.'}
            </p>
          </div>
          {incident.aiResponders.length > 0 ? (
            <ResponderPills responders={incident.aiResponders} className="report-pills" />
          ) : incident.respondersReady === false ? (
            <p className="field-note">
              Responder tags not assigned yet. Suggested from the field category: {getPrimaryResponse(reportedType)}
            </p>
          ) : (
            <p className="field-note">No responder tags on this report</p>
          )}
        </section>

        <section className="detail-block">
          <h4>Field report</h4>
          <blockquote>
            {incident.report.trim() ? `“${incident.report.trim()}”` : 'No message text was sent with this report.'}
          </blockquote>
          <dl className="detail-facts">
            <div>
              <dt>Location</dt>
              <dd>{incident.placeName || incident.location || 'Not provided'}</dd>
            </div>
            <div>
              <dt>Needs</dt>
              <dd>{needs.length ? needs.map(needLabel).join(', ') : 'None listed'}</dd>
            </div>
            <div>
              <dt>Coordinates</dt>
              <dd>{coordinatesLabel(incident)}</dd>
            </div>
            <div>
              <dt>Received via</dt>
              <dd>{incident.node === 'unassigned' ? 'Origin not recorded' : `Access Point ${incident.node}`}</dd>
            </div>
            <div>
              <dt>Arrived</dt>
              <dd>
                {reported || 'Time not recorded'}
                {arrivedClock ? (
                  <>
                    <br />
                    <small>{arrivedClock}</small>
                  </>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>Phone delivery</dt>
              <dd>
                {incident.ackedAt ? (
                  <>
                    {delivered || 'Recorded'}
                    {deliveredClock ? (
                      <>
                        <br />
                        <small>{deliveredClock}</small>
                      </>
                    ) : null}
                  </>
                ) : (
                  'Not recorded'
                )}
              </dd>
            </div>
            {incident.phone ? (
              <div>
                <dt>Phone</dt>
                <dd>{incident.phone}</dd>
              </div>
            ) : null}
          </dl>
          <h4>How this report reached us</h4>
          <p className="detail-route">
            {incident.path.length ? incident.path.map(deviceName).join(' → ') : 'Path not recorded'}
          </p>
          {incident.attempt ? <p className="field-note">Delivery attempt {incident.attempt}</p> : null}
        </section>

        <div className="detail-actions">
          {onToggleDispatch ? (
            <button
              type="button"
              className={`dispatch-add-button ${inDispatch ? 'on' : ''}`}
              onClick={() => onToggleDispatch(incident.id)}
            >
              {inDispatch ? 'In dispatch' : 'Add to dispatch'}
            </button>
          ) : null}
          {isNew && (
            <button className="acknowledge-button" onClick={() => onAcknowledge(incident.id)}>
              Acknowledge
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
