/**
 * Same-laptop API base.
 *
 * Prefer the Vite dev proxy (`/api` on the page origin) so the browser never
 * resolves "localhost". `localhost` on macOS is often ::1, while `fastapi dev`
 * listens on 127.0.0.1 only. If the proxy is down, probe IPv4 loopback first,
 * then the localhost name, then IPv6, then the host the page was opened on.
 */

const DEFAULT_PORT = (import.meta.env.VITE_API_PORT as string | undefined)?.trim() || '8000'

let basePromise: Promise<string> | null = null

export function resetApiBase(): void {
  basePromise = null
}

export async function getApiBase(): Promise<string> {
  const configured = (import.meta.env.VITE_API_URL as string | undefined)?.trim()
  if (configured) return configured.replace(/\/$/, '')
  if (!basePromise) {
    basePromise = discoverBase().catch(error => {
      basePromise = null
      throw error
    })
  }
  return basePromise
}

function loopbackUrl(host: string, port: string): string {
  const bare = host.replace(/^\[|\]$/g, '')
  const formatted = bare.includes(':') ? `[${bare}]` : bare
  return `http://${formatted}:${port}`
}

function candidates(): string[] {
  const port = DEFAULT_PORT
  const list = [
    '',
    loopbackUrl('127.0.0.1', port),
    loopbackUrl('localhost', port),
    loopbackUrl('::1', port),
  ]
  const pageHost = window.location.hostname.replace(/^\[|\]$/g, '')
  if (pageHost && pageHost !== 'localhost' && pageHost !== '127.0.0.1' && pageHost !== '::1') {
    list.push(loopbackUrl(pageHost, port))
  }
  return [...new Set(list)]
}

async function discoverBase(): Promise<string> {
  const options = candidates()
  const checks = await Promise.all(
    options.map(async (base, index) => ({ index, base, ok: await ping(base) })),
  )
  const hit = checks.filter(check => check.ok).sort((a, b) => a.index - b.index)[0]
  if (hit) return hit.base
  throw new Error('Cannot reach the portal server on this laptop. Start it with fastapi dev in portal-end/backend (port 8000).')
}

async function ping(base: string): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), 1500)
  try {
    const response = await fetch(`${base}/api/health`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!response.ok) return false
    const body = (await response.json().catch(() => null)) as { status?: string } | null
    return body?.status === 'online'
  } catch {
    return false
  } finally {
    window.clearTimeout(timer)
  }
}

function errorMessage(status: number, body: string): string {
  const trimmed = body.trim()
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as { detail?: unknown }
      if (typeof parsed.detail === 'string' && parsed.detail.trim()) return parsed.detail.trim()
    } catch {
      return trimmed
    }
  }
  return `Request failed (${status})`
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const base = await getApiBase()
  let response: Response
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
  } catch (error) {
    resetApiBase()
    if (error instanceof Error && error.message.startsWith('Cannot reach')) throw error
    throw new Error('Cannot reach the portal server on this laptop. Start it with fastapi dev in portal-end/backend (port 8000).')
  }
  if (!response.ok) {
    if (response.status === 502 || response.status === 504) resetApiBase()
    const detail = await response.text().catch(() => '')
    throw new Error(errorMessage(response.status, detail))
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}
