import { afterEach, describe, expect, it, vi } from 'vitest'
const response = (path = '/v2/radar/test') => ({ ok: true, json: async () => ({ radar: { past: [{ time: 1790000000, path }], nowcast: [] } }) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('public radar metadata', () => {
  it('coalesces concurrent map/preload calls', async () => {
    vi.resetModules(); const fetcher=vi.fn(async()=>response());vi.stubGlobal('fetch',fetcher)
    const {loadRadarFrames}=await import('./radarFrames')
    const a=loadRadarFrames(),b=loadRadarFrames();expect(a).toBe(b);expect((await a)[0].path).toBe('/v2/radar/test');expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('refreshes the frame list after one minute', async () => {
    vi.resetModules();let now=100000;vi.spyOn(Date,'now').mockImplementation(()=>now)
    const fetcher=vi.fn().mockResolvedValueOnce(response('/v2/radar/old')).mockResolvedValueOnce(response('/v2/radar/new'));vi.stubGlobal('fetch',fetcher)
    const {loadRadarFrames}=await import('./radarFrames');await loadRadarFrames();now+=61000
    expect((await loadRadarFrames())[0].path).toBe('/v2/radar/new');expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('allows retry after a failed response', async () => {
    vi.resetModules();const fetcher=vi.fn().mockResolvedValueOnce({ok:false,status:503}).mockResolvedValueOnce(response());vi.stubGlobal('fetch',fetcher)
    const {loadRadarFrames}=await import('./radarFrames');await expect(loadRadarFrames()).rejects.toThrow('503');expect(await loadRadarFrames()).toHaveLength(1)
  })
  it('rejects unexpected remote paths before they become image requests', async () => {
    vi.resetModules();vi.stubGlobal('fetch',vi.fn(async()=>response('https://unexpected.example/tile')))
    const {loadRadarFrames}=await import('./radarFrames');await expect(loadRadarFrames()).rejects.toThrow('无效')
  })
})
