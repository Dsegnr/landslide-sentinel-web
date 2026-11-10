import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('./terrainAssets',()=>({loadTerrain:vi.fn(async()=>({})),loadTerrainOsm:vi.fn(async()=>({}))}))
vi.mock('./opsPreparation',()=>({prepareOps:vi.fn()}))
vi.mock('./mapTilePool',()=>({prepareMapViewport:vi.fn()}))
import { loadTerrain, loadTerrainOsm } from './terrainAssets'
import { scheduleTerrainCatalogPreparation } from './routeResources'
beforeEach(()=>{vi.useFakeTimers();vi.clearAllMocks();vi.spyOn(document,'hidden','get').mockReturnValue(false)})
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks()})
describe('terrain catalog preparation',()=>{
 it('prepares each remaining terrain once in sequential background batches',async()=>{
  const stop=scheduleTerrainCatalogPreparation('baijiabao')
  await vi.advanceTimersByTimeAsync(1500);expect(loadTerrain).not.toHaveBeenCalled()
  await vi.runAllTimersAsync()
  expect(vi.mocked(loadTerrain).mock.calls.map(([id])=>id)).toEqual(['gaolan','shuiping','baishuihe','bazimen','xintan','lianziya'])
  expect(loadTerrainOsm).toHaveBeenCalledTimes(6);stop()
 })
 it('pauses while hidden and stops scheduling after cancellation',async()=>{
  vi.spyOn(document,'hidden','get').mockReturnValue(true)
  const stop=scheduleTerrainCatalogPreparation('baijiabao')
  await vi.advanceTimersByTimeAsync(3000);expect(loadTerrain).not.toHaveBeenCalled()
  vi.spyOn(document,'hidden','get').mockReturnValue(false)
  await vi.advanceTimersByTimeAsync(350);expect(loadTerrain).toHaveBeenCalledTimes(1)
  stop();await vi.advanceTimersByTimeAsync(3000);expect(loadTerrain).toHaveBeenCalledTimes(1)
 })
})
