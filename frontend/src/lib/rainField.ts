/** 把稀疏的网格降水点渲染成**连续雨区图**（而不是一个个圆点）。

 *  思路：先在离屏画布上按"雨强 → 光斑强度"累积出一张灰度强度场，
 *  再把强度场映射成颜色+透明度。相邻光斑叠加后自然连成片、边缘柔和，
 *  观感接近雷达降水图；同时**强度决定光斑半径与不透明度**，
 *  这样 0.1 mm 的毛毛雨不会和 2 mm 的中雨看起来一样重。
 */
import type { WeatherGridPoint } from './api'

export interface RainBounds {
  west: number
  east: number
  south: number
  north: number
}

/** 中国主体范围：地图上的降水图层就铺在这个框里 */
export const RAIN_BOUNDS: RainBounds = {
  west: 73, east: 136, south: 17, north: 55,
}

/** 强度 → 颜色（浅蓝 → 蓝 → 绿 → 黄 → 橙） */
function ramp(v: number): [number, number, number] {
  const stops: Array<[number, [number, number, number]]> = [
    [0.00, [125, 211, 252]],
    [0.22, [56, 189, 248]],
    [0.45, [34, 197, 94]],
    [0.68, [250, 204, 21]],
    [1.00, [251, 146, 60]],
  ]
  const x = Math.min(1, Math.max(0, v))
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i]
    if (x <= t1) {
      const [t0, c0] = stops[i - 1]
      const k = t1 === t0 ? 0 : (x - t0) / (t1 - t0)
      return [
        c0[0] + (c1[0] - c0[0]) * k,
        c0[1] + (c1[1] - c0[1]) * k,
        c0[2] + (c1[2] - c0[2]) * k,
      ]
    }
  }
  return stops[stops.length - 1][1]
}

/** 2.5 mm/h 及以上按满强度处理 */
const FULL_SCALE = 2.5
/** 低于该雨强的像元不显示（0.05 mm/h 以下基本是数值噪声） */
const MIN_SHOW = 0.03
/** 网格步长（度）：全国网格是 2°×2° */
const GRID_DEG = 2

export function buildRainCanvas(
  points: WeatherGridPoint[],
  width = 640,
  height = 460,
  bounds: RainBounds = RAIN_BOUNDS,
): HTMLCanvasElement | null {
  const wet = points.filter((p) => p.precip >= MIN_SHOW)
  if (!wet.length) return null
  const cv = document.createElement('canvas')
  cv.width = width
  cv.height = height
  const ctx = cv.getContext('2d')
  if (!ctx) return null
  const spanLon = bounds.east - bounds.west
  const spanLat = bounds.north - bounds.south
  const toXY = (lon: number, lat: number): [number, number] => [
    ((lon - bounds.west) / spanLon) * width,
    ((bounds.north - lat) / spanLat) * height,
  ]

  // 1) 累积强度场：半径与不透明度都随雨强增大
  //    半径以"网格步长"为基准（≈ 一格），这样相邻的湿点必然重叠、
  //    连成片；按像素定半径会随画布缩放而失效（上一版就是这样变成零散小点）。
  const spacingPx = width / ((bounds.east - bounds.west) / GRID_DEG)
  ctx.globalCompositeOperation = 'lighter'
  for (const p of wet) {
    const [x, y] = toXY(p.lon, p.lat)
    const strength = Math.min(1, p.precip / FULL_SCALE)
    const radius = spacingPx * (0.85 + 1.9 * strength)
    // 弱雨也要看得见（参考图里毛毛雨就是一层淡蓝），但不能糊成一片
    const alpha = 0.17 + 0.40 * Math.pow(strength, 1.5)
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius)
    g.addColorStop(0, `rgba(255,255,255,${alpha})`)
    g.addColorStop(0.55, `rgba(255,255,255,${alpha * 0.35})`)
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalCompositeOperation = 'source-over'

  // 2) 先做一次模糊：网格是 2° 一格，模糊后色块边界不再"一格一格"，
  //    观感更接近雷达降水图（代价只是几毫秒）
  const blurred = document.createElement('canvas')
  blurred.width = width
  blurred.height = height
  const bctx = blurred.getContext('2d')
  if (bctx) {
    bctx.filter = 'blur(7px)'
    bctx.drawImage(cv, 0, 0)
  }

  // 3) 强度场 → 颜色（透明度也随强度变化，弱雨只是淡淡一层）
  const img = (bctx ? bctx : ctx).getImageData(0, 0, width, height)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i + 3] / 255
    if (v < 0.035) {
      d[i + 3] = 0
      continue
    }
    const [r, g, b] = ramp(Math.min(1, v * 1.35))
    d[i] = r
    d[i + 1] = g
    d[i + 2] = b
    d[i + 3] = Math.min(215, 55 + v * 230)
  }
  ctx.putImageData(img, 0, 0)
  return cv
}
