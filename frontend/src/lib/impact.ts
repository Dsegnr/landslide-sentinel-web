/** 影响范围推演里的"求交"部分：把地形推演出来的可达区，落到路网与村镇上。
 *
 *  纯函数，方便单测；数据来自本地打包的 OpenStreetMap 切片（© OSM contributors, ODbL）。
 */

export interface OsmRoad {
  name: string
  kind: string
  pts: [number, number][]          // [lon, lat]
}

export interface OsmPlace {
  name: string
  kind: string
  lon: number
  lat: number
}

export interface OsmData {
  site: string
  bbox: { west: number; east: number; north: number; south: number }
  fetched: string
  source: string
  roads: OsmRoad[]
  places: OsmPlace[]
}

export interface RoadImpact {
  name: string
  kind: string
  /** 落在影响区内的顶点数 */
  affected: number
  /** 该路段总顶点数 */
  total: number
  /** 距滑坡点的最近距离（米，近似） */
  nearestM: number
  /** 是否至少有一个顶点落进可达区 */
  inZone: boolean
}

export interface PlaceImpact extends OsmPlace {
  inZone: boolean
  distanceM: number
}

const M_PER_DEG_LAT = 110_540

/** 近似的米制距离（小范围内够用；不追求大地测量精度） */
export function approxMeters(
  lon1: number, lat1: number, lon2: number, lat2: number,
): number {
  const dx = (lon2 - lon1) * 111_320 * Math.cos((lat1 * Math.PI) / 180)
  const dy = (lat2 - lat1) * M_PER_DEG_LAT
  return Math.hypot(dx, dy)
}

/** 逐条路段统计：有多少顶点落进影响区、离滑坡点多远。
 *
 *  `inZone(lon,lat)` 由地形推演的结果提供（可以是网格查表，也可以是别的判据）。
 *
 *  **可达区外的路段也返回**（inZone=false），按"区内优先 + 由近到远"排序：
 *  只报"0 段"会让人以为"对路完全没影响"，但真正该看的是"最近的路离滑坡口多远"——
 *  白家包的香溪长江公路最近只有约 67 m，旧口径下这条信息直接消失了（见 P25）。
 */
export function classifyRoads(
  roads: OsmRoad[],
  inZone: (lon: number, lat: number) => boolean,
  siteLon: number,
  siteLat: number,
): RoadImpact[] {
  const out: RoadImpact[] = []
  for (const road of roads) {
    let affected = 0
    let nearest = Number.POSITIVE_INFINITY
    for (const [lon, lat] of road.pts) {
      if (inZone(lon, lat)) affected += 1
      nearest = Math.min(nearest, approxMeters(siteLon, siteLat, lon, lat))
    }
    out.push({
      name: road.name || '（未命名路段）',
      kind: road.kind,
      affected,
      total: road.pts.length,
      nearestM: Math.round(nearest),
      inZone: affected > 0,
    })
  }
  return out.sort((a, b) => Number(b.inZone) - Number(a.inZone)
    || b.affected - a.affected
    || a.nearestM - b.nearestM)
}

/** 村镇：在不在影响区、离滑坡点多远（全部返回，便于按远近排序展示） */
export function classifyPlaces(
  places: OsmPlace[],
  inZone: (lon: number, lat: number) => boolean,
  siteLon: number,
  siteLat: number,
): PlaceImpact[] {
  return places
    .map((p) => ({
      ...p,
      inZone: inZone(p.lon, p.lat),
      distanceM: Math.round(approxMeters(siteLon, siteLat, p.lon, p.lat)),
    }))
    .sort((a, b) => Number(b.inZone) - Number(a.inZone) || a.distanceM - b.distanceM)
}

/** 道路等级的中文名（展示用；未知等级原样返回） */
const ROAD_CN: Record<string, string> = {
  motorway: '高速', trunk: '快速路', primary: '主干道', secondary: '次干道',
  tertiary: '支路', unclassified: '未分级路', residential: '居民区道路',
  service: '服务道路', track: '农道/林道',
}

export function roadKindCn(kind: string): string {
  return ROAD_CN[kind] ?? kind
}

const PLACE_CN: Record<string, string> = {
  city: '城市', town: '镇', village: '村', hamlet: '自然村',
}

export function placeKindCn(kind: string): string {
  return PLACE_CN[kind] ?? kind
}
