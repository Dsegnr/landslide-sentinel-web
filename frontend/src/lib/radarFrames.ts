export interface RadarFrame { time: number; path: string }
let retained: { at: number; promise: Promise<RadarFrame[]> } | undefined
/** Public metadata only; never keeps a frame list longer than one minute. */
export function loadRadarFrames() {
  if (retained && Date.now() - retained.at < 60000) return retained.promise
  const controller = new AbortController(), timer = window.setTimeout(() => controller.abort(), 8000)
  const promise = fetch('/api/map/radar-meta', { signal: controller.signal })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then((meta: { radar: { past: RadarFrame[]; nowcast: RadarFrame[] } }) => {
      const frames = [...meta.radar.past, ...meta.radar.nowcast]
      if (!frames.every(f => Number.isFinite(f.time) && /^\/v2\/radar\/[A-Za-z0-9_-]+$/.test(f.path))) throw new Error('雷达帧信息无效')
      return frames
    }).catch(error => { if (retained?.promise === promise) retained = undefined; throw error })
    .finally(() => clearTimeout(timer))
  retained = { at: Date.now(), promise }
  return promise
}
