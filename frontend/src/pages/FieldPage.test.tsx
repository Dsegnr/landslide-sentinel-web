import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const DEVICE = {
  device_id: 'slope-node-01', name: '边坡复合监测节点 01', mode: 'full' as const,
  lon: 110.759, lat: 30.983, has_level: true, station_id: 'sanxia-demo',
  level_m: 163.96, level_days: 180, level_lag_days: 1, is_demo: true,
  latest_ts: '2026-09-14T05:00:00Z',
  reading: { R: 2.0, P: 1.9, T: 21, H: 76, RN: 3.2, S: 35, D: 20.2 },
  prediction: { combined_level: 4, stage: '警报', sentinel_level: 4, forecast_level: 2, data_available: true,
                p7: 0.02, p30: 0.19, ts: '2026-09-14T05:00:00Z' },
  open_alerts: 1, acked_alerts: 0,
}

const RECORD = {
  id: 7, point_name: '白家包 ZD1', device_id: 'slope-node-01', level: '重度',
  note: '坡面出现新裂缝', photo_url: '/uploads/abc.png',
  observed_at: '2026-09-14T02:00:00Z', created_by: 'admin',
  created_at: '2026-09-14T02:00:00Z',
}

vi.mock('../lib/api', () => ({
  api: {
    devices: vi.fn(async () => ({ count: 1, items: [DEVICE], tuya_configured: false })),
    records: vi.fn(async () => ({ count: 1, items: [RECORD] })),
    alerts: vi.fn(async () => ({ count: 0, items: [] })),
    weather: vi.fn(async () => ({
      available: true, source: 'open-meteo', weight_bonus: 0.1, weight_reason: '',
      phenomenon: '多云', severity: 0, severity_label: '无降水', code: 2,
      rain24h: 0.0, rain72h: 0.0,
      now: { temp: 22.0, precip: 0, text: '多云', humidity: 70, wind: 2.0 },
    })),
  },
  setAuthToken: vi.fn(),
  ApiError: class ApiError extends Error { status = 0 },
  AuthError: class AuthError extends Error {},
}))

import FieldPage from './FieldPage'
import { api } from '../lib/api'

const noop = () => {}

function renderPage(role: 'user' | 'admin' = 'user') {
  return render(
    <FieldPage
      session={{ token: 't', role, name: role === 'admin' ? '管理人员' : 'monitor' }}
      route="field"
      onNavigate={noop}
      onLogout={noop}
    />,
  )
}

beforeEach(() => {
  localStorage.clear()
})

