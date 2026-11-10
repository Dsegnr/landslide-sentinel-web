import { useCallback, useEffect, useRef, useState } from 'react'
import { loadOpsSnapshot, readOpsSnapshot } from '../lib/opsSnapshots'

function initial<T>(key: string, enabled: boolean): { key: string; data: T | null; error: string; errorStatus: number; loading: boolean; updated: number } {
  const hit = enabled ? readOpsSnapshot<T>(key) : null
  return { key, data: hit?.data ?? null, error: '', errorStatus: 0, loading: enabled, updated: hit?.updated ?? 0 }
}

/** Abort on selection/unmount; coalesce refreshes; pause background polling. */
export function useOpsResource<T>(key: string, fetcher: (signal: AbortSignal) => Promise<T>, interval = 30000, enabled = true) {
  const latest = useRef(fetcher); latest.current = fetcher
  const run = useRef<(complete?: () => void) => void>(complete => complete?.())
  const [state, setState] = useState(() => initial<T>(key, enabled))
  const [nextPollAt, setNextPollAt] = useState(0)
  useEffect(() => {
    let active = true, controller: AbortController | null = null, pending = false
    let waiting: (() => void)[] = []
    const completions = new Set<() => void>()
    const complete = (items: (() => void)[]) => { for (const done of items) if (completions.delete(done)) done() }
    setState(initial<T>(key, enabled))
    const load = async () => {
      if (!active || !enabled || document.hidden) { complete(waiting.splice(0)); return }
      if (controller) { pending = true; return }
      const finished = waiting.splice(0)
      const c = new AbortController(); controller = c
      const timeout = window.setTimeout(() => c.abort('timeout'), 15000)
      setState(s => ({ ...s, loading: true }))
      try {
        const data = await loadOpsSnapshot(key, s => latest.current(s), c.signal)
        if (active && !c.signal.aborted) setState({ key, data, error: '', errorStatus: 0, loading: false, updated: Date.now() })
      } catch (e) {
        if (active && (!c.signal.aborted || c.signal.reason === 'timeout')) setState(s => ({ ...s, loading: false, errorStatus: (e as { status?: number })?.status ?? 0, error: c.signal.reason === 'timeout' ? '读取超时，请重试' : (e as Error).message }))
      } finally {
        clearTimeout(timeout); controller = null
        complete(finished)
        if (active) { setState(s => ({ ...s, loading: false })); if (pending) { pending = false; void load() } }
      }
    }
    run.current = done => { if (done) { waiting.push(done); completions.add(done) }; void load() }; void load()
    let timer: number | undefined
    const arm = () => {
      clearInterval(timer)
      if (!enabled || document.hidden) { setNextPollAt(0); return }
      setNextPollAt(Date.now() + interval)
      timer = window.setInterval(() => { setNextPollAt(Date.now() + interval); void load() }, interval)
    }
    arm()
    const visible = () => { arm(); if (!document.hidden) void load() }
    document.addEventListener('visibilitychange', visible)
    return () => { active = false; controller?.abort(); complete([...completions]); waiting = []; clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
  }, [key, interval, enabled])
  const refresh = useCallback(() => run.current(), [])
  const refreshAndWait = useCallback(() => new Promise<void>(resolve => run.current(resolve)), [])
  return { ...(state.key === key ? state : initial<T>(key, enabled)), refresh, refreshAndWait, nextPollAt }
}
