import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { prepareOps } from './opsPreparation'
import { readOpsSnapshot, resetOpsSnapshots, telemetryKey } from './opsSnapshots'
vi.mock('./api', () => ({ api: {
  opsDevices: vi.fn(), opsTelemetry: vi.fn(), opsQuality: vi.fn(), opsSecurity: vi.fn(),
  opsSystem: vi.fn(), opsNotify: vi.fn(), opsSelfcheck: vi.fn(), opsNotifyTest: vi.fn(),
} }))
describe('ops background preparation', () => {
  beforeEach(() => { resetOpsSnapshots(); vi.resetAllMocks() })
  it('prepares exactly the default read-only views, shares work and skips fresh repeats', async () => {
    vi.mocked(api.opsDevices).mockResolvedValue({ count: 1, items: [{ device_id: 'hw' }] } as never)
    let active = 0, peak = 0
    for (const name of ['opsTelemetry','opsQuality','opsSecurity','opsSystem','opsNotify','opsSelfcheck'] as const) {
      vi.mocked(api[name]).mockImplementation((async () => { active++; peak = Math.max(peak, active); await Promise.resolve(); active--; return { test: true } }) as never)
    }
    await Promise.all([prepareOps(), prepareOps()])
    expect(peak).toBeLessThanOrEqual(2); expect(api.opsDevices).toHaveBeenCalledTimes(1)
    expect(api.opsTelemetry).toHaveBeenCalledWith('hw', { hours: 1, anchor: 'latest', channels: 'D' }, expect.any(AbortSignal))
    expect(readOpsSnapshot(telemetryKey('hw', { hours: 1, anchor: 'latest', channels: 'D' }))).not.toBeNull()
    await prepareOps(); expect(api.opsDevices).toHaveBeenCalledTimes(1); expect(api.opsTelemetry).toHaveBeenCalledTimes(1)
    expect(api.opsNotifyTest).not.toHaveBeenCalled()
  })
  it('stops scheduling the old session after logout', async () => {
    let resolve!: (v: never) => void
    vi.mocked(api.opsDevices).mockReturnValue(new Promise(r => { resolve = r }))
    const prep = prepareOps(); resetOpsSnapshots()
    resolve({ count: 1, items: [{ device_id: 'old' }] } as never); await prep
    expect(api.opsTelemetry).not.toHaveBeenCalled(); expect(readOpsSnapshot('inventory')).toBeNull()
  })
})
