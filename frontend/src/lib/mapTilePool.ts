import { loadRadarFrames } from './radarFrames'

/** Shared decoded tile images. No authentication or monitoring data is stored here. */
export function createTilePool<T>(loader: (url: string, signal: AbortSignal, priority: number) => Promise<T>, limit = 96, concurrency = 6) {
  interface Work { url: string; priority: number; users: number; started: boolean; settled: boolean; controller: AbortController; promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
  const cache = new Map<string, T>(), pending = new Map<string, Work>(), queue: Work[] = []
  let active = 0, background = 0, radar = 0
  const radarLimit = Math.max(1, Math.floor(concurrency / 3))
  const pump = () => {
    queue.sort((a, b) => a.priority - b.priority)
    while (active < concurrency) {
      const index = queue.findIndex(w => !w.controller.signal.aborted
        && (w.priority < 2 || background < 2) && (w.priority !== 1 || radar < radarLimit))
      if (index < 0) break
      const work = queue.splice(index, 1)[0], isBackground = work.priority >= 2, isRadar = work.priority === 1
      work.started = true; active++; if (isBackground) background++; if (isRadar) radar++
      let task: Promise<T>
      try { task = loader(work.url, work.controller.signal, work.priority) } catch (error) { task = Promise.reject(error) }
      void task.then(value => {
        if (work.controller.signal.aborted) return
        cache.delete(work.url); cache.set(work.url, value)
        while (cache.size > limit) cache.delete(cache.keys().next().value!)
        work.resolve(value)
      }, error => work.reject(error)).finally(() => {
        work.settled = true; active--; if (isBackground) background--; if (isRadar) radar--
        if (pending.get(work.url) === work) pending.delete(work.url)
        pump()
      })
    }
  }
  return (url: string, priority = 0, signal?: AbortSignal): Promise<T> => {
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
    if (cache.has(url)) { const hit = cache.get(url)!; cache.delete(url); cache.set(url, hit); return Promise.resolve(hit) }
    let work = pending.get(url)
    if (!work) {
      let resolve!: (v: T) => void, reject!: (e: unknown) => void
      const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
      work = { url, priority, users: 0, started: false, settled: false, controller: new AbortController(), promise, resolve, reject }
      pending.set(url, work); queue.push(work)
    } else work.priority = Math.min(work.priority, priority)
    const owner = work; owner.users++
    const result = new Promise<T>((resolve, reject) => {
      let done = false
      const finish = (callback: () => void) => {
        if (done) return
        done = true; signal?.removeEventListener('abort', abort); owner.users--
        if (!owner.users && !owner.settled) {
          // A resolved promise may run just before its finally; aborting here is harmless.
          owner.controller.abort()
          if (pending.get(url) === owner) pending.delete(url)
          const index = queue.indexOf(owner); if (index >= 0) queue.splice(index, 1)
        }
        callback()
      }
      const abort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')))
      signal?.addEventListener('abort', abort, { once: true })
      owner.promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)))
    })
    pump()
    return result
  }
}

async function imageAttempt(url: string, signal: AbortSignal, priority: number): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image(); image.decoding = 'async'
    image.fetchPriority = priority === 0 ? 'high' : priority >= 2 ? 'low' : 'auto'
    const timer = window.setTimeout(() => finish(new Error('地图瓦片读取超时')), 8000)
    let done = false
    const finish = (error?: Error) => {
      if (done) return
      done = true; clearTimeout(timer); image.onload = image.onerror = null; signal.removeEventListener('abort', abort)
      if (error) { image.removeAttribute('src'); reject(error) } else resolve(image)
    }
    const abort = () => finish(new DOMException('Aborted', 'AbortError'))
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    image.onload = () => {
      if (!image.naturalWidth) { finish(new Error('地图瓦片无法解码')); return }
      if (image.decode) void image.decode().then(() => finish(), () => finish(new Error('地图瓦片无法解码')))
      else finish()
    }
    image.onerror = () => finish(new Error('地图瓦片暂不可用'))
    image.src = url
  })
}
/** At most ~48 MiB of decoded RGBA pixels on desktop, ~24 MiB on small devices. */
const compactDevice = (typeof matchMedia !== 'undefined' && matchMedia('(max-width: 767px), (pointer: coarse)').matches)
  || (typeof navigator !== 'undefined' && ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 4)
export const loadMapTile = createTilePool<HTMLImageElement>(async (url, signal, priority) => {
  try { return await imageAttempt(url, signal, priority) } catch (error) {
    if (signal.aborted) throw error
    return imageAttempt(url, signal, priority)
  }
}, compactDevice ? 96 : 192, compactDevice ? 6 : 12)

/** Preload only the two usual nationwide views, not every zoom level or every radar frame. */
export async function prepareMapViewport(signal?: AbortSignal) {
  if (document.hidden) return
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  if (connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType ?? '')) return
  const width = Math.max(320, innerWidth * .7), height = Math.max(300, Math.min(600, innerHeight * .45))
  const urls = new Set<string>()
  for (const z of [4, 5]) {
    const n = 2 ** z, latitude = 35.5 * Math.PI / 180
    const cx = (104 + 180) / 360 * n * 256
    const cy = (1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2 * n * 256
    for (let y = Math.floor((cy - height / 2) / 256); y <= Math.floor((cy + height / 2) / 256); y++) {
      for (let x = Math.floor((cx - width / 2) / 256); x <= Math.floor((cx + width / 2) / 256); x++) {
        if (y >= 0 && y < n) urls.add(`/api/map/amap/vec/${z}/${(x % n + n) % n}/${y}`)
      }
    }
  }
  const controller = new AbortController(), abort = () => controller.abort()
  if (signal?.aborted) return
  signal?.addEventListener('abort', abort, { once: true })
  const timer = window.setTimeout(abort, 60000)
  try {
    const base = [...urls].map(url => loadMapTile(url, url.includes('/vec/4/') ? 2 : 3, controller.signal))
    const radar = loadRadarFrames().then(frames => {
      const latest = frames[frames.length - 1]
      if (!latest || controller.signal.aborted) return
      return Promise.allSettled([...urls].filter(url => url.includes('/vec/4/')).map(url =>
        loadMapTile(url.replace('/amap/vec/', `/radar${latest.path}/256/`) + '/4/1_1.png', 2, controller.signal)))
    })
    await Promise.allSettled([...base, radar])
  }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
export function scheduleMapPreparation() {
  let timer: number | undefined
  let controller: AbortController | undefined
  const schedule = () => {
    clearTimeout(timer); controller?.abort()
    if (!document.hidden) timer = window.setTimeout(() => { controller = new AbortController(); void prepareMapViewport(controller.signal) }, 2600)
  }
  schedule(); document.addEventListener('visibilitychange', schedule)
  return () => { clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', schedule) }
}
