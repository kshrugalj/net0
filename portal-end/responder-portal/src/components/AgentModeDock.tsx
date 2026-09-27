interface Props {
  active: boolean
  thought: string
  onToggle: () => void
}

export default function AgentModeDock({ active, thought, onToggle }: Props) {
  return (
    <aside className={`agent-dock ${active ? 'active' : ''}`} aria-label="Dispatch Agent">
      {active && (
        <p className="agent-thought" role="status">
          {thought || 'Looking at open reports.'}
        </p>
      )}
      <button
        type="button"
        className={`agent-dock-toggle ${active ? 'active' : ''}`}
        onClick={onToggle}
        aria-pressed={active}
      >
        <span className="agent-orbit" aria-hidden>
          <span />
        </span>
        <span className="agent-dock-label">
          <strong>Dispatch Agent</strong>
          <small>{active ? 'ON · working the board' : 'OFF · manual control'}</small>
        </span>
      </button>
    </aside>
  )
}
