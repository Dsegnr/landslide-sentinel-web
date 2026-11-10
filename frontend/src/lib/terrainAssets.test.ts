import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeTerrarium, GRID_N, resample, smoothHeights } from './terrain'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { TERRAIN_GRIDS } from './terrainGridCatalog'

const rgba = new Uint8ClampedArray(4*4*4)
for(let i=0;i<16;i++){rgba[i*4]=128;rgba[i*4+1]=i*2;rgba[i*4+3]=255}
const meta={size:[4,4],grid:384}
let images: string[]
beforeEach(()=>{
  vi.resetModules();images=[]
  class MockImage {
    onload:(()=>void)|null=null;onerror:(()=>void)|null=null
    set src(value:string){images.push(value);if(value)queueMicrotask(()=>this.onload?.())}
  }
  vi.stubGlobal('Image',MockImage)
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:vi.fn(),getImageData:()=>({data:rgba})} as unknown as CanvasRenderingContext2D)
})
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()})

describe('terrain release assets',()=>{
 it('starts image and metadata together and preserves every decoded grid value',async()=>{
  let resolve!:(value:unknown)=>void
  const fetcher=vi.fn(()=>new Promise(r=>{resolve=r}))
  vi.stubGlobal('fetch',fetcher)
  const {loadTerrain}=await import('./terrainAssets')
  const first=loadTerrain('a'),second=loadTerrain('a')
  await Promise.resolve()
  expect(images[0]).toContain('/terrain/a-dem.png')
  expect(fetcher).toHaveBeenCalledTimes(1)
  resolve({ok:true,json:async()=>meta})
  const result=await first
  const previous=smoothHeights(resample(decodeTerrarium(rgba,4),4,GRID_N),GRID_N,1)
  expect(result.heights).toEqual(previous)
  expect(await second).toBe(result)
  expect(await loadTerrain('a')).toBe(result)
  expect(fetcher).toHaveBeenCalledTimes(1)
 })
 it('retries an unavailable asset rather than retaining failure in the cache',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce({ok:false,status:503}).mockResolvedValue({ok:true,json:async()=>meta}))
  const {loadTerrain}=await import('./terrainAssets')
  await expect(loadTerrain('a')).rejects.toThrow('503')
  expect((await loadTerrain('a')).heights.length).toBe(GRID_N*GRID_N)
 })
 it('keeps all seven decoded demo grids across a full dropdown cycle',async()=>{
  const fetcher=vi.fn(async()=>({ok:true,json:async()=>meta}));vi.stubGlobal('fetch',fetcher)
  const {loadTerrain}=await import('./terrainAssets')
  const ids=['a','b','c','d','e','f','g']
  const first=await Promise.all(ids.map(loadTerrain))
  for(let i=0;i<ids.length;i++)expect(await loadTerrain(ids[i])).toBe(first[i])
  expect(fetcher).toHaveBeenCalledTimes(7);expect(images.filter(Boolean)).toHaveLength(7)
 })
 it('opens all seven exact grids even when every terrain HTTP request fails',async()=>{
  const fetcher=vi.fn(async()=>{throw new Error('offline')})
  vi.stubGlobal('fetch',fetcher)
  const {loadTerrain,loadTerrainOsm}=await import('./terrainAssets')
  for(const [id,entry]of Object.entries(TERRAIN_GRIDS)){
   const result=await loadTerrain(id)
   expect(result.meta.site).toBe(id);expect(result.heights).toHaveLength(GRID_N*GRID_N)
   expect(result.sourceVoidPixels).toBe(entry.sourceVoidPixels)
   expect(result.heights.every(Number.isFinite)).toBe(true)
   const expected=readFileSync(resolve('public/terrain',entry.file))
   expect(createHash('sha256').update(new Uint8Array(result.heights.buffer)).digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'))
   expect(JSON.stringify(await loadTerrainOsm(id))).toBe(JSON.stringify(JSON.parse(readFileSync(resolve('public/terrain',`${id}-osm.json`),'utf8'))))
  }
  expect(images).toHaveLength(0);expect(fetcher).not.toHaveBeenCalled()
 })
})
