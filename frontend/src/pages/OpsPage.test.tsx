import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const DEVICES = {
  count: 2,
  items: [
    {
      device_id: 'slope-node-01', name: '边坡复合监测节点 01', is_virtual: false,
      hardware_marked: true, token_registered: true, mode: 'sentinel_only',
      station_id: null, lon: 110.759, lat: 30.983,
      declared_channels: ['R', 'P', 'T', 'H', 'RN', 'S', 'D'],
      measured_channels: ['T', 'H'],
      missing_channels: ['R', 'P', 'RN', 'S', 'D'],
      last_ts: '2026-09-22T12:00:00Z', last_age_minutes: 12, status: 'online' as const,
      last_hw_ts: '2026-09-22T12:00:00Z', link_age_minutes: 12,
      n_24h: 76,
    },
    {
      device_id: 'demo-node-01', name: '演示监测点 A · 变形初期', is_virtual: true,
      hardware_marked: false, token_registered: false, mode: 'sentinel_only',
      station_id: null, lon: 110.757, lat: 30.986,
      declared_channels: ['R', 'P', 'T', 'H', 'RN', 'S', 'D'],
      measured_channels: [], missing_channels: ['R', 'P', 'T', 'H', 'RN', 'S', 'D'],
      last_ts: null, last_age_minutes: null, status: 'never' as const, n_24h: 0,
      last_hw_ts: null, link_age_minutes: null,
    },
  ],
}

vi.mock('../components/ops/TelemetryCharts', () => ({
  Plot: () => <div data-testid="ops-plot" />,
  ReceptionChart: () => <div data-testid="rx-reception-chart" />,
  SensorChart: () => <div data-testid="rx-sensor-chart" />,
  ChannelHeatmap: () => <div data-testid="rx-heat-chart" />,
  timeLabel: (v: string) => v.slice(5, 16),
  CHANNEL_INFO: { D: ['相对位移', 'mm'], R: ['倾角 R', '°'], P: ['倾角 P', '°'], T: ['温度', '°C'], H: ['空气湿度', '%'], RN: ['雨滴响应', '%'], S: ['土壤湿度响应', '%'], RNM: ['周期降雨量', 'mm'], DIST: ['原始测距', 'mm'] },
}))
vi.mock('../hooks/useLiveStream', () => ({ useLiveStream: () => ({ status: 'open', event: null }) }))

