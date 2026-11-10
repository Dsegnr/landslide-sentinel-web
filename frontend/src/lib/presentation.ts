import type { DeviceInfo, DevicesResponse, MapOverview, SeriesResponse } from './types'

export interface PresentationScene {
  device: DeviceInfo
  items: SeriesResponse['items']
  predictions: SeriesResponse['predictions']
}
export interface PresentationArchive { version: number; scenes: PresentationScene[] }
export const ARCHIVE_URL = '/assets/presentation-scenes-20261031-1a1fd9bb53e0.json'
let archive: Promise<PresentationArchive> | undefined
export function loadPresentation() {
  if (archive) return archive
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  archive = fetch(ARCHIVE_URL, { signal: controller.signal, cache: 'force-cache' }).then(async r => {
    if (!r.ok) throw new Error('回放场景读取失败，请刷新重试')
    const value = await r.json() as PresentationArchive
    if (value.version !== 1 || !Array.isArray(value.scenes) || !value.scenes.length ||
      value.scenes.some(s => !s.device?.presentation || !Number.isFinite(Date.parse(s.device.presentation.at)) ||
        !s.device.prediction || s.device.prediction.data_available === false ||
        !Array.isArray(s.items) || !Array.isArray(s.predictions))) {
      throw new Error('回放场景文件无效，请刷新重试')
    }
    return value
  }).catch(() => {
    // Never replace a fixed presentation with time-dependent live grades on failure.
    // Clear the failed promise so the next poll/refresh can retry.
    archive = undefined
    throw new Error('回放场景暂未加载，请刷新重试；暂不切换实时等级')
  }).finally(() => clearTimeout(timeout))
  return archive
}
export function presentDevices(live: DevicesResponse, archive: PresentationArchive | null): DevicesResponse {
  if (!archive) return live
  const saved = new Map(archive.scenes.map(s => [s.device.device_id, s.device]))
  return { ...live, items: live.items.map(d => {
    const scene = saved.get(d.device_id)
    return scene ? { ...scene, open_alerts: d.open_alerts, acked_alerts: d.acked_alerts } : d
  }) }
}
export function presentationSeries(scene: PresentationScene, days: number): SeriesResponse {
  const anchor = new Date(scene.device.presentation!.at).getTime()
  const cutoff = anchor - days * 86400000
  const inWindow = (p: { ts: string }) => {
    const time = new Date(p.ts).getTime()
    return time >= cutoff && time <= anchor
  }
  const items = scene.items.filter(inWindow)
  return { device_id: scene.device.device_id, days, count: items.length,
    station_id: scene.device.station_id, mode: scene.device.mode,
    items, predictions: scene.predictions.filter(inWindow) }
}
export function presentMap(live: MapOverview, archive: PresentationArchive | null): MapOverview {
  if (!archive || !Array.isArray(live.nodes)) return live
  const saved = new Map(archive.scenes.map(s => [s.device.device_id, s.device]))
  const nodes = live.nodes.map(n => {
    const d = n.source === 'device' ? saved.get(n.device_id ?? '') : undefined
    return d?.prediction ? { ...n, level: d.prediction.combined_level, stage: d.prediction.stage,
      data_available: d.prediction.data_available, note: `${d.presentation!.label} · ${d.presentation!.at}` } : n
  })
  const valid = nodes.filter(n => n.active && n.source !== 'site' && n.data_available !== false)
  const max = valid.reduce((a, n) => n.level > a.level ? n : a, { level: 0, stage: '平静' })
  const counts: Record<string, number> = {}
  for (const n of valid) counts[n.level] = (counts[n.level] ?? 0) + 1
  const weight = valid.reduce((a, n) => a + n.weight, 0)
  return { ...live, nodes, summary: { ...live.summary, max_level: max.level, max_stage: max.stage,
    level_counts: counts, weighted_score: weight ? valid.reduce((a, n) => a + n.level * n.weight, 0) / weight : 0 } }
}
