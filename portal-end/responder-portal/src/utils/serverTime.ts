/** Backend datetimes are UTC. SQLite often returns them with no timezone suffix. */

const HAS_ZONE = /(?:z|[+-]\d{2}:?\d{2})$/i

export function ensureUtcIso(value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const iso = HAS_ZONE.test(trimmed) ? trimmed : `${trimmed.replace(' ', 'T')}Z`
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

export function parseServerTime(value: string | null | undefined): number | null {
  const iso = ensureUtcIso(value)
  if (!iso) return null
  return Date.parse(iso)
}

export function formatClock(value: string | null | undefined): string {
  const ms = parseServerTime(value)
  if (ms == null) return ''
  return new Date(ms).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
