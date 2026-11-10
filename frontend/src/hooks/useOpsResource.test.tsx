import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type TelemetryHistory } from '../lib/api'
import { useOpsResource } from './useOpsResource'
import { loadOpsSnapshot, resetOpsSnapshots } from '../lib/opsSnapshots'
vi.mock('../lib/api', () => ({ api: { opsTelemetry: vi.fn() } }))
const query = { hours: 1, anchor: 'latest' as const, channels: 'D' }
const useResource = (id: string) => useOpsResource(id, signal => api.opsTelemetry(id, query, signal))
const payload = (id: string) => ({ device_id: id }) as TelemetryHistory
const deferred = () => {
  let resolve!: (v: TelemetryHistory) => void
  const promise = new Promise<TelemetryHistory>(r => { resolve = r })
  return { promise, resolve }
}
describe('ops resource lifecycle', () => {
  beforeEach(() => { resetOpsSnapshots(); vi.mocked(api.opsTelemetry).mockReset() })
  it('waits for the coalesced manual request separately from an automatic request', async () => {
    const automatic = deferred(), manual = deferred()
    vi.mocked(api.opsTelemetry).mockReturnValueOnce(automatic.promise).mockReturnValueOnce(manual.promise)
    const { result, unmount } = renderHook(() => useResource('a'))
    let finished = false
    const completion = result.current.refreshAndWait().then(() => { finished = true })
    expect(api.opsTelemetry).toHaveBeenCalledTimes(1)
    await act(async () => { automatic.resolve(payload('automatic')) })
    expect(api.opsTelemetry).toHaveBeenCalledTimes(2)
    expect(finished).toBe(false)
    await act(async () => { manual.resolve(payload('manual')); await completion })
    expect(finished).toBe(true); expect(result.current.data?.device_id).toBe('manual')
    unmount()
  })
  it('settles pending manual feedback when the page leaves', async () => {
    vi.mocked(api.opsTelemetry).mockReturnValue(new Promise(() => {}))
    const { result, unmount } = renderHook(() => useResource('a'))
    const complete = result.current.refreshAndWait()
    unmount()
    await complete
    expect(api.opsTelemetry).toHaveBeenCalledTimes(1)
  })
  it('renders preloaded results immediately, then revalidates without clearing them', async () => {
    await loadOpsSnapshot('a', async () => payload('preloaded'))
    const next = deferred(); vi.mocked(api.opsTelemetry).mockReturnValue(next.promise)
    const { result } = renderHook(() => useResource('a'))
    expect(result.current.data?.device_id).toBe('preloaded'); expect(result.current.loading).toBe(true)
    expect(result.current.updated).toBeGreaterThan(0); expect(api.opsTelemetry).toHaveBeenCalledTimes(1)
    await act(async () => next.resolve(payload('fresh')))
    expect(result.current.data?.device_id).toBe('fresh'); expect(result.current.loading).toBe(false)
  })
  it('does not expose the previous selection even on the render before its effect', async () => {
    vi.mocked(api.opsTelemetry).mockResolvedValueOnce(payload('a')).mockReturnValueOnce(new Promise(() => {}))
    const seen: Array<string | null> = []
    const { rerender } = renderHook(({ id }) => { const s = useResource(id); seen.push(s.data?.device_id ?? null); return s }, { initialProps: { id: 'a' } })
    await waitFor(() => expect(seen).toContain('a')); seen.length = 0
    rerender({ id: 'b' }); expect(seen.every(v => v === null)).toBe(true)
  })
  it('aborts old selections and ignores late responses', async () => {
    const a = deferred(), b = deferred()
    vi.mocked(api.opsTelemetry).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    const { result, rerender } = renderHook(({ id }) => useResource(id), { initialProps: { id: 'a' } })
    const signal = vi.mocked(api.opsTelemetry).mock.calls[0][2]!
    rerender({ id: 'b' })
    expect(signal.aborted).toBe(true)
    await act(async () => { b.resolve(payload('b')) })
    await act(async () => { a.resolve(payload('a')) })
    expect(result.current.data?.device_id).toBe('b')
  })
  it('coalesces refresh storms into one trailing request', async () => {
    const a = deferred(), b = deferred()
    vi.mocked(api.opsTelemetry).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    const { result } = renderHook(() => useResource('a'))
    act(() => { for (let i = 0; i < 15; i++) result.current.refresh() })
    expect(api.opsTelemetry).toHaveBeenCalledTimes(1)
    await act(async () => { a.resolve(payload('a')) })
    expect(api.opsTelemetry).toHaveBeenCalledTimes(2)
    await act(async () => { b.resolve(payload('b')) })
    expect(result.current.data?.device_id).toBe('b')
  })
  it('retains previous results on failure and recovers on refresh', async () => {
    vi.mocked(api.opsTelemetry).mockResolvedValueOnce(payload('a')).mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValueOnce(payload('recovered'))
    const { result, unmount } = renderHook(() => useResource('a'))
    await waitFor(() => expect(result.current.data?.device_id).toBe('a'))
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.error).toBe('network unavailable'))
    expect(result.current.data?.device_id).toBe('a')
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.data?.device_id).toBe('recovered'))
    expect(result.current.error).toBe('')
    unmount()
  })
})
