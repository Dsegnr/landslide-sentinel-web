import { afterEach, describe, expect, it, vi } from 'vitest'

import { api, ApiError, setAuthToken } from './api'
import { loadOpsSnapshot, readOpsSnapshot } from './opsSnapshots'

function mockFetch(payload: unknown, ok = true, status = 200) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => payload,
  }))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('API 客户端', () => {
  it('登录身份切换及退出会清除运维快照，同一身份同步不重复清理', async () => {
    setAuthToken('fixture-user-a')
    await loadOpsSnapshot('inventory', async () => ({ private: 'a' }))
    setAuthToken('fixture-user-a'); expect(readOpsSnapshot('inventory')).not.toBeNull()
    setAuthToken('fixture-user-b'); expect(readOpsSnapshot('inventory')).toBeNull()
    await loadOpsSnapshot('inventory', async () => ({ private: 'b' }))
    setAuthToken(null); expect(readOpsSnapshot('inventory')).toBeNull()
  })
  it('请求路径正确（默认同源，交给 vite/nginx 代理）', async () => {
    const fn = mockFetch({ count: 0, items: [], tuya_configured: false })
    await api.devices()
    expect(fn).toHaveBeenCalledWith('/api/devices', expect.anything())
  })

  it('设备名里的特殊字符会被编码（防止路径注入）', async () => {
    const fn = mockFetch({ device_id: 'x', days: 7, count: 0, items: [], predictions: [] })
    await api.series('a/b c', 7)
    expect(fn.mock.calls[0][0]).toBe('/api/sensors/a%2Fb%20c?days=7')
  })

  it('确认告警走 POST（处置人由后端从 token 取，前端不传名字）', async () => {
    const fn = mockFetch({ ok: true, alert_id: 3, status: 'acked' })
    await api.ackAlert(3)
    expect(fn.mock.calls[0][0]).toBe('/api/alerts/3/ack')
    expect(fn.mock.calls[0][1]?.method).toBe('POST')
  })

  it('后端返回 detail 时把它带进错误信息（否则界面只会看到 500）', async () => {
    mockFetch({ detail: '未注册的设备：x' }, false, 404)
    await expect(api.series('x', 7)).rejects.toThrowError(/未注册的设备/)
    await expect(api.series('x', 7)).rejects.toBeInstanceOf(ApiError)
  })

  it('连不上后端时给出明确提示，而不是抛裸 fetch 错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }))
    await expect(api.devices()).rejects.toThrowError(/无法连接后端/)
  })

  it('地图点位：总览用 GET、新增用 POST、调整用 PATCH、删除用 DELETE', async () => {
    const fn = mockFetch({ ok: true, point: { id: 3 } })
    await api.mapOverview()
    expect(fn.mock.calls[0][0]).toBe('/api/map/overview')

    await api.createPoint({ name: '裂缝点', lon: 110.7, lat: 30.9, level: 3, weight: 2, watch: true })
    expect(fn.mock.calls[1][0]).toBe('/api/points')
    expect(fn.mock.calls[1][1]?.method).toBe('POST')

    await api.updatePoint(3, { watch: false, weight: 1.5 })
    expect(fn.mock.calls[2][0]).toBe('/api/points/3')
    expect(fn.mock.calls[2][1]?.method).toBe('PATCH')

    await api.deletePoint(3)
    expect(fn.mock.calls[3][1]?.method).toBe('DELETE')
  })
})
