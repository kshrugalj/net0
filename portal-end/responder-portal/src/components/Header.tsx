import type { PortalLink } from '../hooks/useLivePortal'
import type { NetworkNode } from '../types/network'

export default function Header({ nodes, link = 'live' }: { nodes: NetworkNode[]; link?: PortalLink }) {
  const onlineCount = nodes.filter(node => node.status === 'ONLINE').length
  const healthy = nodes.length > 0 && onlineCount === nodes.length
  const hasAny = nodes.length > 0
  const statusClass = !hasAny ? 'down' : healthy ? 'up' : 'degraded'
  const label = !hasAny ? 'No nodes' : `${onlineCount}/${nodes.length} nodes`

  return (
    <header className="portal-header">
      <div className="portal-brand">
        <h1>
          net<span>0</span>
        </h1>
        <span className="portal-name">Responder Center</span>
      </div>
      <div className="header-status">
        {link !== 'live' && (
          <span className={`node-status ${link === 'connecting' ? 'degraded' : 'down'}`}>
            <span className="status-dot" aria-hidden />
            {link === 'connecting' ? 'Connecting' : 'Server unreachable'}
          </span>
        )}
        <span className={`node-status ${statusClass}`}>
          <span className="status-dot" aria-hidden />
          {label}
        </span>
      </div>
    </header>
  )
}
