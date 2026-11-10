import type L from 'leaflet'
import { loadMapTile } from './mapTilePool'

/** The next centered viewport only; never walk the nationwide tile pyramid. */
export function nextViewportTiles(center: { x: number; y: number }, size: { x: number; y: number }, zoom: number, kind: 'vec' | 'img', limit = 32): string[] {
  if (!Number.isInteger(zoom) || zoom < 3 || zoom > 17 || ![center.x, center.y, size.x, size.y].every(Number.isFinite)) return []
  const n = 2 ** zoom, tiles: { x: number; y: number; distance: number }[] = []
  const halfX = Math.min(4096, Math.max(0, size.x)) / 2, halfY = Math.min(2160, Math.max(0, size.y)) / 2
  for (let y = Math.max(0, Math.floor((center.y - halfY) / 256)); y <= Math.min(n - 1, Math.floor((center.y + halfY) / 256)); y++) {
    for (let x = Math.floor((center.x - halfX) / 256); x <= Math.floor((center.x + halfX) / 256); x++) {
      tiles.push({ x, y, distance: (x * 256 + 128 - center.x) ** 2 + (y * 256 + 128 - center.y) ** 2 })
    }
  }
  tiles.sort((a, b) => a.distance - b.distance)
  return [...new Set(tiles.map(t => `/api/map/amap/${kind}/${zoom}/${(t.x % n + n) % n}/${t.y}`))].slice(0, Math.min(32, Math.max(0, Math.floor(limit))))
}

export function scheduleViewportWarmup(map: L.Map, layer: L.TileLayer, kind: 'vec' | 'img') {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  if (connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType ?? '')) return () => {}
  let idle: number | undefined, grace: number | undefined, expiry: number | undefined
  let current: AbortController | undefined
  const stop = () => { clearTimeout(idle); clearTimeout(grace); clearTimeout(expiry); current?.abort(); current = undefined }
  const schedule = () => {
    // Leaflet's moveend listener has already attached visible consumers to shared requests.
    stop()
    if (document.hidden) return
    idle = window.setTimeout(() => {
      if (document.hidden || layer.isLoading() || map.getZoom() >= 17) return
      const zoom = Math.floor(map.getZoom()) + 1
      const urls = nextViewportTiles(map.project(map.getCenter(), zoom), map.getSize(), zoom, kind)
      const scope = new AbortController(); current = scope
      expiry = window.setTimeout(() => scope.abort(), 18000)
      void Promise.allSettled(urls.map(url => loadMapTile(url, 2, scope.signal))).finally(() => {
        if (current === scope) { clearTimeout(expiry); current = undefined }
      })
    }, 750)
  }
  const moving = () => {
    clearTimeout(idle); clearTimeout(grace)
    // A usual zoom finishes in 250ms; let visible tiles claim matching prefetch work first.
    grace = window.setTimeout(stop, 350)
  }
  const visibility = () => document.hidden ? stop() : schedule()
  map.on('movestart zoomstart', moving)
  map.on('moveend zoomend', schedule)
  layer.on('load', schedule)
  document.addEventListener('visibilitychange', visibility)
  schedule()
  return () => {
    stop(); map.off('movestart zoomstart', moving); map.off('moveend zoomend', schedule)
    layer.off('load', schedule); document.removeEventListener('visibilitychange', visibility)
  }
}
