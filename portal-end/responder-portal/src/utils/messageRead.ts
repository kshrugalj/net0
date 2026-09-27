const STORAGE_KEY = 'net0.messages.readThroughId'

export interface ReadableMessage {
  id: number
  user_id: number | null
  direction: string
}

function readMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return {}
    const map: Record<string, number> = {}
    for (const [userId, value] of Object.entries(parsed)) {
      const id = typeof value === 'number' ? value : Number(value)
      if (Number.isFinite(id) && id > 0) map[userId] = id
    }
    return map
  } catch {
    return {}
  }
}

function writeMap(map: Record<string, number>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // ignore quota / private-mode failures
  }
}

export function getLastReadId(userId: number): number {
  return readMap()[String(userId)] ?? 0
}

/** Remember the newest message id the responder has already seen in this thread. */
export function markConversationRead(userId: number, latestMessageId?: number | null): boolean {
  if (latestMessageId == null || latestMessageId <= 0) return false
  const current = getLastReadId(userId)
  if (latestMessageId <= current) return false
  const map = readMap()
  map[String(userId)] = latestMessageId
  writeMap(map)
  return true
}

export function latestMessageId(messages: ReadableMessage[], userId: number): number | null {
  let best: number | null = null
  for (const message of messages) {
    if (message.user_id !== userId || message.id <= 0) continue
    if (best == null || message.id > best) best = message.id
  }
  return best
}

function isIncomingUnread(message: ReadableMessage, viewingUserId: number | null): boolean {
  if (message.direction !== 'uplink' || message.user_id == null || message.id <= 0) return false
  if (viewingUserId != null && message.user_id === viewingUserId) return false
  return message.id > getLastReadId(message.user_id)
}

/** 1 if that person has any incoming message you have not opened, otherwise absent. */
export function unreadCountsByUser(
  messages: ReadableMessage[],
  viewingUserId: number | null,
): Map<number, number> {
  const counts = new Map<number, number>()
  for (const message of messages) {
    if (!isIncomingUnread(message, viewingUserId)) continue
    counts.set(message.user_id as number, 1)
  }
  return counts
}

export function totalUnread(counts: Map<number, number>): number {
  return counts.size
}