describe('现场监测页（地图为中心）', () => {
  it('首次请求未完成时显示同步中，不误报数据不足', () => {
    const mock=vi.mocked(api.devices), original=mock.getMockImplementation()!
    mock.mockImplementation(()=>new Promise(()=>{}))
    try {
      renderPage()
      expect(screen.getByText('正在同步预警')).toBeInTheDocument()
      expect(screen.queryByText('数据不足')).toBeNull()
    } finally { mock.mockImplementation(original) }
  })
  it('不可用的预测只显示数据不足，不把缺测判成平静', async () => {
    DEVICE.prediction.data_available = false
    try {
      renderPage()
      expect(await screen.findByText('数据不足')).toBeInTheDocument()
      expect(document.querySelector('.level-num')?.textContent).toBe('—')
    } finally { DEVICE.prediction.data_available = true }
  })

  it('列出四个数据集站点，默认选中白家包', async () => {
    renderPage()
    expect(await screen.findByTestId('site-item-baijiabao')).toBeInTheDocument()
    for (const id of ['majiagou', 'gaolan', 'self-collected']) {
      expect(document.querySelector(`[aria-label="现场数据集站点"] option[value="${id}"]`)).toBeInTheDocument()
    }
    // 默认站点有视频，且详情里写明用途
    expect(document.querySelector('video')).toBeTruthy()
    expect(screen.getByText(/主训练\/验证集/)).toBeInTheDocument()
  })

  it('皋兰山：默认是参考录像，缩略图可切到卫星影像并标注来源', async () => {
    renderPage()
    await userEvent.selectOptions(screen.getByLabelText('现场数据集站点'), 'gaolan')
    // 录像必须如实标注"参考录像、非本点位实拍"
    expect(await screen.findByText(/滑坡实景参考录像/)).toBeInTheDocument()
    expect(document.querySelector('video')).toBeTruthy()

    // 1 录像 + 2 卫星 + 1 参考实拍
    const thumbs = document.querySelectorAll('.thumb')
    expect(thumbs.length).toBe(4)
    await userEvent.click(thumbs[1] as HTMLElement) // 切到卫星近景
    await waitFor(() => expect(
      screen.getByAltText('皋兰山黄土边坡监测 现场影像'),
    ).toBeInTheDocument())
    // 必须写清"这是卫星影像，不是实拍"
    expect(screen.getByText(/卫星影像 · 近景/)).toBeInTheDocument()
    expect(screen.getByText(/不含滑坡事件标签/)).toBeInTheDocument()
  })

  it('马家沟："录像 → 卫星影像 → 同类滑坡实景参考"可逐张切换', async () => {
    renderPage()
    await userEvent.selectOptions(screen.getByLabelText('现场数据集站点'), 'majiagou')
    expect(document.querySelectorAll('.thumb').length).toBe(4)
    await userEvent.click(document.querySelectorAll('.thumb')[1] as HTMLElement)
    const img = await screen.findByAltText('马家沟水平位移观测点 现场影像')
    expect(img.getAttribute('src')).toBe('/field/sat/majiagou-near.jpg')
    expect(screen.getByText(/卫星影像 · 近景/)).toBeInTheDocument()

    // 最后一张是 USGS 公有领域的真实滑坡实拍，标注必须写清来源与"参考"
    await userEvent.click(document.querySelectorAll('.thumb')[3] as HTMLElement)
    await waitFor(() => expect(
      screen.getByText(/同类滑坡实景参考：四川安县肖家桥滑坡/),
    ).toBeInTheDocument())
    expect((screen.getByAltText('马家沟水平位移观测点 现场影像') as HTMLImageElement)
      .getAttribute('src')).toBe('/field/ref/xiaojiaqiao.jpg')
  })

  it('站点下拉也能切换（不依赖点地图）', async () => {
    renderPage()
    await userEvent.selectOptions(screen.getByLabelText('选择站点'), 'self-collected')
    // 自采点同样是"参考录像 + 卫星影像 + 参考实拍"，切到第二格会换成图片
    await waitFor(() => expect(document.querySelectorAll('.thumb').length).toBe(4))
    await userEvent.click(document.querySelectorAll('.thumb')[1] as HTMLElement)
    await waitFor(() => expect(screen.getByAltText('自采扰动序列（原型机） 现场影像')).toBeInTheDocument())
  })

  it('现场记录：普通用户只读、管理人员可新增、可查看照片', async () => {
    const { unmount } = renderPage('user')
    expect(await screen.findByText('白家包 ZD1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新增记录' })).toBeNull()
    expect(screen.getByRole('button', { name: '查看图片' })).toBeInTheDocument()
    unmount()

    renderPage('admin')
    await userEvent.click(await screen.findByRole('button', { name: '新增记录' }))
    expect(screen.getByRole('dialog', { name: '新增滑坡记录' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    await userEvent.click(screen.getByRole('button', { name: '查看图片' }))
    expect((screen.getByAltText('白家包 ZD1 现场照片') as HTMLImageElement).getAttribute('src'))
      .toBe('/uploads/abc.png')
  })

  it('默认高德专业底图，离线点位图保留切换入口', async () => {
    const { container } = renderPage()
    const toggle = await screen.findByTitle(/专业底图：矢量路网/)
    expect(toggle.textContent).toContain('离线图')
    expect(container.querySelector('.china-map')).toBeNull()
    await userEvent.click(toggle)
    expect(container.querySelector('.china-map')).toBeTruthy()
    expect(toggle.textContent).toContain('专业底图')
    await userEvent.click(toggle)
    expect(container.querySelector('.china-map')).toBeNull()
  })
  it('损坏的旧照片保留文字记录并给出提示，重新打开时允许重新加载', async () => {
    renderPage('user')
    await userEvent.click(await screen.findByRole('button', { name: '查看图片' }))
    fireEvent.error(screen.getByAltText('白家包 ZD1 现场照片'))
    expect(screen.getByText('该记录的照片文件无法显示，文字记录仍可查看。')).toBeInTheDocument()
    expect(screen.queryByAltText('白家包 ZD1 现场照片')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '关闭' }))
    await userEvent.click(screen.getByRole('button', { name: '查看图片' }))
    expect(screen.getByAltText('白家包 ZD1 现场照片')).toBeInTheDocument()
  })
})
