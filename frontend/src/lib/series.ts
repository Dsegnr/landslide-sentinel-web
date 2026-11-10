import type { SeriesPoint } from './types'

// Keep the selected time window when a live packet arrives; a fixed row cap
// silently shortened long windows according to the device sampling interval.
export function appendStreamPoint(points: SeriesPoint[], point: SeriesPoint, days: number, now = Date.now()) {
  const cutoff = now - days * 86400000
  const window = points.filter(p => new Date(p.ts).getTime() >= cutoff)
  return window.some(p => p.ts === point.ts) ? window : [...window, point]
}
