// 经纬度 → 所在省份：用本地 GeoJSON 做点-面判定（离线，不依赖地理编码服务）。
// 用途：地图 tooltip 与站点详情里显示"这是哪儿"，而不是只丢一对经纬度。

interface GeoFeature {
  properties: { name?: string }
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown }
}

interface BBox {
  minLon: number
  minLat: number
  maxLon: number
  maxLat: number
}

interface Poly {
  box: BBox
  ring: number[][]
}

interface Indexed {
  name: string
  polys: Poly[]
}

// 预计算外接矩形：省份多边形顶点很多，逐次遍历会把 tooltip 拖慢
let index: Indexed[] = []

function ringBox(ring: number[][]): BBox {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }
  return { minLon, minLat, maxLon, maxLat }
}

/** 射线法：判断点是否在环内 */
function inRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    const crosses = (yi > lat) !== (yj > lat)
      && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (crosses) inside = !inside
  }
  return inside
}

/** 载入本地中国 GeoJSON，建立省份索引；返回省份数量。 */
export function loadProvinceIndex(geo: unknown): number {
  const features = ((geo as { features?: GeoFeature[] }).features ?? [])
  index = []
  for (const f of features) {
    const name = f.properties?.name
    const geometry = f.geometry
    if (!name || !geometry) continue
    const polys: number[][][][] = geometry.type === 'Polygon'
      ? [geometry.coordinates as number[][][]]
      : (geometry.coordinates as number[][][][])
    index.push({
      name,
      polys: polys.map((p) => ({ box: ringBox(p[0]), ring: p[0] })),
    })
  }
  return index.length
}

/** 返回省份名（不在中国境内或索引未加载时返回 null）。 */
export function provinceOf(lon: number, lat: number): string | null {
  for (const prov of index) {
    for (const poly of prov.polys) {
      const { box } = poly
      if (lon < box.minLon || lon > box.maxLon || lat < box.minLat || lat > box.maxLat) continue
      if (inRing(lon, lat, poly.ring)) return prov.name
    }
  }
  return null
}

/** tooltip 里显示用：`湖北省 · 110.96, 30.83`（查不到省份就只给经纬度）。 */
export function locateText(lon: number, lat: number): string {
  const province = provinceOf(lon, lat)
  const coords = `${lon.toFixed(2)}, ${lat.toFixed(2)}`
  return province ? `${province} · ${coords}` : coords
}
