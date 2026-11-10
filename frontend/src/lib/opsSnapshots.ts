/** Bounded, memory-only snapshots for one authenticated session. Every active view revalidates. */
export interface OpsSnapshot<T> { data: T; updated: number }
interface Pending { controller: AbortController; promise: Promise<unknown>; users: number; settled: boolean }
const snapshots = new Map<string, OpsSnapshot<unknown>>()
const pending = new Map<string, Pending>()
const MAX_ITEMS = 32
const MAX_AGE = 20 * 60 * 1000
let generation = 0
export const opsGeneration = () => generation

export function resetOpsSnapshots() {
  generation++
  snapshots.clear()
  for (const item of pending.values()) item.controller.abort()
  pending.clear()
}
export function readOpsSnapshot<T>(key: string): OpsSnapshot<T> | null {
  const value = snapshots.get(key)
  if (!value) return null
  if (Date.now() - value.updated > MAX_AGE) { snapshots.delete(key); return null }
  snapshots.delete(key); snapshots.set(key, value)
  return value as OpsSnapshot<T>
}
export const telemetryKey = (id: string, q: { hours: number; anchor: string; channels: string; end?: string }) =>
  `telemetry/${encodeURIComponent(id)}/${q.hours}/${q.anchor}/${q.channels}/${q.end ?? ''}`

/** Individual consumers may leave without aborting a request still used by another view/preload. */
export function loadOpsSnapshot<T>(key: string, loader: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  let item = pending.get(key)
  if (!item) {
    const scope = generation
    const controller = new AbortController()
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason === 'timeout'
        ? new Error('读取超时，请重试') : new DOMException('Aborted', 'AbortError')), { once: true })
    })
    const timeout = setTimeout(() => controller.abort('timeout'), 15000)
    item = { controller, promise: Promise.resolve(), users: 0, settled: false }
    const owner = item
    let request: Promise<T>
    try { request = loader(controller.signal) } catch (error) { request = Promise.reject(error) }
    owner.promise = Promise.race([request, aborted]).then(data => {
      if (scope === generation && !controller.signal.aborted) {
        snapshots.delete(key); snapshots.set(key, { data, updated: Date.now() })
        while (snapshots.size > MAX_ITEMS) snapshots.delete(snapshots.keys().next().value!)
      }
      return data
    }).catch(error => {
      if (scope === generation && (error as { status?: number })?.status === 401) resetOpsSnapshots()
      throw error
    }).finally(() => {
      clearTimeout(timeout); owner.settled = true
      if (pending.get(key) === owner) pending.delete(key)
    })
    pending.set(key, owner)
  }
  const owner = item
  owner.users++
  return new Promise<T>((resolve, reject) => {
    let done = false
    const finish = (callback: () => void) => {
      if (done) return
      done = true; signal?.removeEventListener('abort', abort); owner.users--
      if (!owner.users && !owner.settled) {
        if (pending.get(key) === owner) pending.delete(key)
        owner.controller.abort()
      }
      callback()
    }
    const abort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')))
    signal?.addEventListener('abort', abort, { once: true })
    owner.promise.then(value => finish(() => resolve(value as T)), error => finish(() => reject(error)))
  })
}
