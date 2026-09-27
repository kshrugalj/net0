export default function AgentCursor({ point }: { point: { x: number; y: number } | null }) {
  if (!point) return null
  return (
    <div
      className="agent-cursor"
      style={{ transform: `translate(${point.x}px, ${point.y}px)` }}
      aria-hidden
    >
      <svg width="22" height="22" viewBox="0 0 22 22">
        <path
          d="M4 2.2 4 17.4 8.2 13.5 11.4 19.6 13.8 18.4 10.6 12.4 16.6 11.7Z"
          fill="#f4fff8"
          stroke="#143028"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}
