/** 三维坡体的纯计算部分：Terrarium 解码、重采样、经纬度→平面坐标、高程色带。
 *
 *  单独抽出来是为了能单测（不依赖 WebGL / three.js）。
 */

export interface TerrainMeta {
  site: string
  center: [number, number]
  zoom: number
  grid: number
  size: [number, number]
  tiles: number[]
  bbox: { west: number; east: number; north: number; south: number }
  elev_min: number
  elev_max: number
  source: string
}

/** 建网格用的采样点数：768 的高程图按"每 2 像素一点"抽成 384×384 网格 */
export const GRID_N = 384

/** Terrarium PNG：高程 = R*256 + G + B/256 − 32768（米） */
export function decodeTerrarium(data: Uint8ClampedArray, size: number): Float32Array {
  const out = new Float32Array(size * size)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768
  }
  return out
}

/** 最近邻重采样到 n×n（够用：DEM 本来就是栅格，不做插值不引入假细节） */
export function resample(src: Float32Array, size: number, n: number): Float32Array {
  if (size === n) return src
  const out = new Float32Array(n * n)
  const step = (size - 1) / (n - 1)
  for (let j = 0; j < n; j++) {
    const sy = Math.min(size - 1, Math.round(j * step))
    for (let i = 0; i < n; i++) {
      const sx = Math.min(size - 1, Math.round(i * step))
      out[j * n + i] = src[sy * size + sx]
    }
  }
  return out
}

/** 经纬度 → 地形平面坐标（x 向东、z 向南，原点在中心） */
export function lonLatToPlane(
  lon: number, lat: number, bbox: TerrainMeta['bbox'], width: number, depth: number,
): [number, number] {
  const u = (lon - bbox.west) / (bbox.east - bbox.west)
  const v = (bbox.north - lat) / (bbox.north - bbox.south)
  return [(u - 0.5) * width, (v - 0.5) * depth]
}

/** lonLatToPlane 的逆变换：把场景里的 (x, z) 还原成经纬度（点选滑坡源区时用）。 */
export function planeToLonLat(
  x: number, z: number, bbox: TerrainMeta['bbox'], width: number, depth: number,
): [number, number] {
  const u = x / width + 0.5
  const v = z / depth + 0.5
  return [
    bbox.west + u * (bbox.east - bbox.west),
    bbox.north - v * (bbox.north - bbox.south),
  ]
}

const RAMP: Array<[number, [number, number, number]]> = [
  [0.00, [0.05, 0.13, 0.24]],
  [0.35, [0.08, 0.30, 0.47]],
  [0.62, [0.16, 0.50, 0.62]],
  [0.82, [0.45, 0.72, 0.74]],
  [1.00, [0.85, 0.93, 0.92]],
]

/** 高程归一化值 → 颜色（深蓝→青→浅，配合深色大屏） */
export function terrainColor(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t))
  for (let i = 1; i < RAMP.length; i++) {
    const [t1, c1] = RAMP[i]
    if (x <= t1) {
      const [t0, c0] = RAMP[i - 1]
      const k = t1 === t0 ? 0 : (x - t0) / (t1 - t0)
      return [
        c0[0] + (c1[0] - c0[0]) * k,
        c0[1] + (c1[1] - c0[1]) * k,
        c0[2] + (c1[2] - c0[2]) * k,
      ]
    }
  }
  return RAMP[RAMP.length - 1][1]
}

/** 采样点的坡度（米/米），用于图上的陡缓描述与后续影响范围计算 */
export function slopeAt(
  hs: Float32Array, n: number, i: number, j: number, cellMeters: number,
): number {
  const at = (x: number, y: number) => hs[Math.min(n - 1, Math.max(0, y)) * n
    + Math.min(n - 1, Math.max(0, x))]
  const dx = (at(i + 1, j) - at(i - 1, j)) / (2 * cellMeters)
  const dz = (at(i, j + 1) - at(i, j - 1)) / (2 * cellMeters)
  return Math.hypot(dx, dz)
}

