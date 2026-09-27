import type { AiPriority } from '../types/incident'

/** Quiet 5-segment priority meter — filled segments only, one muted tone. */
export default function PriorityMeter({
  level,
  size = 'sm',
}: {
  level: AiPriority | null
  size?: 'sm' | 'md'
}) {
  const known = level != null
  return (
    <span
      className={`priority-meter ${size}`}
      title={known ? `Priority ${level} of 5` : 'Priority not set yet'}
      aria-label={known ? `Priority ${level} of 5` : 'Priority not set yet'}
    >
      {[1, 2, 3, 4, 5].map(step => (
        <span
          key={step}
          className={`priority-bar ${known && step <= level ? 'on' : ''}`}
          data-level={known ? level : undefined}
        />
      ))}
    </span>
  )
}
