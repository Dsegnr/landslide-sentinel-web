import type { Route } from '../hooks/useHashRoute'
import { prepareRoute } from '../lib/routeResources'

const TABS: Array<{ key: Route; label: string }> = [
  { key: 'dashboard', label: '算法大屏' },
  { key: 'field', label: '现场监测' },
  { key: 'terrain', label: '三维坡体' },
  { key: 'ops', label: '设备与通信' },
]

export default function NavBar({ route, onNavigate }: {
  route: Route
  onNavigate: (r: Route) => void
}) {
  return (
    <nav className="nav-tabs" aria-label="页面切换">
      {TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          className={route === t.key ? 'active' : ''}
          onClick={() => onNavigate(t.key)}
          onPointerEnter={() => prepareRoute(t.key)}
          onFocus={() => prepareRoute(t.key)}
          onTouchStart={() => prepareRoute(t.key)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  )
}