vi.mock('../lib/api', () => ({
  api: {
    opsQuality: vi.fn(async (id: string) => ({
      history: { device_id: id, start: '2026-10-14T10:00:00Z', end: '2026-10-14T11:00:00Z', summary: { samples: 76 }, bins: [{ ts: '2026-10-14T10:00:00Z' }], heat: [{ rows: 76, counts: [76] }], heat_channels: ['D'] },
      sources: [{ source: 'hardware', count: 76 }, { source: 'simulation', count: 24 }],
      delay: { n: 76, mean: 8, max: 10, negative: 0, late: 0 }, delay_series: [['2026-10-14T10:00:00Z', 8]], gaps: [], gap_count: 0,
      channels: [{ channel: 'P', last_ts: '2026-10-14T10:00:00Z', value: -14, age_minutes: 1000, count: 76, out_of_range: false, repeated: false }, { channel: 'RNM', last_ts: null, value: null, age_minutes: null, count: 0, out_of_range: false, repeated: false }],
    })),
    opsTelemetry: vi.fn(async (deviceId: string, query: { channels: string }) => ({
      device_id: deviceId, anchor: 'latest', start: '2026-10-14T10:00:00Z', end: '2026-10-14T11:00:00Z', hours: 1, bucket_seconds: 3600,
      latest_received: deviceId === 'slope-node-01' ? '2026-10-14T10:30:00Z' : null,
      latest_sample: null, summary: { events: 2, accepted: 3, duplicated: 1, samples: 0 },
      bins: [{ ts: '2026-10-14T10:00:00Z', events: 2, accepted: 3, duplicated: 1, cumulative: 3 }],
      heat: [{ ts: '2026-10-14T10:00:00Z', rows: 0, counts: [0] }], heat_channels: ['D'],
      channels: query.channels.split(','), points: [], aggregation: 'raw', recent: [],
    })),
    opsOverview: vi.fn(async () => ({
      devices: 2, hardware_devices: 1, online: 1, stale: 0, offline: 0, never: 0,
      no_link: 1,
      registered_tokens: 1, unregistered_tokens: ['demo-node-01'],
      readings_24h: 76, ingest_events_24h: 3,
    })),
    // 首屏合成接口：页面只调它一次，内容与下面三个接口逐字一致
    //（改这里时三处要一起改，否则测试会与线上行为脱节）
    opsSummary: vi.fn(async () => ({
      overview: {
        devices: 2, hardware_devices: 1, online: 1, stale: 0, offline: 0, never: 0,
        no_link: 1,
        registered_tokens: 1, unregistered_tokens: ['demo-node-01'],
        readings_24h: 76, ingest_events_24h: 3,
      },
      devices: DEVICES,
      events: {
        count: 1,
        items: [{ device_id: 'slope-node-01', ts: '2026-09-22T12:00:00Z', accepted: 1, duplicated: 0, remote: '10.0.0.9' }],
      },
    })),
    opsDevices: vi.fn(async () => DEVICES),
    opsLink: vi.fn(async () => ({
      device_id: 'slope-node-01', hours: 72, n: 76,
      delay: { p50: 7.2, p90: 9.1, max: 15.0, min: 5.0 },
      delay_series: [['2026-09-22T10:00:00Z', 7.0], ['2026-09-22T11:00:00Z', 7.5]],
      normal_interval_s: 300, gaps: [], backfill: { n: 2, ratio: 0.03, segments: [] },
    })),
    opsChannels: vi.fn(async () => ({
      device_id: 'slope-node-01', hours: 24, count: 2,
      items: [
        { channel: 'T', state: 'stuck' as const, n_window: 76, last_ts: '2026-09-22T12:00:00Z', last_value: 25, source: 'hardware', age_minutes: 12 },
        { channel: 'D', state: 'not_connected' as const, n_window: 0, last_ts: null, last_value: null, source: null },
      ],
    })),
    opsEvents: vi.fn(async () => ({
      count: 1,
      items: [{ device_id: 'slope-node-01', ts: '2026-09-22T12:00:00Z', accepted: 1, duplicated: 0, remote: '10.0.0.9' }],
    })),
    opsSelfcheck: vi.fn(async () => ({
      device_id: 'slope-node-01', known: true, name: '边坡复合监测节点 01',
      declared_channels: ['R', 'T'], token_registered: true,
      base_url: 'https://example.test',
      endpoints: {
        // 与后端契约一致：**完整地址、不带方法前缀**（方法由页面自己加）
        check: 'https://example.test/api/ingest/check?device_id=slope-node-01',
        push: 'https://example.test/api/ingest/readings',
      },
      headers: { 'Content-Type': 'application/json', 'X-Device-Token': '<你的设备令牌>' },
      sample: { device_id: 'slope-node-01', ts: '<YYYY-MM-DD HH:MM:SS，北京时间>', channels: { R: 0, T: 0 } },
      notes: ['时间戳按北京时间解析（不带时区时按 UTC+8 处理），别传 UTC。'],
    })),
    opsSecurity: vi.fn(async () => ({
      tokens: [{ device_id: 'slope-node-01', name: '边坡复合监测节点 01',
                 token_registered: true, last_ingest_ts: '2026-09-22T12:00:00Z',
                 last_age_minutes: 12, last_remote: '10.0.0.9',
                 sources: [{ remote: '10.0.0.9', n: 3, first: 'a', last: 'b' }],
                 source_changed: false }],
      registered_count: 1,
      policy: {
        device_auth: '请求头 X-Device-Token', anti_enumeration: '同码同文案 401',
        login_lock: { max_failures: 5, lock_seconds: 300, scope: 'IP + 用户名' },
        jwt_expire_minutes: 240, admin_entry: '管理人员密钥入口（已配置）',
        token_rotation: '删除 .env 里的键值对并重启',
      },
      note: '不显示令牌原文',
    })),
    opsSystem: vi.fn(async () => ({
      processes: { app: { pid: 1, alive: true, uptime_hours: 2 },
                   tunnel: { pid: 2, alive: true, uptime_hours: 20 } },
      disk: { total_gb: 440, used_gb: 427, free_gb: 13, used_pct: 97 },
      storage: { readings_total: 1, db_size_mb: 9, first_ts: null, last_ts: null,
                 span_days: 189, readings_per_day: 140, note: '' },
      backups: [{ file: 'sentinel_20260923_0330.tar.gz', mb: 1.4, ts: '2026-09-23T03:30:00Z' }],
      models: [{ file: 'baijiabao_forecast_7d.json', kb: 3, ts: '2026-09-19T00:00:00Z' }],
      logs: [{ file: 'app.log', mb: 0.1, ts: '2026-09-23T08:00:00Z' }],
      runtime: { python: '3.11.16', platform: 'Linux', tz: 'Asia/Shanghai' },
      maintenance: { prune: 'scripts/prune_readings.py', backup: 'cron 03:30' },
    })),
    opsNotify: vi.fn(async () => ({
      configured: false, kind: 'wecom', host: null, min_level: 3,
      queue_size: 0, recent: [], recent_ok: 0, recent_fail: 0,
      hint: '未配置 webhook：告警只落库、只上大屏，不会外发。',
    })),
    opsNotifyTest: vi.fn(async () => ({ ok: false, detail: '未配置 ALERT_WEBHOOK_URL' })),
    opsCompleteness: vi.fn(async () => ({
      hours: 72,
      items: [{ device_id: 'slope-node-01', name: '边坡复合监测节点 01',
                rows: 100, hardware: 76, simulation: 24, hardware_ratio: 0.76,
                channels: { T: { n: 76, ratio: 0.76 }, D: { n: 24, ratio: 0.24 } },
                gaps: [], gap_count: 0 }],
      note: '缺口判据：相邻读数间隔 > 30 分钟',
    })),
  },
  setAuthToken: vi.fn(),
  ApiError: class ApiError extends Error { status = 0 },
  AuthError: class AuthError extends Error {},
}))

