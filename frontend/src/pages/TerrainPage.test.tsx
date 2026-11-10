import { act, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const DEVICE = {
  device_id: 'slope-node-01', name: '边坡复合监测节点 01', mode: 'full' as const,
  lon: 110.759, lat: 30.983, has_level: true, station_id: 'sanxia-demo',
  level_m: 163.96, level_days: 180, level_lag_days: 1, is_demo: true,
  latest_ts: '2026-09-14T05:00:00Z',
  reading: { R: 2.0, P: 1.9, T: 21, H: 76, RN: 3.2, S: 35, D: 20.2 },
  prediction: { combined_level: 4, stage: '警报', sentinel_level: 4, forecast_level: 2,
                p7: 0.02, p30: 0.19, ts: '2026-09-14T05:00:00Z' },
  open_alerts: 1, acked_alerts: 0,
}

vi.mock('../lib/api', () => ({
  api: {
    devices: vi.fn(async () => ({ count: 1, items: [DEVICE], tuya_configured: false })),
    weather: vi.fn(async () => ({
      available: true, source: 'open-meteo', rain24h: 12.0, rain72h: 30.0,
      max_hourly: 3.4, weight_bonus: 0.25, stale: false,
      weight_reason: '未来 24 小时累计降雨 12.0 mm（中雨）',
    })),
  },
  setAuthToken: vi.fn(),
  ApiError: class ApiError extends Error { status = 0 },
  AuthError: class AuthError extends Error {},
}))
vi.mock('../lib/presentation', () => ({ loadPresentation: vi.fn(async () => ({ version: 1, scenes: [{ device: DEVICE, items: [], predictions: [] }] })) }))
vi.mock('../lib/terrainAssets', () => ({
  loadTerrain: vi.fn(async () => { throw new Error('offline') }),
  loadTerrainOsm: vi.fn(async () => null),
}))

import TerrainPage from './TerrainPage'
import { api } from '../lib/api'
import { loadPresentation } from '../lib/presentation'
import { selectDevice } from '../hooks/useSelectedDevice'
const saved = JSON.parse(readFileSync(resolve('public/assets/presentation-scenes-20261031-1a1fd9bb53e0.json'), 'utf8'))

const noop = () => {}

function renderPage() {
  return render(
    <TerrainPage
      session={{ token: 't', role: 'user', name: 'monitor' }}
      route="terrain"
      onNavigate={noop}
      onLogout={noop}
    />,
  )
}

beforeEach(() => {
  // jsdom 里没有高程服务：强制走"加载失败"分支，顺便验证错误提示不会白屏
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
})

describe('三维坡体页', () => {
  it('每个坡体只绑定一个固定演示点，下拉切换同步固定等级', async () => {
    const mock=vi.mocked(loadPresentation), original=mock.getMockImplementation()!
    mock.mockResolvedValue(saved)
    try {
      renderPage();const picker=screen.getByLabelText('选择坡体'),ids=['baijiabao','gaolan','shuiping','baishuihe','bazimen','xintan','lianziya'],grades=[0,4,1,2,3,0,2],monitors=[]
      for(let i=0;i<ids.length;i++){
        await userEvent.selectOptions(picker,ids[i])
        await waitFor(()=>expect(document.querySelector('.level-num')?.textContent).toBe(String(grades[i])))
        monitors.push(document.querySelector('.terrain-monitor-binding')?.getAttribute('data-monitor-id'))
      }
      expect(new Set(monitors).size).toBe(7);expect(screen.queryByLabelText('选择监测点')).toBeNull()
      act(()=>selectDevice('slope-node-01'))
      expect(document.querySelector('.level-num')?.textContent).toBe('2')
      expect(api.devices).not.toHaveBeenCalled()
    } finally { mock.mockImplementation(original);selectDevice('') }
  })
  it('绑定源缺失时不回退默认点或平静', async () => {
    const mock=vi.mocked(loadPresentation),original=mock.getMockImplementation()!
    mock.mockResolvedValue({...saved,scenes:saved.scenes.filter((s:{device:{device_id:string}})=>s.device.device_id!=='slope-node-02')})
    try {
      renderPage();await userEvent.selectOptions(screen.getByLabelText('选择坡体'),'gaolan')
      await waitFor(()=>expect(document.querySelector('.level-num')?.textContent).toBe('—'))
      expect(screen.queryByText('正常监测，无需动作')).toBeNull()
    } finally {mock.mockImplementation(original)}
  })
  it('回放加载失败保持未判定，重试后恢复绑定场景', async () => {
    const mock=vi.mocked(loadPresentation),original=mock.getMockImplementation()!
    mock.mockRejectedValueOnce(new Error('回放暂未加载')).mockResolvedValue(saved)
    try {
      renderPage();await screen.findByRole('alert')
      expect(document.querySelector('.level-num')?.textContent).toBe('—')
      await userEvent.click(screen.getByRole('button',{name:'重试场景'}))
      await waitFor(()=>expect(document.querySelector('.level-num')?.textContent).toBe('0'))
    } finally {mock.mockImplementation(original)}
  })
  it('首次请求未完成时显示同步中，不误报数据不足', () => {
    const mock=vi.mocked(loadPresentation), original=mock.getMockImplementation()!
    mock.mockImplementation(()=>new Promise(()=>{}))
    try {
      renderPage()
      expect(screen.getByText('正在同步预警')).toBeInTheDocument()
      expect(screen.queryByText('数据不足')).toBeNull()
    } finally { mock.mockImplementation(original) }
  })
  it('缺测时不能显示平静，倾角不能标为毫米', async () => {
    const original = DEVICE.prediction
    DEVICE.prediction = { ...original, data_available: false } as typeof original
    try {
      renderPage()
      expect(await screen.findByText('数据不足')).toBeInTheDocument()
      expect(screen.queryByText('正常监测，无需动作')).toBeNull()
      expect(screen.getByText(/倾角 R\/P：/).textContent).toContain('°')
      expect(screen.getByText(/倾角 R\/P：/).textContent).not.toContain('mm')
    } finally { DEVICE.prediction = original }
  })
  it('列出可选的坡体，并说明高程来源', async () => {
    renderPage()
    expect(screen.getByRole('heading', { name: '三维坡体 · 真实高程与下坡可达区' })).toBeInTheDocument()
    expect(await screen.findByTestId('terrain-site-baijiabao')).toBeInTheDocument()
    expect(screen.getByLabelText('选择坡体')).toHaveValue('baijiabao')
    expect(screen.getByRole('option', { name: '皋兰山' })).toBeInTheDocument()
    expect(screen.getByText(/AWS Terrain Tiles（公开数据）离线打包/)).toBeInTheDocument()
  })

  it('可以切换坡体（点击皋兰山后该条进入选中态）', async () => {
    renderPage()
    await userEvent.selectOptions(screen.getByLabelText('选择坡体'), 'gaolan')
    await waitFor(() => expect(screen.getByTestId('terrain-site-gaolan')).toBeInTheDocument())
    expect(screen.getByText(/三维地形 · 皋兰山/)).toBeInTheDocument()
  })

  it('高程取不到时给出明确提示，而不是空白画布', async () => {
    renderPage()
    expect(await screen.findByText(/高程加载失败/)).toBeInTheDocument()
  })

  it('如实标注"推演范围圈是示意半径、等级来自现场监测节点"', async () => {
    renderPage()
    expect(screen.getByText(/推演为几何情景，不是实测灾害边界/)).toBeInTheDocument()
    // "当前预警"在页内另有一处（"联动当前预警等级"），这里要唯一命中面板标题
    expect(screen.getByText('固定演示等级')).toBeInTheDocument()
    expect(screen.getByText(/一坡体一固定演示点/)).toBeInTheDocument()
    expect(screen.queryByLabelText('选择监测点')).toBeNull()
  })

  it('推演面板写明移动角口径，且说明颜色是相对强度不是概率', async () => {
    renderPage()
    expect(await screen.findByText('下坡可达区推演')).toBeInTheDocument()
    expect(screen.getAllByText(/移动角/).length).toBeGreaterThan(0)
    expect(screen.getByText(/颜色为几何分档，不代表概率或冲击强度/)).toBeInTheDocument()
  })

  it('天气只作权重参比：显示 24/72 小时降雨与加分理由', async () => {
    renderPage()
    expect(await screen.findByText(/天气与关注权重（参比）/)).toBeInTheDocument()
    expect(await screen.findByText('12.0 mm')).toBeInTheDocument()
    expect(screen.getByText('+0.25')).toBeInTheDocument()
    expect(screen.getByText(/未来 24 小时累计降雨 12.0 mm（中雨）/)).toBeInTheDocument()
    // 必须写清它不参与报警判定
    expect(screen.getByText(/不参与"是否报警"的判定/)).toBeInTheDocument()
  })
})
