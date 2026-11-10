import L from 'leaflet'
import { loadMapTile } from './mapTilePool'

interface TileInternals {
  _tileZoom?: number
  _tiles?: Record<string, { el: HTMLElement; coords: L.Coords }>
  _removeTile: (key: string) => void
}

/** Leaflet keeps its usual projection/zoom levels; only tile fetching is shared and retried. */
export class ReliableTileLayer extends L.TileLayer {
  private requests = new WeakMap<HTMLElement, AbortController>()
  constructor(url: string, options: L.TileLayerOptions, private priority: number) {
    super(url, { updateWhenIdle: L.Browser.mobile, updateWhenZooming: false, updateInterval: 200, keepBuffer: 3, ...options })
    const cancel = (event: L.TileEvent) => {
      this.requests.get(event.tile)?.abort()
      this.requests.delete(event.tile)
      const image = event.tile as HTMLImageElement
      image.onload = image.onerror = null
    }
    this.on('tileunload', cancel)
    this.on('tileabort', cancel)
  }
  /** A src-less custom tile reports complete=true, so Leaflet's native abort misses it. */
  protected _abortLoading() {
    const state = this as unknown as TileInternals
    for (const [key, item] of Object.entries(state._tiles ?? {})) {
      if (item.coords.z !== state._tileZoom && this.requests.has(item.el)) {
        this.requests.get(item.el)?.abort()
        state._removeTile(key)
      }
    }
    ;(L.TileLayer.prototype as unknown as { _abortLoading: () => void })._abortLoading.call(this)
  }
  protected createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const tile = document.createElement('img'), controller = new AbortController()
    tile.alt = ''; tile.setAttribute('role', 'presentation'); tile.decoding = 'async'
    this.requests.set(tile, controller)
    void loadMapTile(this.getTileUrl(coords), this.priority, controller.signal).then(image => {
      if (controller.signal.aborted) return
      tile.onload = () => { this.requests.delete(tile); tile.onload = tile.onerror = null; done(undefined, tile) }
      tile.onerror = () => { this.requests.delete(tile); tile.onload = tile.onerror = null; done(new Error('地图瓦片无法解码'), tile) }
      tile.src = image.src
    }, error => {
      this.requests.delete(tile)
      if (!controller.signal.aborted) done(error instanceof Error ? error : new Error(String(error)), tile)
    })
    return tile
  }
}