import OpsPage from './OpsPage'

const noop = () => {}

function renderPage() {
  return render(
    <OpsPage
      session={{ token: 't', role: 'user', name: 'monitor' }}
      route="ops"
      onNavigate={noop}
      onLogout={noop}
    />,
  )
}

describe('设备与通信运维页', () => {
  it('会话失效时退出登录，不持续展示旧的运维结果', async () => {
    const { api, ApiError } = await import('../lib/api')
    const expired = Object.assign(new ApiError('expired', 401), { status: 401 })
    vi.mocked(api.opsDevices).mockRejectedValueOnce(expired)
    const logout = vi.fn()
    render(<OpsPage session={{ token: 't', role: 'user', name: 'monitor' }} route="ops" onNavigate={noop} onLogout={logout} />)
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1))
  })
  it('展示接收趋势、曲线、覆盖矩阵及来源', async () => {
    renderPage()
    expect(await screen.findByTestId('rx-reception-chart')).toBeInTheDocument()
    expect(screen.getByTestId('rx-sensor-chart')).toBeInTheDocument()
    expect(screen.getByTestId('rx-heat-chart')).toBeInTheDocument()
    expect(screen.getByText('仅统计真实硬件')).toBeInTheDocument()
    expect(screen.queryByText(/curl -H/)).toBeNull()
  })
  it('模拟点无实测时明确来源，不把空数据画成0', async () => {
    renderPage()
    await screen.findByRole('option', { name: /演示监测点 A/ })
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '监测设备' }), 'demo-node-01')
    expect(await screen.findByText('模拟/演示 · 无实测接入')).toBeInTheDocument()
    expect(screen.getByText('未登记令牌')).toBeInTheDocument()
    expect(await screen.findByText('该时段没有硬件采样记录')).toBeInTheDocument()
  })
  it('六个子页签保留，接入指南仍提供令牌占位符', async () => {
    renderPage()
    for (const key of ['overview', 'link', 'security', 'notify', 'system', 'guide']) expect(screen.getByTestId(`ops-tab-${key}`)).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('ops-tab-security'))
    expect(await screen.findByText(/存在多个出口/)).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('ops-tab-guide'))
    expect(await screen.findByRole('button', { name: /1 获取设备令牌/ })).toBeInTheDocument()
    expect((await screen.findAllByText(/设备令牌/)).length).toBeGreaterThan(0)
  })
  it('链路页区分硬件与补齐，历史负倾角不误标越界', async () => {
    renderPage()
    await screen.findByRole('option', { name: /边坡复合监测节点 01/ })
    await userEvent.click(screen.getByTestId('ops-tab-link'))
    expect(await screen.findByText('历史值')).toBeInTheDocument()
    expect(screen.getByText('-14')).toBeInTheDocument()
    expect(screen.queryByText('数值待核查')).toBeNull()
    expect(screen.getByText('未接入')).toBeInTheDocument()
    expect(screen.getByText('硬件实测')).toBeInTheDocument()
    expect(screen.getByText('模拟 / 补齐')).toBeInTheDocument()
  })
  it('设备与通道切换请求对应数据', async () => {
    renderPage()
    await screen.findByRole('option', { name: /演示监测点 A/ })
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '监测设备' }), 'demo-node-01')
    const { api } = await import('../lib/api')
    await waitFor(() => expect(api.opsTelemetry).toHaveBeenCalledWith('demo-node-01', expect.objectContaining({ channels: 'D' }), expect.any(AbortSignal)))
    await userEvent.click(screen.getByRole('button', { name: /温度/ }))
    await waitFor(() => expect(api.opsTelemetry).toHaveBeenCalledWith('demo-node-01', expect.objectContaining({ channels: 'T' }), expect.any(AbortSignal)))
  })
  it('指定历史结束时刻按北京时间转换', async () => {
    renderPage()
    await screen.findByRole('option', { name: /边坡复合监测节点 01/ })
    await userEvent.click(screen.getByText('指定日期'))
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.change(screen.getByLabelText('结束时间（北京时间）'), { target: { value: '2026-10-14T19:30' } })
    await userEvent.click(screen.getByRole('button', { name: /^查看$/ }))
    const { api } = await import('../lib/api')
    await waitFor(() => expect(api.opsTelemetry).toHaveBeenCalledWith('slope-node-01', expect.objectContaining({ anchor: 'at', end: '2026-10-14T11:30:00.000Z' }), expect.any(AbortSignal)))
  })
})

