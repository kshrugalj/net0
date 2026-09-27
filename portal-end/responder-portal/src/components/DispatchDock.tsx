import { useEffect, useRef, useState } from 'react'
import type { Incident } from '../types/incident'
import {
  dispatchCode,
  dispatchText,
  downloadDispatchPdf,
  responseOverview,
  severityLabel,
} from '../utils/dispatchOrder'
import { formatArrival } from '../utils/streetRoute'

interface Props {
  orderNumber: number
  incidents: Incident[]
  hasDeviceFix: boolean
  etas: Record<string, number>
  onRemove: (id: string) => void
  onSend: () => void
  onHighlight: (id: string | null) => void
  onFocus: (id: string) => void
}

function coordinatesLabel(incident: Incident): string {
  if (incident.lat == null || incident.lon == null) return 'No GPS'
  return `${incident.lat.toFixed(5)}, ${incident.lon.toFixed(5)}`
}

function etaLine(incident: Incident, etas: Record<string, number>, hasDeviceFix: boolean): string {
  const minutes = etas[incident.id]
  if (minutes != null) return `ETA ${formatArrival(minutes)}`
  if (incident.lat == null || incident.lon == null) return 'No GPS for an ETA'
  if (!hasDeviceFix) return 'Waiting for portal GPS'
  return 'Estimating arrival…'
}

export default function DispatchDock({
  orderNumber,
  incidents,
  hasDeviceFix,
  etas,
  onRemove,
  onSend,
  onHighlight,
  onFocus,
}: Props) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const pendingClick = useRef<{ id: string; timer: number } | null>(null)

  useEffect(() => {
    return () => {
      if (pendingClick.current) window.clearTimeout(pendingClick.current.timer)
    }
  }, [])

  function onStopClick(id: string, isOpen: boolean) {
    const pending = pendingClick.current
    if (pending?.id === id) {
      window.clearTimeout(pending.timer)
      pendingClick.current = null
      setOpenId(id)
      onFocus(id)
      return
    }
    if (pending) window.clearTimeout(pending.timer)
    pendingClick.current = {
      id,
      timer: window.setTimeout(() => {
        pendingClick.current = null
        setOpenId(isOpen ? null : id)
      }, 250),
    }
  }
  const code = dispatchCode(orderNumber)
  const located = incidents.some(incident => incident.lat != null && incident.lon != null)

  async function copyOrder() {
    const text = dispatchText(orderNumber, incidents)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <aside className="dispatch-dock" aria-label="Dispatch order">
      <header className="dispatch-dock-head">
        <div>
          <span className="dispatch-kicker">Dispatch order</span>
          <strong>#{code}</strong>
        </div>
      </header>

      <p className="dispatch-overview">{responseOverview(incidents)}</p>

      <ul className="dispatch-list">
        {incidents.map((incident, index) => {
          const open = openId === incident.id
          const place = incident.placeName || incident.location || 'Location not provided'
          return (
            <li
              key={incident.id}
              className={open ? 'open' : ''}
              onMouseEnter={() => onHighlight(incident.id)}
              onMouseLeave={() => onHighlight(null)}
            >
              <button
                type="button"
                className="dispatch-item"
                aria-expanded={open}
                title="Double-click to zoom the map"
                onClick={() => onStopClick(incident.id, open)}
              >
                <span className="dispatch-index">{index + 1}</span>
                <span className="dispatch-item-copy">
                  <strong>
                    {incident.type}
                    <em>{severityLabel(incident.priority)}</em>
                  </strong>
                  <small>
                    {place} · {etaLine(incident, etas, hasDeviceFix)}
                  </small>
                </span>
              </button>
              <button
                type="button"
                className="dispatch-remove"
                aria-label={`Remove ${incident.type} from dispatch`}
                onClick={() => onRemove(incident.id)}
              >
                ×
              </button>
              {open ? (
                <div className="dispatch-detail">
                  <p>{incident.aiSummary?.trim() || 'No AI summary on this report yet.'}</p>
                  <blockquote>
                    {incident.report.trim() ? `“${incident.report.trim()}”` : 'No original message.'}
                  </blockquote>
                  <dl>
                    <div>
                      <dt>GPS</dt>
                      <dd>{coordinatesLabel(incident)}</dd>
                    </div>
                    <div>
                      <dt>People</dt>
                      <dd>{incident.people > 0 ? incident.people : 'Not reported'}</dd>
                    </div>
                  </dl>
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>

      <p className="dispatch-route-note">
        {!hasDeviceFix
          ? 'Waiting for this portal’s GPS before the street route can be drawn.'
          : located
            ? 'Dashed line follows streets from this portal through each stop.'
            : 'Add a report with GPS to draw the street route.'}
      </p>

      <div className="dispatch-tools">
        <button type="button" onClick={() => void copyOrder()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" onClick={() => downloadDispatchPdf(orderNumber, incidents)}>
          PDF
        </button>
      </div>
      <button type="button" className="dispatch-send" onClick={onSend}>
        Send dispatch
      </button>
    </aside>
  )
}
