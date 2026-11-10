import type { OsmData } from './impact'
import { createResourceCache } from './resourceCache'
import { decodeTerrarium, GRID_N, resample, smoothHeights, type TerrainMeta } from './terrain'
import { TERRAIN_RESERVE } from './terrainReserve'
import { unpackTerrainReserve } from './terrainReserveDecode'

export interface TerrainData { meta: TerrainMeta; heights: Float32Array; sourceVoidPixels?: number }
// Seven bundled demo terrains: ~4 MiB for all decoded height grids. Retain the
// complete finite catalog so cycling the dropdown does not decode it repeatedly.
const terrainCache = createResourceCache<TerrainData>(7)
const osmCache = createResourceCache<OsmData>(7)

export function loadTerrain(site: string): Promise<TerrainData> {
  return terrainCache(site, async () => {
    const bundled = TERRAIN_RESERVE[site]
    if (bundled) {
      // The entire finite catalog is part of the application dependency graph.
      // Once the app has opened, DEM navigation does not rely on another request.
      if (bundled.meta.site !== site) throw new Error('高程站点校验失败')
      const heights = unpackTerrainReserve(bundled)
      return { meta: bundled.meta, heights, sourceVoidPixels: bundled.sourceVoidPixels }
    }
    const controller = new AbortController()
    const image = new Image()
    let rejectImage: (error: Error) => void = () => {}
    const imageReady = new Promise<void>((resolve, reject) => {
      rejectImage = reject
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('高程图加载失败'))
      image.src = `/terrain/${site}-dem.png?v=${__BUILD_ID__}`
    })
    const timeout = window.setTimeout(() => {
      controller.abort()
      rejectImage(new Error('高程素材读取超时，请重试'))
    }, 20000)
    try {
      // Download both independent assets together, preserving the original decoding.
      const metadata = fetch(`/terrain/${site}.json?v=${__BUILD_ID__}`, { signal: controller.signal })
        .then(async response => {
          if (!response.ok) throw new Error(`高程元数据加载失败（${response.status}）`)
          return await response.json() as TerrainMeta
        })
      const [meta] = await Promise.all([metadata, imageReady])
      const canvas = document.createElement('canvas')
      canvas.width = meta.size[0]; canvas.height = meta.size[1]
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('无法创建 2D 上下文')
      ctx.drawImage(image, 0, 0)
      const rgba = ctx.getImageData(0, 0, meta.size[0], meta.size[1]).data
      const full = decodeTerrarium(rgba, meta.size[0])
      return { meta, heights: smoothHeights(resample(full, meta.size[0], GRID_N), GRID_N, 1) }
    } catch (error) {
      controller.abort()
      image.onload = null; image.onerror = null; image.src = ''
      throw error
    } finally {
      clearTimeout(timeout)
      image.onload = null; image.onerror = null
    }
  })
}

export function loadTerrainOsm(site: string): Promise<OsmData> {
  return osmCache(site, async () => {
    const bundled = TERRAIN_RESERVE[site]
    if (bundled) return bundled.osm
    const response = await fetch(`/terrain/${site}-osm.json?v=${__BUILD_ID__}`)
    if (!response.ok) throw new Error('路网素材暂不可用')
    return await response.json() as OsmData
  })
}
