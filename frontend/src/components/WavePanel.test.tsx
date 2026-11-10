import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import WavePanel from './WavePanel'
import { ApiError, api } from '../lib/api'
import type { WaveEstimate } from '../lib/api'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ...actual,
    api: { ...actual.api, wavePresets: vi.fn(), waveEstimate: vi.fn() },
  }
})

const LIMITS = {
  F: [0.86, 6.83] as [number, number], S: [0.09, 1.64] as [number, number],
  M: [0.11, 10.02] as [number, number], P: [0.17, 8.13] as [number, number],
}

const PRESETS = {
  presets: [
    { id: 'baijiabao', name: '白家包（湖北 秭归 · 三峡库区）',
      note: '剖面 I-I′ 实量：滑体质心 151 m、蓄水位 175 m',
      unconfirmed: ['alpha_deg', 'centroid_elev_m'], input: {} },
    { id: 'lituya', name: 'Lituya Bay 1958（Heller 2007 原型算例）',
      note: '质心落差 609 m · 水深 122 m', unconfirmed: [], input: {} },
  ],
  limits: LIMITS,
  defaults: { rho_s_kgm3: 1800, alpha_deg: 40, delta_deg: 14 },
}

/** 白家包：质心 151 m < 蓄水位 175 m → B 档前提不成立，不给数 */
function baijiabaoEstimate(): WaveEstimate {
  return {
    input: {},
    heller_applicable: false,
    advisory: { status: 'not_applicable', usable_m: null, level: null, basis: '',
                reason: '无法给出涌浪结论：滑体质心已没入水面',
                thresholds_m: [2, 5, 10, 20], thresholds_source: '项目工作阈值，无文献依据' },
    watts: { applicable: false, unavailable_reason: '坡角不足以克服库仑摩擦，块体不会启动',
             idealization: '本档算的是刚性方块；把天然滑坡映射到方块是假设。',
             bib: 'Watts 2000', in_advisory: false,
             in_advisory_reason: '映射口径未与现场几何核定，暂不参与告警判定',
             mapping: { b_rule: '面积等效', d_rule: '质心淹没深度', theta_rule: '滑面弦角',
                        values: { b_m: 283.6, d_m: 21, theta_deg: 14.7 } } },
    rows: [
      {
        scenario: 'drop', label: '失稳情景（各按原文口径）',
        panjiazheng: { velocity_mps: 39.62, velocity_note: 'v=√(2g·drop_m·k_eff)',
                       zeta0_m: 140.0, opposite_min_m: 149.0, opposite_max_m: 166.2,
                       celerity_mps: 62.0, froude: 1.37 },
        heller: { applicable: false, centroid_drop_m: -24, velocity_source: 'eq6_1',
                  unavailable_reason: '滑体质心已没入水面：Δz_sc = -24.0 m'
                                       + '（质心 151 m − 水面 175 m），陆上滑坡入水的前提不成立' },
      },
      {
        scenario: 'monitoring', label: '监测速率（外部输入 · 外推）',
        panjiazheng: { velocity_mps: 0.02, velocity_note: '外部给定（监测速率）',
                       zeta0_m: 0.07, opposite_min_m: 0.07, opposite_max_m: 0.07,
                       celerity_mps: 28.9, froude: 0.001 },
        heller: { applicable: false, centroid_drop_m: -24, velocity_source: 'monitoring',
                  unavailable_reason: '滑体质心已没入水面：Δz_sc = -24.0 m' },
      },
    ],
    limits: LIMITS,
    summary: { advisory_m: 166.2, note: 'advisory 取两档全部口径的最大值，仅供告警' },
    preset: { id: 'baijiabao', name: '白家包（湖北 秭归 · 三峡库区）',
              note: '剖面实量', unconfirmed: ['alpha_deg', 'centroid_elev_m'] },
    wave_type_cn: {},
  }
}

/** Lituya：Δz_sc = 609 m > 0 → 前提成立，给出全部数值 */
function lituyaEstimate(): WaveEstimate {
  return {
    input: {},
    heller_applicable: true,
    advisory: { status: 'ok', usable_m: 143.3, level: 4,
                basis: 'Heller·失稳情景（各按原文口径）',
                reason: '至少有一档前提成立且落在原文标定域内，可作为告警输入',
                thresholds_m: [2, 5, 10, 20], thresholds_source: '项目工作阈值，无文献依据' },
    watts: null,
    rows: [{
      scenario: 'drop', label: '失稳情景（各按原文口径）',
      panjiazheng: { velocity_mps: 77.3, velocity_note: 'v=√(2g·drop_m·k_eff)',
                     zeta0_m: 300.0, opposite_min_m: 320.0, opposite_max_m: 360.0,
                     celerity_mps: 90.0, froude: 2.66 },
      heller: { applicable: true, unavailable_reason: '', centroid_drop_m: 609,
                velocity_source: 'eq6_1', velocity_mps: 91.64,
                P: 3.383, F: 2.659, S: 0.754, M: 6.745,
                amplitude_max_m: 143.3, height_max_m: 179.1, period_s: 58.0,
                x_max_m: 1234.0, primary_volume_m3: 5.29e7,
                wave_type: 'bore', wave_type_cn: '涌潮型（bore）',
                at_opposite_m: 143.3, at_opposite_uses_decay: false,
                in_domain: true, violations: [] },
    }],
    limits: LIMITS,
    summary: { advisory_m: 360.0, note: 'advisory 提示' },
    preset: { id: 'lituya', name: 'Lituya Bay 1958（Heller 2007 原型算例）',
              note: '质心落差 609 m', unconfirmed: [] },
    wave_type_cn: {},
  }
}

