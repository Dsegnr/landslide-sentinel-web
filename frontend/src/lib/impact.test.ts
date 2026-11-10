import { describe, expect, it } from 'vitest'

import {
  approxMeters, classifyPlaces, classifyRoads, placeKindCn, roadKindCn,
  type OsmRoad,
} from './impact'

const SITE: [number, number] = [110.96, 30.83]

describe('影响范围求交', () => {
  it('近似距离：纬度 0.001° ≈ 110 m', () => {
    expect(approxMeters(110.96, 30.83, 110.96, 30.831)).toBeGreaterThan(105)
    expect(approxMeters(110.96, 30.83, 110.96, 30.831)).toBeLessThan(115)
    expect(approxMeters(110.96, 30.83, 110.96, 30.83)).toBe(0)
  })

  it('区内路段排在最前，区外路段也返回（带距离），便于回答"最近的路多远"', () => {
    const roads: OsmRoad[] = [
      { name: 'S255', kind: 'primary', pts: [[110.96, 30.83], [110.97, 30.84]] },
      { name: '村道', kind: 'track', pts: [[111.5, 31.5], [111.6, 31.6]] },
      { name: '沿江路', kind: 'secondary',
        pts: [[110.96, 30.83], [110.961, 30.831], [110.962, 30.832]] },
    ]
    // 影响区：只认离站点 0.003° 以内的点
    const inZone = (lon: number, lat: number) =>
      Math.abs(lon - SITE[0]) < 0.003 && Math.abs(lat - SITE[1]) < 0.003
    const out = classifyRoads(roads, inZone, SITE[0], SITE[1])
    // 三条都返回：区内两条在前（按受影响顶点数），区外的"村道"殿后
    expect(out.map((r) => r.name)).toEqual(['沿江路', 'S255', '村道'])
    expect(out.map((r) => r.inZone)).toEqual([true, true, false])
    expect(out[0].affected).toBe(3)
    expect(out[0].total).toBe(3)
    expect(out[1].affected).toBe(1)
    expect(out[0].nearestM).toBeLessThan(5)
    // 区外路段只报距离，不谎报"受影响"
    expect(out[2].affected).toBe(0)
    expect(out[2].nearestM).toBeGreaterThan(1000)
  })

  it('村镇：影响区内的排在前面，距离四舍五入到米', () => {
    const places = [
      { name: '远处的村', kind: 'village', lon: 111.2, lat: 31.0 },
      { name: '坡下的镇', kind: 'town', lon: 110.9605, lat: 30.8305 },
    ]
    const inZone = (lon: number, lat: number) =>
      Math.abs(lon - SITE[0]) < 0.002 && Math.abs(lat - SITE[1]) < 0.002
    const out = classifyPlaces(places, inZone, SITE[0], SITE[1])
    expect(out[0].name).toBe('坡下的镇')
    expect(out[0].inZone).toBe(true)
    expect(out[1].inZone).toBe(false)
    expect(Number.isInteger(out[0].distanceM)).toBe(true)
  })

  it('道路/村镇类型有中文名，未知类型原样返回', () => {
    expect(roadKindCn('primary')).toBe('主干道')
    expect(roadKindCn('weird')).toBe('weird')
    expect(placeKindCn('town')).toBe('镇')
    expect(placeKindCn('weird')).toBe('weird')
  })
})