/** 3×3 均值平滑（可迭代）。
 *
 *  作用：压掉 DEM 里的单像素尖刺——不做这一步，三维地形上会冒出一根根
 *  扎向天空的针，既不好看也让人误以为真有陡峰。只做 1~2 遍，保留真实起伏。
 */
export function smoothHeights(hs: Float32Array, n: number, passes = 1): Float32Array {
  let cur = hs
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(cur.length)
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let sum = 0
        let cnt = 0
        for (let dy = -1; dy <= 1; dy++) {
          const y = j + dy
          if (y < 0 || y >= n) continue
          for (let dx = -1; dx <= 1; dx++) {
            const x = i + dx
            if (x < 0 || x >= n) continue
            sum += cur[y * n + x]
            cnt += 1
          }
        }
        out[j * n + i] = sum / cnt
      }
    }
    cur = out
  }
  return cur
}

/** 经纬度 → 栅格索引（可能带小数，用于双线性采样） */
export function cellSizeMeters(bbox: TerrainMeta['bbox'], n: number): number {
  const midLat = (bbox.north + bbox.south) / 2
  return Math.abs(bbox.east - bbox.west) * 111_320
    * Math.cos((midLat * Math.PI) / 180) / (n - 1)
}

export function lonLatToCell(
  lon: number, lat: number, bbox: TerrainMeta['bbox'], n: number,
): [number, number] {
  const u = (lon - bbox.west) / (bbox.east - bbox.west)
  const v = (bbox.north - lat) / (bbox.north - bbox.south)
  return [u * (n - 1), v * (n - 1)]
}

/** 双线性高程采样（越界返回 null，避免把范围外的点硬算进来） */
export function sampleHeight(
  hs: Float32Array, n: number, i: number, j: number,
): number | null {
  if (i < 0 || j < 0 || i > n - 1 || j > n - 1) return null
  const i0 = Math.floor(i)
  const j0 = Math.floor(j)
  const i1 = Math.min(n - 1, i0 + 1)
  const j1 = Math.min(n - 1, j0 + 1)
  const fi = i - i0
  const fj = j - j0
  const h00 = hs[j0 * n + i0]
  const h10 = hs[j0 * n + i1]
  const h01 = hs[j1 * n + i0]
  const h11 = hs[j1 * n + i1]
  return h00 * (1 - fi) * (1 - fj) + h10 * fi * (1 - fj)
    + h01 * (1 - fi) * fj + h11 * fi * fj
}

export interface RunoutResult {
  /** 1 = 该像元在下坡可达区内 */
  mask: Uint8Array
  /** 累计落差（米），用于给影响区上色 */
  drop: Float32Array
  /** 沿程水平距离（米），用于算移动角 */
  dist: Float32Array
  cells: number
  maxDrop: number
  maxDist: number
}

export interface RunoutOptions {
  /** 单步允许的最大**上坡**（米）。0 = 严格下坡（旧行为） */
  maxClimbPerCell?: number
  /** 全程允许的累计上坡（米）= "惯性预算"；翻过坡脚小坎靠它，而不是无限爬坡 */
  maxClimbTotal?: number
}

/** 简化"下坡可达区"推演。
 *
 *  这不是岩土数值模拟，而是一个**只用真实高程**的几何模型：
 *  从滑坡点出发，以"落差"当能量预算，往下游铺开——
 *  * 累计落差（起点高程 − 当前高程）不超过 `maxDropM`；
 *  * 离开起点的水平距离不超过 `maxDistM`；
 *  * **允许小幅上坡**（`maxClimbPerCell` / `maxClimbTotal`）：真实滑坡体有惯性，
 *    能翻过坡脚的小坎、冲上平地。原来"每步必须更低"的规则会让它遇到一个高 1 cm
 *    的像元就停死（真实 DEM 的平地噪声就是这样把推演卡在山腰的，见 P22）。
 *
 *  为什么比画个圆更有意义：结果会自然贴着冲沟、绕过山脊，是地形约束过的形状；
 *  也正因为简化，页面上必须写清"示意推演，非定量评估"。
 */
