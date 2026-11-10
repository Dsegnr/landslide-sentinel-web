import { describe, expect, it, beforeAll } from 'vitest'

import { loadProvinceIndex, locateText, provinceOf } from './geo'
// 直接 import 真实的中国 GeoJSON（与运行时同一份文件），保证结论可信
import chinaGeo from '../../public/geo/china-full.json'

beforeAll(() => {
  const n = loadProvinceIndex(chinaGeo)
  expect(n).toBeGreaterThan(30)
})

describe('经纬度 → 所在省份（离线，tooltip 里显示地址用）', () => {
  it('白家包（湖北秭归）落在湖北省', () => {
    expect(provinceOf(110.96, 30.83)).toBe('湖北省')
    expect(locateText(110.96, 30.83)).toBe('湖北省 · 110.96, 30.83')
  })

  it('皋兰山（兰州）落在甘肃省', () => {
    expect(provinceOf(103.83, 36.03)).toBe('甘肃省')
  })

  it('境外坐标返回 null，只给经纬度（不瞎猜省份）', () => {
    expect(provinceOf(2.35, 48.86)).toBeNull()
    expect(locateText(2.35, 48.86)).toBe('2.35, 48.86')
  })
})
