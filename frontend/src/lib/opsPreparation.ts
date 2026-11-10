import { api } from './api'
import { loadOpsSnapshot, opsGeneration, readOpsSnapshot, telemetryKey } from './opsSnapshots'

let preparation: { scope: number; promise: Promise<void> } | undefined
function warm<T>(key: string, loader: (signal: AbortSignal) => Promise<T>) {
  const hit = readOpsSnapshot<T>(key)
  return hit && Date.now() - hit.updated < 30000 ? Promise.resolve(hit.data) : loadOpsSnapshot(key, loader)
}
/** Read-only, two requests at most per batch; never starts notification tests or device writes. */
export function prepareOps() {
  const scope = opsGeneration()
  if (preparation?.scope === scope) return preparation.promise
  const promise = (async () => {
    const inventory = await warm('inventory', s => api.opsDevices(s))
    if (scope !== opsGeneration() || document.hidden) return
    const first = inventory.items[0]
    const jobs: Array<() => Promise<unknown>> = []
    if (first) {
      const id = first.device_id, query = { hours: 1, anchor: 'latest' as const, channels: 'D' }
      jobs.push(() => warm(telemetryKey(id, query), s => api.opsTelemetry(id, query, s)),
        () => warm(`quality/${id}/24/latest`, s => api.opsQuality(id, 24, 'latest', s)))
    }
    jobs.push(() => warm('security', s => api.opsSecurity(s)), () => warm('notify', s => api.opsNotify(50, s)),
      () => warm('system', s => api.opsSystem(s)))
    if (first) jobs.push(() => warm(`guide/${first.device_id}`, s => api.opsSelfcheck(first.device_id, s)))
    for (let i = 0; i < jobs.length; i += 2) {
      if (scope !== opsGeneration() || document.hidden) return
      await Promise.allSettled(jobs.slice(i, i + 2).map(job => job()))
    }
  })().catch(() => { /* Active views expose errors and retry; background warmup must not interrupt home. */ })
  preparation = { scope, promise }
  void promise.finally(() => { if (preparation?.promise === promise) preparation = undefined })
  return promise
}
export function scheduleOpsPreparation() {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  if (connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType ?? '')) return () => {}
  let timer: number | undefined
  const schedule = () => {
    clearTimeout(timer)
    if (!document.hidden) timer = window.setTimeout(() => { void prepareOps() }, 1800)
  }
  schedule(); document.addEventListener('visibilitychange', schedule)
  const interval = window.setInterval(schedule, 60000)
  return () => { clearTimeout(timer); clearInterval(interval); document.removeEventListener('visibilitychange', schedule) }
}
