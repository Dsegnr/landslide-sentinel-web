import L from 'leaflet'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextViewportTiles, scheduleViewportWarmup } from './mapViewportWarmup'
import { loadMapTile } from './mapTilePool'
vi.mock('./mapTilePool', () => ({ loadMapTile: vi.fn() }))
class Events extends L.Evented {}
afterEach(() => { vi.useRealTimers(); vi.mocked(loadMapTile).mockReset() })
describe('bounded neighboring map preparation', () => {
  it('keeps native zoom, wraps longitude, clamps latitude and limits tile count', () => {
    const urls = nextViewportTiles({ x: 0, y: 128 }, { x: 1744, y: 478 }, 7, 'vec')
    expect(urls.length).toBeGreaterThan(0); expect(urls.length).toBeLessThanOrEqual(32)
    for (const url of urls) {
      const [z, x, y] = url.split('/').slice(-3).map(Number)
      expect(z).toBe(7); expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(128)
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThan(128)
    }
    expect(new Set(urls).size).toBe(urls.length)
    expect(nextViewportTiles({ x: 1000, y: 1000 }, { x: 10000, y: 10000 }, 10, 'img')).toHaveLength(32)
    expect(nextViewportTiles({ x: 0, y: 0 }, { x: 100, y: 100 }, 18, 'vec')).toEqual([])
  })
  it('waits for base tiles, bounds preparation and cancels unused work on movement or removal', async () => {
    vi.useFakeTimers()
    vi.mocked(loadMapTile).mockReturnValue(new Promise(() => {}))
    let loading = true
    const map = Object.assign(new Events(), { getZoom: () => 6, project: () => L.point(8000, 8000), getCenter: () => L.latLng(30, 110), getSize: () => L.point(1744, 478) }) as unknown as L.Map
    const layer = Object.assign(new Events(), { isLoading: () => loading }) as unknown as L.TileLayer
    const stop = scheduleViewportWarmup(map, layer, 'vec')
    await vi.advanceTimersByTimeAsync(750); expect(loadMapTile).not.toHaveBeenCalled()
    loading = false; layer.fire('load')
    await vi.advanceTimersByTimeAsync(750)
    expect(vi.mocked(loadMapTile).mock.calls.length).toBeLessThanOrEqual(32)
    expect(vi.mocked(loadMapTile).mock.calls.length).toBeGreaterThan(0)
    const signal = vi.mocked(loadMapTile).mock.calls[0][2]!
    map.fire('zoomstart'); expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(350); expect(signal.aborted).toBe(true)
    const count = vi.mocked(loadMapTile).mock.calls.length
    stop(); map.fire('moveend'); layer.fire('load')
    await vi.advanceTimersByTimeAsync(2000); expect(loadMapTile).toHaveBeenCalledTimes(count)
  })
})