export function computeRunout(
  heights: Float32Array, n: number, cellMeters: number,
  startI: number, startJ: number, maxDropM: number, maxDistM: number,
  options: RunoutOptions = {},
): RunoutResult {
  const maxClimbCell = Math.max(0, options.maxClimbPerCell ?? 0)
  const maxClimbTotal = Math.max(0, options.maxClimbTotal ?? 0)
  const mask = new Uint8Array(n * n)
  const drop = new Float32Array(n * n)
  const distMap = new Float32Array(n * n)
  const diag = cellMeters * Math.SQRT2
  const sI = Math.round(startI)
  const sJ = Math.round(startJ)
  const startIdx = sJ * n + sI
  const maxCells = Math.ceil(maxDistM / cellMeters) + 1

  // 允许上坡之后就不能再按高程出队了：改成 Dijkstra，主代价 = **累计上坡**（惯性预算，
  // 稀缺资源），次代价 = 水平距离。每个像元只在被更优的 (上坡, 距离) 首次弹出时确定。
  const bestClimb = new Float32Array(n * n).fill(Infinity)
  const bestDist = new Float32Array(n * n).fill(Infinity)
  const heapClimb: number[] = []
  const heapDist: number[] = []
  const heapIdx: number[] = []
  const less = (a: number, b: number) => (
    heapClimb[a] < heapClimb[b]
    || (heapClimb[a] === heapClimb[b] && heapDist[a] < heapDist[b])
  )
  const swap = (a: number, b: number) => {
    ;[heapClimb[a], heapClimb[b]] = [heapClimb[b], heapClimb[a]]
    ;[heapDist[a], heapDist[b]] = [heapDist[b], heapDist[a]]
    ;[heapIdx[a], heapIdx[b]] = [heapIdx[b], heapIdx[a]]
  }
  const push = (climb: number, dist: number, idx: number) => {
    heapClimb.push(climb); heapDist.push(dist); heapIdx.push(idx)
    let k = heapClimb.length - 1
    while (k > 0) {
      const p = (k - 1) >> 1
      if (!less(k, p)) break
      swap(k, p)
      k = p
    }
  }
  const pop = () => {
    const out = { climb: heapClimb[0], dist: heapDist[0], idx: heapIdx[0] }
    const last = heapClimb.length - 1
    heapClimb[0] = heapClimb[last]; heapDist[0] = heapDist[last]; heapIdx[0] = heapIdx[last]
    heapClimb.pop(); heapDist.pop(); heapIdx.pop()
    let k = 0
    for (;;) {
      const l = 2 * k + 1
      const r = l + 1
      let m = k
      if (l < heapClimb.length && less(l, m)) m = l
      if (r < heapClimb.length && less(r, m)) m = r
      if (m === k) break
      swap(m, k)
      k = m
    }
    return out
  }

  if (startIdx < 0 || startIdx >= heights.length) {
    return { mask, drop, dist: distMap, cells: 0, maxDrop: 0, maxDist: 0 }
  }
  const startH = heights[startIdx]
  bestClimb[startIdx] = 0
  bestDist[startIdx] = 0
  push(0, 0, startIdx)
  let reached = 0
  let deepest = 0
  let farthest = 0

  while (heapClimb.length) {
    const { climb, dist, idx } = pop()
    if (mask[idx]) continue
    mask[idx] = 1
    const net = startH - heights[idx]              // 累计落差 = 起点高程 − 当前高程
    drop[idx] = net
    distMap[idx] = dist
    reached += 1
    deepest = Math.max(deepest, net)
    farthest = Math.max(farthest, dist)

    const i = idx % n
    const j = (idx - i) / n
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue
        const ni = i + di
        const nj = j + dj
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
        const nIdx = nj * n + ni
        if (mask[nIdx]) continue
        const nh = heights[nIdx]
        let nClimb = climb
        if (nh > heights[idx]) {                    // 上坡：吃惯性预算
          const up = nh - heights[idx]
          if (up > maxClimbCell) continue           // 单步上坡太大 = 真坡，走不上去
          nClimb = climb + up
          if (nClimb > maxClimbTotal) continue      // 惯性用完，停
        }
        if (startH - nh > maxDropM) continue        // 落差预算
        const stepMeters = (di !== 0 && dj !== 0) ? diag : cellMeters
        const nDist = dist + stepMeters
        if (nDist > maxDistM) continue
        if (nClimb > bestClimb[nIdx]
          || (nClimb === bestClimb[nIdx] && nDist >= bestDist[nIdx])) continue
        bestClimb[nIdx] = nClimb
        bestDist[nIdx] = nDist
        push(nClimb, nDist, nIdx)
      }
    }
  }
  void maxCells
  return { mask, drop, dist: distMap, cells: reached, maxDrop: deepest, maxDist: farthest }
}

