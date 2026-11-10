import L from 'leaflet'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReliableTileLayer } from './ReliableTileLayer'
import { loadMapTile } from './mapTilePool'
vi.mock('./mapTilePool', () => ({ loadMapTile: vi.fn() }))
class Layer extends ReliableTileLayer {
  make(x: number, z: number, done = vi.fn()) {
    Object.assign(this, { _tileZoom: z })
    return this.createTile(Object.assign(L.point(x, 2), { z }), done) as HTMLImageElement
  }
  abortAt(z: number) { Object.assign(this, { _tileZoom: z }); this._abortLoading() }
}
describe('shared image tiles during zoom', () => {
  beforeEach(() => { vi.mocked(loadMapTile).mockReset() })
  it('cancels old src-less pending images even when native complete is true', () => {
    vi.mocked(loadMapTile).mockReturnValue(new Promise(() => {}))
    const layer = new Layer('/{z}/{x}/{y}', {}, 0)
    const old = layer.make(1, 4), current = layer.make(2, 5)
    expect(old.complete).toBe(true); expect(old.getAttribute('src')).toBeNull()
    const tiles = { old: { el: old, coords: { z: 4 } }, current: { el: current, coords: { z: 5 } } }
    const remove = vi.fn((key: keyof typeof tiles) => { layer.fire('tileunload', { tile: tiles[key].el }); delete tiles[key] })
    Object.assign(layer, { _tiles: tiles, _removeTile: remove })
    layer.abortAt(5)
    expect(vi.mocked(loadMapTile).mock.calls[0][2]?.aborted).toBe(true)
    expect(vi.mocked(loadMapTile).mock.calls[1][2]?.aborted).toBe(false)
    expect(remove).toHaveBeenCalledExactlyOnceWith('old')
  })
  it('retains completed old imagery while the new zoom loads', async () => {
    const image = new Image(); image.src = '/cached.png'
    vi.mocked(loadMapTile).mockResolvedValue(image)
    const layer = new Layer('/{z}/{x}/{y}', {}, 0), done = vi.fn()
    const old = layer.make(1, 4, done)
    await Promise.resolve()
    old.dispatchEvent(new Event('load'))
    expect(done).toHaveBeenCalledOnce()
    Object.defineProperty(old, 'complete', { value: true })
    const remove = vi.fn()
    Object.assign(layer, { _tiles: { old: { el: old, coords: { z: 4 } } }, _removeTile: remove })
    layer.abortAt(5)
    expect(remove).not.toHaveBeenCalled()
    expect(vi.mocked(loadMapTile).mock.calls[0][2]?.aborted).toBe(false)
  })
})
