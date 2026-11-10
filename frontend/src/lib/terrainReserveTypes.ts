import type { TerrainMeta } from './terrain'
import type { OsmData } from './impact'
export interface TerrainReserve {
  meta: TerrainMeta
  packed: string
  sourceVoidPixels: number
  bytes: number
  sha256: string
  osm: OsmData
}
