import { describe, expect, it } from 'vitest'
import { appendStreamPoint } from './series'
import type { SeriesPoint } from './types'

const point = (ts: number) => ({ ts: new Date(ts).toISOString(), D: 1 } as SeriesPoint)
describe('live series window', () => {
  it('retains more than 3000 valid points in the selected window and ignores duplicates', () => {
    const now = Date.UTC(2026, 9, 31)
    const points = Array.from({ length: 4000 }, (_, i) => point(now - (4000 - i) * 60000))
    const result = appendStreamPoint(points, point(now), 30, now)
    expect(result).toHaveLength(4001)
    expect(result[0]).toEqual(points[0])
    expect(appendStreamPoint(result, point(now), 30, now)).toHaveLength(4001)
  })
  it('expires points outside the selected time window', () => {
    const now = Date.UTC(2026, 9, 31)
    expect(appendStreamPoint([point(now - 2 * 86400000), point(now - 60000)], point(now), 1, now)).toHaveLength(2)
  })
})
