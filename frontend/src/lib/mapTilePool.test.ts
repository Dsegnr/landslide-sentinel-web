import { describe, expect, it, vi } from 'vitest'
import { createTilePool } from './mapTilePool'
const deferred = () => { let resolve!: (v: string) => void; const promise = new Promise<string>(r => { resolve = r }); return { promise, resolve } }
describe('map image pool', () => {
  it('shares decoded images and in-flight work across map instances', async () => {
    const d = deferred(), load = vi.fn(() => d.promise), pool = createTilePool(load)
    const a = pool('tile'), b = pool('tile'); expect(load).toHaveBeenCalledTimes(1)
    d.resolve('pixels'); expect(await a).toBe('pixels'); expect(await b).toBe('pixels')
    expect(await pool('tile')).toBe('pixels'); expect(load).toHaveBeenCalledTimes(1)
  })
  it('reserves capacity for active tiles when background warmup is queued', async () => {
    const jobs = new Map<string, ReturnType<typeof deferred>>()
    const load = vi.fn((url: string) => { const d = deferred(); jobs.set(url,d); return d.promise })
    const pool = createTilePool(load)
    const tasks = [pool('bg1',2),pool('bg2',2),pool('bg3',2),pool('bg4',2),pool('base',0)]
    expect([...jobs.keys()]).toEqual(['bg1','bg2','base'])
    jobs.get('base')!.resolve('base'); jobs.get('bg1')!.resolve('bg1'); jobs.get('bg2')!.resolve('bg2')
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    jobs.get('bg3')!.resolve('bg3'); jobs.get('bg4')!.resolve('bg4'); await Promise.all(tasks)
  })
  it('one unloaded map cannot abort tiles another map still needs', async () => {
    const d=deferred(), c=new AbortController();let active!:AbortSignal
    const pool=createTilePool((_url,s)=>{active=s;return d.promise})
    const a=pool('tile',0,c.signal).catch(e=>e.name), b=pool('tile')
    c.abort();expect(await a).toBe('AbortError');expect(active.aborted).toBe(false)
    d.resolve('good');expect(await b).toBe('good')
  })
  it('limits radar concurrency so new visible base tiles can start immediately', async () => {
    const jobs = new Map<string, ReturnType<typeof deferred>>()
    const pool = createTilePool((url: string) => { const d = deferred(); jobs.set(url, d); return d.promise }, 192, 12)
    const tasks = [...Array.from({ length: 8 }, (_, i) => pool(`radar${i}`, 1)), ...Array.from({ length: 12 }, (_, i) => pool(`base${i}`, 0))]
    expect([...jobs.keys()].filter(k => k.startsWith('radar'))).toHaveLength(4)
    expect([...jobs.keys()].filter(k => k.startsWith('base'))).toHaveLength(8)
    for (let round = 0; round < 5; round++) {
      for (const [url, d] of jobs) d.resolve(url)
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    }
    await Promise.all(tasks)
  })
  it('promotes queued prefetch work when a visible layer asks for the same tile', async () => {
    const jobs = new Map<string, ReturnType<typeof deferred>>()
    const pool = createTilePool((url: string) => { const d = deferred(); jobs.set(url, d); return d.promise })
    const tasks = [pool('bg1', 2), pool('bg2', 2), pool('next', 2)]
    expect(jobs.has('next')).toBe(false)
    tasks.push(pool('next', 0))
    expect(jobs.has('next')).toBe(true)
    for (const [url, d] of jobs) d.resolve(url)
    await Promise.all(tasks)
  })
  it('cancels unused tiles and does not cache their late responses', async () => {
    const d=deferred(), c=new AbortController(), load=vi.fn().mockReturnValueOnce(d.promise).mockResolvedValueOnce('new')
    const pool=createTilePool<string>(load)
    const a=pool('tile',0,c.signal).catch(e=>e.name);c.abort();expect(await a).toBe('AbortError')
    d.resolve('old');await Promise.resolve();await Promise.resolve()
    expect(await pool('tile')).toBe('new');expect(load).toHaveBeenCalledTimes(2)
  })
  it('bounds memory by LRU and lets failed images be retried', async () => {
    const load=vi.fn(async(url:string)=>url),pool=createTilePool(load,2)
    await pool('a');await pool('b');await pool('a');await pool('c');await pool('b')
    expect(load.mock.calls.map(c=>c[0])).toEqual(['a','b','c','b'])
    const broken=vi.fn().mockRejectedValueOnce(new Error('bad image')).mockResolvedValueOnce('good'),retry=createTilePool<string>(broken)
    await expect(retry('tile')).rejects.toThrow('bad image');expect(await retry('tile')).toBe('good')
  })
})