/** 带强度分级的可达区结果 */
export interface TieredRunout extends RunoutResult {
  /** 2=高 1=中 0=低 255=不在可达区 */
  tier: Uint8Array
  /** 三档像元数 [低, 中, 高] */
  tierCells: [number, number, number]
  /** 三档面积（km²）[低, 中, 高] */
  tierKm2: [number, number, number]
  /** 被移动角筛掉的像元数与面积（km²）——"低流动性够不着"的那部分 */
  energyFilteredCells: number
  energyFilteredKm2: number
  /** 筛之前（纯地形可达）这片坡面能提供的最大移动角（度）。
   *  它很小就说明"这个点周围根本没有陡降到坡脚的通道"——要么坡很缓，
   *  要么站点坐标不落在滑坡体上（诊断用）。 */
  maxAngleBeforeDeg: number
}

/** 用**移动角（Fahrböschung / 能量线）**筛可达区并分强度。
 *
 *  tanα = (起点高程 − 该点高程) / 到起点的水平直线距离。α 越大说明这个点处在
 *  "越低流动性也能到"的范围内；α 很小的远端平地，只有大规模 / 高含水的泥石流才够得着。
 *
 *  为什么必须筛：只用"地形可达 + 落差/距离"两个上限时，缓坡盆地会被整片涂满，
 *  看起来像"全覆盖"，其实远端那些点只是"理论上能连过去"，物理上不现实。
 *
 *  分级（相对强度，**不是概率**）：高 α≥20°；中 15–20°；低 移动角下限–15°。
 */
export function applyEnergyLine(
  runout: RunoutResult, n: number, cellMeters: number,
  startI: number, startJ: number, minAngleDeg: number,
  midDeg = 15, hiDeg = 20,
): TieredRunout {
  const tanMin = Math.tan((minAngleDeg * Math.PI) / 180)
  const tanMid = Math.tan((midDeg * Math.PI) / 180)
  const tanHi = Math.tan((hiDeg * Math.PI) / 180)
  const tier = new Uint8Array(n * n).fill(255)
  const tierCells: [number, number, number] = [0, 0, 0]
  const cellKm2 = (cellMeters * cellMeters) / 1e6
  let cells = 0
  let filtered = 0
  let maxTanBefore = 0
  let maxDrop = 0
  let maxDist = 0
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const idx = j * n + i
      if (!runout.mask[idx]) continue
      const dLine = Math.hypot(i - startI, j - startJ) * cellMeters
      const tanA = Math.max(0, runout.drop[idx]) / Math.max(dLine, cellMeters)
      if (tanA > maxTanBefore) maxTanBefore = tanA
      if (tanA < tanMin) {           // 够不着：从可达区里剔除
        runout.mask[idx] = 0
        filtered += 1
        continue
      }
      const t = tanA >= tanHi ? 2 : tanA >= tanMid ? 1 : 0
      tier[idx] = t
      tierCells[t] += 1
      cells += 1
      if (runout.drop[idx] > maxDrop) maxDrop = runout.drop[idx]
      if (runout.dist[idx] > maxDist) maxDist = runout.dist[idx]
    }
  }
  return {
    ...runout,
    tier,
    tierCells,
    tierKm2: [
      tierCells[0] * cellKm2,
      tierCells[1] * cellKm2,
      tierCells[2] * cellKm2,
    ],
    energyFilteredCells: filtered,
    energyFilteredKm2: filtered * cellKm2,
    maxAngleBeforeDeg: (Math.atan(maxTanBefore) * 180) / Math.PI,
    cells,
    maxDrop,
    maxDist,
  }
}