describe('涌浪面板', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.wavePresets).mockResolvedValue(PRESETS)
    vi.mocked(api.waveEstimate).mockResolvedValue(baijiabaoEstimate())
  })

  it('加载预设并提示待确认参数', async () => {
    render(<WavePanel />)
    expect(await screen.findByText(/白家包/)).toBeInTheDocument()
    expect(screen.getByText(/未经现场剖面确认/)).toBeInTheDocument()
    expect(screen.getByText(/入水冲击角 α/)).toBeInTheDocument()
  })

  it('默认收起，摘要行已给出结论', async () => {
    render(<WavePanel />)
    expect(await screen.findByText(/潘家铮对岸 0~166 m/)).toBeInTheDocument()
    expect(screen.getByText(/Heller 档不适用/)).toBeInTheDocument()
    await waitFor(() => expect(api.waveEstimate).toHaveBeenCalledWith({ site: 'baijiabao' }))
    expect(document.querySelector('.wave-fold')?.hasAttribute('open')).toBe(false)
  })

  it('B 档前提不成立时显示"不适用"而不是 0 m', async () => {
    render(<WavePanel />)
    await screen.findByText(/白家包/)
    expect((await screen.findAllByText('不适用')).length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText('0.0 m')).not.toBeInTheDocument()
    // 同一句原因在"不适用"提示与"告警口径"里都会出现，所以用 findAllByText
    expect((await screen.findAllByText(/滑体质心已没入水面/)).length).toBeGreaterThanOrEqual(1)
    // 告警口径：给不出结论时**不能**给出等级
    expect(screen.getByText(/无法给出涌浪结论/)).toBeInTheDocument()
    // 三档逐条核查：给不出结论时要把"为什么"看得见
    expect(screen.getByText('三档逐条核查')).toBeInTheDocument()
    expect(screen.getByText('A · 潘家铮法')).toBeInTheDocument()
    expect(screen.getByText('B · Heller/Fritz')).toBeInTheDocument()
    expect(screen.getByText('C · Watts 方块')).toBeInTheDocument()
    expect(screen.getByText(/块体不会启动/)).toBeInTheDocument()
    expect(screen.getByText(/映射口径未与现场几何核定/)).toBeInTheDocument()
  })

  it('B 档前提成立时给出数值与适用域', async () => {
    vi.mocked(api.waveEstimate).mockResolvedValue(lituyaEstimate())
    render(<WavePanel />)
    // 面板表格与"告警口径"都会出现这个值
    expect((await screen.findAllByText('143.3 m')).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('域内')).toBeInTheDocument()
    expect(screen.getByText(/Table 5\.1/)).toBeInTheDocument()
    // 告警口径：可出结论时给出等级与取值来源
    expect(screen.getByText(/警报/)).toBeInTheDocument()
    expect(screen.getAllByText('143.3 m').length).toBeGreaterThanOrEqual(1)
  })

  it('填了监测速率才把它作为额外情景发给后端', async () => {
    const user = userEvent.setup()
    render(<WavePanel />)
    await screen.findByText(/白家包/)
    await waitFor(() => expect(screen.getByRole('button', { name: '估算' })).toBeEnabled())
    await user.type(screen.getByLabelText('监测速率'), '0.02')
    await user.click(screen.getByRole('button', { name: '估算' }))
    await waitFor(() =>
      expect(api.waveEstimate).toHaveBeenCalledWith({ site: 'baijiabao', monitored_speed_mps: 0.02 }))
  })

  it('后端报错时显示错误、不显示上次结果', async () => {
    vi.mocked(api.waveEstimate).mockRejectedValue(new ApiError('未知预设', 404))
    render(<WavePanel />)
    await screen.findByText(/白家包/)
    expect(await screen.findByText('未知预设')).toBeInTheDocument()
    expect(screen.queryByText(/Table 5\.1/)).not.toBeInTheDocument()
    expect(screen.getByText('估算失败')).toBeInTheDocument()
  })
})
