import type { Emergency } from '../types/incident'

function emergencyIconInner(type: Emergency): string {
  if (type === 'Medical') return '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6Z" />'
  if (type === 'Fire') return '<path d="M13 3c1 5-4 5-3 9 2 0 3-2 4-3 3 3 5 5 5 8a7 7 0 0 1-14 0c0-5 5-8 8-14Z" />'
  if (type === 'Trapped') {
    return '<path d="M4 21V3h16v18M8 21h8M12 12v5m-3-2 3-3 3 3" /><circle cx="12" cy="8" r="2" />'
  }
  if (type === 'Flood') {
    return '<path d="M3 15c2 1.6 4 1.6 6 0s4-1.6 6 0 4 1.6 6 0M3 10c2 1.6 4 1.6 6 0s4-1.6 6 0 4 1.6 6 0" />'
  }
  return '<path d="M12 3 2.5 20h19L12 3Zm0 6.5v5m0 2.5h.01" />'
}

/** Plain SVG markup for Leaflet markers (and anywhere React is unavailable). */
export function emergencyIconHtml(type: Emergency): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${emergencyIconInner(type)}</svg>`
}

export default function EmergencyIcon({ type }: { type: Emergency }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {type === 'Medical' && <path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6Z" />}
      {type === 'Fire' && <path d="M13 3c1 5-4 5-3 9 2 0 3-2 4-3 3 3 5 5 5 8a7 7 0 0 1-14 0c0-5 5-8 8-14Z" />}
      {type === 'Trapped' && <><path d="M4 21V3h16v18M8 21h8M12 12v5m-3-2 3-3 3 3" /><circle cx="12" cy="8" r="2" /></>}
      {type === 'Flood' && <path d="M3 15c2 1.6 4 1.6 6 0s4-1.6 6 0 4 1.6 6 0M3 10c2 1.6 4 1.6 6 0s4-1.6 6 0 4 1.6 6 0" />}
      {(type === 'Structural' || type === 'Security' || type === 'Hazmat' || type === 'Other' || type === 'Unknown') && (
        <path d="M12 3 2.5 20h19L12 3Zm0 6.5v5m0 2.5h.01" />
      )}
    </svg>
  )
}
