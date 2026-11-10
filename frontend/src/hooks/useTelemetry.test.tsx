import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type TelemetryHistory } from '../lib/api'
import { useTelemetry } from './useTelemetry'
import { resetOpsSnapshots } from '../lib/opsSnapshots'
vi.mock('../lib/api', () => ({ api: { opsTelemetry: vi.fn() } }))
const query = { hours: 1, anchor: 'latest' as const, channels: 'D' }
const payload = (id: string) => ({ device_id: id }) as TelemetryHistory
const deferred = () => {
  let resolve!: (v: TelemetryHistory) => void
  const promise = new Promise<TelemetryHistory>(r => { resolve = r })
  return { promise, resolve }
}
describe('telemetry request lifecycle', () => {
  beforeEach(() => { resetOpsSnapshots(); vi.mocked(api.opsTelemetry).mockReset() })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
  it('updates a live window every two seconds while keeping history at thirty seconds', async () => {
    vi.useFakeTimers()
    vi.mocked(api.opsTelemetry).mockResolvedValue(payload('a'))
    const { rerender, unmount } = renderHook(({ anchor }: { anchor: 'live' | 'latest' }) => useTelemetry('a', { ...query, anchor }, null), { initialProps: { anchor: 'live' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(1999) })
    expect(api.opsTelemetry).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(api.opsTelemetry).toHaveBeenCalledTimes(2)
    rerender({ anchor: 'latest' })
    await act(async () => { await vi.advanceTimersByTimeAsync(29999) })
    expect(api.opsTelemetry).toHaveBeenCalledTimes(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(api.opsTelemetry).toHaveBeenCalledTimes(4)
    unmount()
  })
  it('throttles a burst of live push events to one refresh per second', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-01T00:00:00Z'))
    vi.mocked(api.opsTelemetry).mockResolvedValue(payload('a'))
    const { rerender, unmount } = renderHook(({ revision }) => useTelemetry('a', { ...query, anchor: 'live' }, revision), { initialProps: { revision: 0 } })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    rerender({ revision: 1 })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(api.opsTelemetry).toHaveBeenCalledTimes(2)
    for (let i = 2; i <= 10; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      rerender({ revision: i })
    }
    expect(api.opsTelemetry).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    rerender({ revision: 11 })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(api.opsTelemetry).toHaveBeenCalledTimes(3)
    unmount()
  })
  it('never overlaps slow live requests and aborts when leaving the page', async () => {
    vi.useFakeTimers()
    const a = deferred(), b = deferred()
    vi.mocked(api.opsTelemetry).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    const { unmount } = renderHook(() => useTelemetry('a', { ...query, anchor: 'live' }, null))
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(api.opsTelemetry).toHaveBeenCalledTimes(1)
    await act(async () => { a.resolve(payload('a')); await vi.advanceTimersByTimeAsync(0) })
    expect(api.opsTelemetry).toHaveBeenCalledTimes(2)
    const signal = vi.mocked(api.opsTelemetry).mock.calls[1][2]!
    unmount(); expect(signal.aborted).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(api.opsTelemetry).toHaveBeenCalledTimes(2)
    b.resolve(payload('a'))
  })
  it('pauses two-second polling while hidden and revalidates on return', async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    vi.mocked(api.opsTelemetry).mockResolvedValue(payload('a'))
    const { unmount } = renderHook(() => useTelemetry('a', { ...query, anchor: 'live' }, null))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    visibility.mockReturnValue(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(api.opsTelemetry).toHaveBeenCalledTimes(1)
    visibility.mockReturnValue(false)
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0) })
    expect(api.opsTelemetry).toHaveBeenCalledTimes(2)
    unmount()
  })
  it('aborts old selections and ignores late responses', async () => {
    const a = deferred(), b = deferred()
    vi.mocked(api.opsTelemetry).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    const { result, rerender } = renderHook(({ id }) => useTelemetry(id, query, null), { initialProps: { id: 'a' } })
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
    const { result } = renderHook(() => useTelemetry('a', query, null))
    act(() => { for (let i = 0; i < 15; i++) result.current.refresh() })
    expect(api.opsTelemetry).toHaveBeenCalledTimes(1)
    await act(async () => { a.resolve(payload('a')) })
    expect(api.opsTelemetry).toHaveBeenCalledTimes(2)
    await act(async () => { b.resolve(payload('b')) })
    expect(result.current.data?.device_id).toBe('b')
  })
  it('retains previous results on failure and recovers on refresh', async () => {
    vi.mocked(api.opsTelemetry).mockResolvedValueOnce(payload('a')).mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValueOnce(payload('recovered'))
    const { result, unmount } = renderHook(() => useTelemetry('a', query, null))
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
