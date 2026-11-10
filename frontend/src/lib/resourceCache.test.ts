import { describe, expect, it, vi } from 'vitest'
import { createResourceCache } from './resourceCache'

describe('bounded static resource cache', () => {
  it('shares concurrent loading and reuses the decoded object', async () => {
    const cache = createResourceCache<object>(3), value = { height: 42 }
    const loader = vi.fn(async () => value)
    const a=cache('a',loader), b=cache('a',loader)
    expect(a).toBe(b)
    expect(await a).toBe(value)
    expect(await cache('a',loader)).toBe(value)
    expect(loader).toHaveBeenCalledTimes(1)
  })
  it('evicts the least recently used resource and retries errors', async () => {
    const cache=createResourceCache<number>(2)
    await cache('a',async()=>1);await cache('b',async()=>2);await cache('a',async()=>9)
    await cache('c',async()=>3)
    const reload=vi.fn(async()=>20)
    expect(await cache('b',reload)).toBe(20)
    expect(reload).toHaveBeenCalledTimes(1)
    await expect(cache('bad',async()=>{throw new Error('offline')})).rejects.toThrow('offline')
    expect(await cache('bad',async()=>4)).toBe(4)
  })
  it('a late failure cannot erase a newer successful resource', async () => {
    const cache=createResourceCache<number>(1)
    let reject!: (e:Error)=>void
    const old=cache('a',()=>new Promise((_resolve,r)=>{reject=r}))
    await Promise.resolve()
    await cache('b',async()=>2)
    await cache('a',async()=>3)
    const failure=expect(old).rejects.toThrow('old request')
    reject(new Error('old request'));await failure
    expect(await cache('a',async()=>99)).toBe(3)
  })
})
