import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { ARCHIVE_URL, presentDevices, presentMap, presentationSeries, type PresentationArchive } from './presentation'

const archive = JSON.parse(readFileSync(new URL('../../public' + ARCHIVE_URL, import.meta.url), 'utf8')) as PresentationArchive
describe('saved presentation scenes', () => {
  it('fixed nodes cover all five grades using the saved predictions', () => {
    const levels = new Set(archive.scenes.map(s => s.device.prediction!.combined_level))
    expect([...levels].sort()).toEqual([0, 1, 2, 3, 4])
    const expected: Record<string, number> = { 'demo-node-01': 0, 'demo-node-02': 1, 'demo-node-03': 2, 'demo-node-04': 3, 'slope-node-02': 4 }
    for (const s of archive.scenes) {
      if (s.device.device_id in expected) expect(s.device.prediction!.combined_level).toBe(expected[s.device.device_id])
      expect(s.predictions).toContainEqual(s.device.prediction)
      expect(s.device.prediction!.data_available).toBe(true)
    }
  })
  it('history ranges end at their saved timestamp rather than today and contain no later records', () => {
    for (const scene of archive.scenes) {
      const at = new Date(scene.device.presentation!.at).getTime()
      const response = presentationSeries(scene, 7)
      expect(response.items.length).toBeGreaterThan(0)
      expect(response.items.every(p => new Date(p.ts).getTime() <= at && new Date(p.ts).getTime() >= at - 7 * 86400000)).toBe(true)
      expect(response.predictions.at(-1)).toEqual(scene.device.prediction)
    }
  })
  it('does not mutate server records or turn archived alerts into real alerts', () => {
    const device = { ...archive.scenes[0].device, prediction: null, open_alerts: 9 }
    const response = { count: 1, items: [device], tuya_configured: false }
    const result = presentDevices(response, archive)
    expect(result.items[0].open_alerts).toBe(9)
    expect(result.items[0].prediction).not.toBeNull()
    expect(device.prediction).toBeNull()
    expect(presentDevices(response, null)).toBe(response)
  })
  it('keeps device, map and history grades fixed across midnight and a week of live updates', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const before = JSON.stringify(archive)
      for (const date of ['2026-10-31T15:59:59Z', '2026-10-31T16:00:01Z', '2026-11-01T04:00:00Z', '2026-11-08T04:00:00Z']) {
        vi.setSystemTime(new Date(date))
        const live = { count: archive.scenes.length, tuya_configured: false,
          items: archive.scenes.map(s => ({ ...s.device, presentation: undefined,
            prediction: { ...s.device.prediction!, combined_level: 0, stage: '平静', ts: new Date().toISOString() } })) }
        const shown = presentDevices(live, archive)
        const map = presentMap({ count: live.count, manual: [],
          nodes: live.items.map((d, i) => ({ id: i, device_id: d.device_id, name: d.name,
            lon: d.lon!, lat: d.lat!, level: 0, stage: '平静', weight: 1, watch: true,
            note: '', source: 'device' as const, active: true })),
          summary: { max_level: 0, max_stage: '平静', weighted_score: 0, watch_count: 0,
            manual_count: 0, device_count: live.count, level_counts: {} } }, archive)
        for (const scene of archive.scenes) {
          const grade = scene.device.prediction!.combined_level
          expect(shown.items.find(d => d.device_id === scene.device.device_id)?.prediction?.combined_level).toBe(grade)
          expect(map.nodes.find(n => n.device_id === scene.device.device_id)?.level).toBe(grade)
          for (const days of [1, 7, 30, 180]) expect(presentationSeries(scene, days).predictions.at(-1)?.combined_level).toBe(grade)
        }
        expect(map.summary.max_level).toBe(4)
      }
      expect(JSON.stringify(archive)).toBe(before)
    } finally { vi.useRealTimers() }
  })
})
