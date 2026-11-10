import { describe, expect, it } from 'vitest'

import {
  GRID_N, computeRunout, decodeTerrarium, lonLatToCell, lonLatToPlane,
  planeToLonLat, resample, sampleHeight, slopeAt, terrainColor,
} from './terrain'

const BBOX = { west: 110.9, east: 111.0, south: 30.8, north: 30.9 }

describe('三维坡体的纯计算', () => {
  it('Terrarium 解码：R*256+G+B/256-32768', () => {
    // (128, 0, 0) -> 128*256 - 32768 = 0 米
    const data = new Uint8ClampedArray([128, 0, 0, 255, 129, 0, 0, 255])
    const h = decodeTerrarium(data, 2)
    expect(h[0]).toBeCloseTo(0, 6)
    expect(h[1]).toBeCloseTo(256, 6)
  })

  it('重采样保持尺寸与极值（最近邻，不插值造假细节）', () => {
    const src = new Float32Array([1, 2, 3, 4])
    const out = resample(src, 2, 3)
    expect(out.length).toBe(9)
    expect(Math.min(...out)).toBe(1)
    expect(Math.max(...out)).toBe(4)
  })

  it('经纬度 → 平面：中心在原点，西/北为负', () => {
    const [x, z] = lonLatToPlane(110.95, 30.85, BBOX, 1000, 1000)
    expect(x).toBeCloseTo(0, 3)
    expect(z).toBeCloseTo(0, 3)
    const [xw, zn] = lonLatToPlane(110.9, 30.9, BBOX, 1000, 1000)
    expect(xw).toBeCloseTo(-500, 3)
    expect(zn).toBeCloseTo(-500, 3)
  })

  it('高程色带：两端不同、范围外被夹住', () => {
    expect(terrainColor(0)).not.toEqual(terrainColor(1))
    expect(terrainColor(-5)).toEqual(terrainColor(0))
    expect(terrainColor(9)).toEqual(terrainColor(1))
  })

  it('坡度：平地 0，斜坡随高差增大', () => {
    const n = 3
    const flat = new Float32Array([10, 10, 10, 10, 10, 10, 10, 10, 10])
    expect(slopeAt(flat, n, 1, 1, 10)).toBeCloseTo(0, 6)
    // 每格（10 m）升高 10 m -> 坡度 1.0（100%，即 45°）
    const ramp = new Float32Array([0, 10, 20, 0, 10, 20, 0, 10, 20])
    expect(slopeAt(ramp, n, 1, 1, 10)).toBeCloseTo(1.0, 3)
  })

  it('768 的高程图按"每 2 像素一点"抽成 384 网格', () => {
    const step = (768 - 1) / (GRID_N - 1)
    expect(step).toBeGreaterThan(1.9)
    expect(step).toBeLessThan(2.1)
  })

  it('经纬度 → 栅格索引：包围盒中心落在网格中心', () => {
    const n = 5
    const [i, j] = lonLatToCell(110.95, 30.85, BBOX, n)
    expect(i).toBeCloseTo(2, 6)
    expect(j).toBeCloseTo(2, 6)
    const [x, y] = lonLatToCell(110.9, 30.9, BBOX, n)   // 西北角
    expect(x).toBeCloseTo(0, 6)
    expect(y).toBeCloseTo(0, 6)
  })

  it('平面 → 经纬度是 lonLatToPlane 的逆变换（点选滑坡源区要用）', () => {
    for (const [lon, lat] of [[110.95, 30.85], [110.9, 30.9], [110.98, 30.81]] as const) {
      const [x, z] = lonLatToPlane(lon, lat, BBOX, 1000, 800)
      const [lon2, lat2] = planeToLonLat(x, z, BBOX, 1000, 800)
      expect(lon2).toBeCloseTo(lon, 9)
      expect(lat2).toBeCloseTo(lat, 9)
    }
  })

  it('双线性高程采样：中心等于四点平均，越界返回 null', () => {
    const n = 2
    const hs = new Float32Array([0, 10, 20, 30])        // [j*n+i]
    expect(sampleHeight(hs, n, 0.5, 0.5)).toBeCloseTo(15, 6)
    expect(sampleHeight(hs, n, 0, 0)).toBeCloseTo(0, 6)
    expect(sampleHeight(hs, n, -0.1, 0)).toBeNull()
    expect(sampleHeight(hs, n, 0, 5)).toBeNull()
  })

  it('下坡推演：只往低处走、受落差与距离限制', () => {
    const n = 8
    const cell = 10
    const hs = new Float32Array(n * n)
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) hs[j * n + i] = 200 - 4 * i - 3 * j
    }
    const r = computeRunout(hs, n, cell, 0, 0, 30, 40)
    expect(r.mask[0]).toBe(1)                    // 起点一定在
    expect(r.cells).toBeGreaterThan(3)
    expect(r.mask[7 * n + 7]).toBe(0)            // 落差 49 m > 上限 30 m，到不了
    for (let idx = 0; idx < n * n; idx++) {
      if (r.mask[idx]) expect(r.drop[idx]).toBeLessThanOrEqual(30 + 1e-6)
    }
  })

  it('下坡推演：前方是高地时不会翻过去', () => {
    const n = 4
    const hs = new Float32Array([100, 300, 50, 50,
                                 90, 300, 40, 40,
                                 80, 300, 30, 30,
                                 70, 300, 20, 20])
    const r = computeRunout(hs, n, 10, 0, 0, 1000, 1000)
    expect(r.mask[0]).toBe(1)
    expect(r.mask[1]).toBe(0)                    // 隔壁是 300 m 的高地，走不过去
    expect(r.mask[2]).toBe(0)                    // 高地后面也到不了
  })

  it('惯性：能翻过小坎；没有惯性时严格下坡会停在小坎前', () => {
    // 只留第 0 列可走，其余全是高墙，避免横向扩散干扰计数
    const n = 5
    const hs = new Float32Array(n * n).fill(9999)
    const profile = [100, 90, 91, 80, 70]        // 90 → 91 是 1 m 的小坎
    profile.forEach((h, j) => { hs[j * n] = h })

    const strict = computeRunout(hs, n, 15, 0, 0, 1000, 1000)
    expect(strict.cells).toBe(2)                 // 100、90 之后就上不去了

    const withInertia = computeRunout(hs, n, 15, 0, 0, 1000, 1000,
      { maxClimbPerCell: 1.8, maxClimbTotal: 15 })
    expect(withInertia.cells).toBe(5)            // 翻过小坎，一路到 70
  })

  it('惯性预算用完就停：累计上坡超过预算不再前进', () => {
    const n = 5
    const hs = new Float32Array(n * n).fill(9999)
    const profile = [100, 90, 91, 90, 91]        // 两次 1 m 小坎
    profile.forEach((h, j) => { hs[j * n] = h })

    const r = computeRunout(hs, n, 15, 0, 0, 1000, 1000,
      { maxClimbPerCell: 1.8, maxClimbTotal: 1 })
    expect(r.cells).toBe(4)                      // 第 2 次上坡要 2 m > 预算 1 m，被拦住
    expect(r.mask[4 * n]).toBe(0)
  })
})
