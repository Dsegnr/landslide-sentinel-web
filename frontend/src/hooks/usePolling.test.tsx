import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePolling } from './usePolling'
afterEach(() => vi.useRealTimers())

describe('pausable polling', () => {
  it('keeps data while paused and resumes with an immediate request', async () => {
    vi.useFakeTimers()
    const fetcher=vi.fn().mockResolvedValue(1)
    const hook=renderHook(({enabled})=>usePolling(fetcher,1000,[],enabled),{initialProps:{enabled:true}})
    await act(async()=>{await Promise.resolve()})
    expect(hook.result.current.data).toBe(1)
    hook.rerender({enabled:false})
    await act(async()=>{await vi.advanceTimersByTimeAsync(5000)})
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(hook.result.current.data).toBe(1)
    fetcher.mockResolvedValue(2)
    hook.rerender({enabled:true})
    await act(async()=>{await Promise.resolve()})
    expect(hook.result.current.data).toBe(2)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('does not apply an in-flight result after being paused', async () => {
    let resolve!:(n:number)=>void
    const fetcher=()=>new Promise<number>(r=>{resolve=r})
    const hook=renderHook(({enabled})=>usePolling(fetcher,30000,[],enabled),{initialProps:{enabled:true}})
    hook.rerender({enabled:false})
    await act(async()=>{resolve(99)})
    expect(hook.result.current.data).toBeNull()
  })
})
