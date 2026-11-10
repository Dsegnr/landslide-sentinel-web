import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadOpsSnapshot, readOpsSnapshot, resetOpsSnapshots, telemetryKey } from './opsSnapshots'
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
describe('session-scoped ops snapshots', () => {
  beforeEach(() => { resetOpsSnapshots(); vi.useRealTimers() })
  it('shares pending work, but one consumer cannot cancel another', async () => {
    const d = deferred<number>(), a = new AbortController(), b = new AbortController()
    const loader = vi.fn(() => d.promise)
    const first = loadOpsSnapshot('a', loader, a.signal).catch(e => e.name)
    const second = loadOpsSnapshot('a', loader, b.signal)
    a.abort(); expect(await first).toBe('AbortError'); expect(loader).toHaveBeenCalledTimes(1)
    d.resolve(42); expect(await second).toBe(42); expect(readOpsSnapshot('a')?.data).toBe(42)
  })
  it('aborts orphan work and lets an immediate return start a new request', async () => {
    const c = new AbortController(), d = deferred<number>(); let signal!: AbortSignal
    const first = loadOpsSnapshot('a', s => { signal = s; return d.promise }, c.signal).catch(e => e.name)
    c.abort(); expect(signal.aborted).toBe(true); expect(await first).toBe('AbortError')
    expect(await loadOpsSnapshot('a', async () => 2)).toBe(2)
    d.resolve(1); await Promise.resolve(); expect(readOpsSnapshot('a')?.data).toBe(2)
  })
  it('clears data and pending responses when the authentication scope changes', async () => {
    await loadOpsSnapshot('known', async () => 1)
    const d = deferred<number>()
    const old = loadOpsSnapshot('a', () => d.promise).catch(e => e.name)
    resetOpsSnapshots(); d.resolve(2)
    expect(await old).toBe('AbortError'); expect(readOpsSnapshot('known')).toBeNull(); expect(readOpsSnapshot('a')).toBeNull()
  })
  it('never substitutes a different device/window/channel/date and always revalidates', async () => {
    const q = { hours: 1, anchor: 'latest', channels: 'D' }, key = telemetryKey('a', q)
    await loadOpsSnapshot(key, async () => 1)
    for (const k of [telemetryKey('b', q), telemetryKey('a', { ...q, hours: 24 }), telemetryKey('a', { ...q, anchor: 'live' }), telemetryKey('a', { ...q, channels: 'T' }), telemetryKey('a', { ...q, end: '2026-10-01' })]) expect(readOpsSnapshot(k)).toBeNull()
    expect(await loadOpsSnapshot(key, async () => 3)).toBe(3)
  })
  it('retains the last success on network errors, but clears on 401', async () => {
    await loadOpsSnapshot('a', async () => 4)
    await expect(loadOpsSnapshot('a', async () => { throw new Error('offline') })).rejects.toThrow('offline')
    expect(readOpsSnapshot('a')?.data).toBe(4)
    await expect(loadOpsSnapshot('a', async () => { throw Object.assign(new Error('expired'), { status: 401 }) })).rejects.toThrow('expired')
    expect(readOpsSnapshot('a')).toBeNull()
  })
  it('bounds retained entries and expires abandoned snapshots', async () => {
    for(let i=0;i<33;i++) await loadOpsSnapshot(String(i), async () => i)
    expect(readOpsSnapshot('0')).toBeNull(); expect(readOpsSnapshot('32')?.data).toBe(32)
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 21 * 60 * 1000)
    expect(readOpsSnapshot('32')).toBeNull(); vi.restoreAllMocks()
  })
})
