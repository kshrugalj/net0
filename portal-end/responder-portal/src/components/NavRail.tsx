export type AppView = 'home' | 'messages'

interface Props {
  view: AppView
  unreadCount?: number
  onChange: (view: AppView) => void
}

export default function NavRail({ view, unreadCount = 0, onChange }: Props) {
  const messagesLabel = unreadCount > 0 ? `Messages, ${unreadCount} unread conversations` : 'Messages'
  const badge = unreadCount > 99 ? '99+' : String(unreadCount)

  return (
    <nav className="nav-rail" aria-label="Primary">
      <button
        type="button"
        className={view === 'home' ? 'active' : ''}
        aria-current={view === 'home' ? 'page' : undefined}
        data-nav="home"
        onClick={() => onChange('home')}
      >
        <span className="nav-icon" aria-hidden>
          ⌂
        </span>
        <span>Home</span>
      </button>
      <button
        type="button"
        className={view === 'messages' ? 'active' : ''}
        aria-current={view === 'messages' ? 'page' : undefined}
        aria-label={messagesLabel}
        data-nav="messages"
        onClick={() => onChange('messages')}
      >
        <span className="nav-icon" aria-hidden>
          ✉
          {unreadCount > 0 && <span className="nav-unread-badge">{badge}</span>}
        </span>
        <span>Messages</span>
      </button>
    </nav>
  )
}
