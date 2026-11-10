import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '../lib/auth'
import type { Route } from '../hooks/useHashRoute'
import { loadTerrainPage, scheduleTerrainPreparation } from '../lib/routeResources'

class TerrainBoundary extends Component<{ active: boolean; retry: () => void; failed: () => void; children: ReactNode }, { error: boolean }> {
  state = { error: false }
  static getDerivedStateFromError() { return { error: true } }
  componentDidCatch() { this.props.failed() }
  render() {
    if (!this.state.error) return this.props.children
    return this.props.active ? <div className="page-loading">三维加载暂未完成。
      <button type="button" className="ack-btn" onClick={this.props.retry}>重新加载三维</button>
    </div> : null
  }
}
export default function RetainedTerrain({ active, prepareEnabled, session, onNavigate, onLogout }: {
  active: boolean; prepareEnabled: boolean; session: Session
  onNavigate: (route: Route) => void; onLogout: () => void
}) {
  const [started, setStarted] = useState(active)
  const [ready, setReady] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const TerrainPage = useMemo(() => lazy(loadTerrainPage), [attempt])
  const prepared = useCallback(() => setReady(true), [])
  const failed = useCallback(() => setReady(false), [])
  const retry = useCallback(() => { setReady(false); setAttempt(n => n + 1) }, [])
  useEffect(() => { if (active) setStarted(true) }, [active])
  useEffect(() => {
    if (started || active || !prepareEnabled) return
    return scheduleTerrainPreparation(() => setStarted(true))
  }, [active, prepareEnabled, started])
  if (!started && !active) return null
  return (
    <div className={`terrain-host${active ? '' : ' terrain-host-preparing'}`}
      aria-hidden={active ? undefined : true} inert={!active}
      data-terrain-ready={ready ? 'true' : 'false'}>
      <TerrainBoundary key={attempt} active={active} failed={failed} retry={retry}>
        <Suspense fallback={active ? <div className="page-loading">正在加载三维坡体…</div> : null}>
          <TerrainPage session={session} route="terrain" onNavigate={onNavigate} onLogout={onLogout}
            active={active} onPrepared={prepared} />
        </Suspense>
      </TerrainBoundary>
    </div>
  )
}
