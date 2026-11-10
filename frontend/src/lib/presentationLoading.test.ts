import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const saved = JSON.parse(readFileSync('public/assets/presentation-scenes-20261031-1a1fd9bb53e0.json', 'utf8'))
beforeEach(() => vi.resetModules())
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('presentation loading is fail closed', () => {
  it('rejects failed scenes instead of showing calm live grades, then retries and caches success', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => saved })
    vi.stubGlobal('fetch', fetcher)
    const { api } = await import('./api')
    vi.spyOn(api, 'devices').mockResolvedValue({ count: 1, tuya_configured: false,
      items: [{ ...saved.scenes[1].device, prediction: { ...saved.scenes[1].device.prediction, combined_level: 0 } }] })
    const { presentationApi } = await import('./presentationApi')
    await expect(presentationApi.devices()).rejects.toThrow('暂不切换实时等级')
    const next = await presentationApi.devices()
    expect(next.items[0].prediction?.combined_level).toBe(saved.scenes[1].device.prediction.combined_level)
    await presentationApi.devices()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('rejects an empty or malformed archive and can recover on the next poll', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ version: 1, scenes: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => saved }))
    const { loadPresentation } = await import('./presentation')
    await expect(loadPresentation()).rejects.toThrow('暂不切换实时等级')
    expect((await loadPresentation()).scenes.length).toBe(6)
  })
  it('coalesces simultaneous callers and aborts a hung archive request within 15 seconds', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    vi.stubGlobal('fetch', fetcher)
    const { loadPresentation } = await import('./presentation')
    const first = loadPresentation(), second = loadPresentation()
    expect(first).toBe(second)
    const rejection = expect(first).rejects.toThrow('暂不切换实时等级')
    await vi.advanceTimersByTimeAsync(15000)
    await rejection
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
