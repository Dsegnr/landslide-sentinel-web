import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import PredictionPanel from './PredictionPanel'
import type { DeviceInfo } from '../lib/types'

function device(over: Partial<DeviceInfo>): DeviceInfo {
  return {
    device_id: 'slope-node-01',
    name: '边坡复合监测节点 01',
    mode: 'sentinel_only',
    lon: 110.759,
    lat: 30.983,
    has_level: false,
    station_id: null,
    level_m: null,
    level_days: 0,
    level_lag_days: null,
    is_demo: true,
    latest_ts: '2026-09-14T00:00:00Z',
    reading: { R: 2, P: 1.9, T: 21, H: 77, RN: 12, RNM: 0, S: 35, D: 20.14 },
    prediction: {
      combined_level: 4, stage: '警报', sentinel_level: 4, forecast_level: 0,
      p7: null, p30: null, ts: '2026-09-14T00:00:00Z',
    },
    open_alerts: 1,
    acked_alerts: 0,
    ...over,
  }
}

describe('预警面板', () => {
  it('缺测时主等级和哨兵触发均不显示为0级', () => {
    const d = device({ mode: 'full' })
    d.prediction = { ...d.prediction!, data_available: false, combined_level: 0, sentinel_level: 0 }
    render(<PredictionPanel device={d} />)
    expect(screen.getByText('数据不足')).toBeInTheDocument()
    expect(screen.queryByText('哨兵级 0')).toBeNull()
    expect(screen.getByText(/暂不输出预测评分/)).toBeInTheDocument()
  })

  it('未接入库水位时不编外推概率，并写明原因', () => {
    render(<PredictionPanel device={device({})} />)
    expect(screen.getByText('警报')).toBeInTheDocument()
    expect(screen.getByText('立即避险转移并上报')).toBeInTheDocument()
    expect(screen.getByText(/不输出外推概率/)).toBeInTheDocument()
    // 面板里两处都会提示"未接入库水位"（概率区 + 模式说明），所以用 getAllByText
    expect(screen.getAllByText(/未接入库水位/).length).toBeGreaterThanOrEqual(2)
  })

  it('接入库水位时展示 7/30 天概率条与融合模式标签', () => {
    render(
      <PredictionPanel
        device={device({
          mode: 'full',
          has_level: true,
          station_id: 'sanxia-demo',
          level_m: 163.76,
          level_days: 180,
          prediction: {
            combined_level: 4, stage: '警报', sentinel_level: 4, forecast_level: 2,
            p7: 0.0208, p30: 0.1949, ts: '2026-09-14T00:00:00Z',
          },
        })}
      />,
    )
    expect(screen.getByText('双时间尺度融合')).toBeInTheDocument()
    expect(screen.getByText('未来 7 天')).toBeInTheDocument()
    expect(screen.getByText('未来 30 天')).toBeInTheDocument()
    expect(screen.getByText('2.1%')).toBeInTheDocument()
    expect(screen.getByText('19.5%')).toBeInTheDocument()
    expect(screen.getByText(/163.76 m/)).toBeInTheDocument()
  })

  it('没有选中设备时给出空状态', () => {
    render(<PredictionPanel device={null} />)
    expect(screen.getByText('尚未选择设备')).toBeInTheDocument()
  })

  it('硬件只覆盖部分通道时，逐通道分清实测与同口径补齐', () => {
    // 实测场景：硬件只上报温湿度，位移/倾角/雨量/含水率由同口径序列补齐。
    // 这种情况绝不能整台设备写成"硬件直连"或"演示数据"——两句都会说错。
    render(
      <PredictionPanel
        device={device({
          is_demo: false,
          reading_sources: {
            R: 'simulation', P: 'simulation', T: 'hardware', H: 'hardware',
            RN: 'simulation', S: 'simulation', D: 'simulation',
          },
        })}
      />,
    )
    expect(screen.getByText(/温度\/湿度为/)).toBeInTheDocument()
    expect(screen.getByText(/硬件实测/)).toBeInTheDocument()
    expect(screen.getByText(/其余/)).toBeInTheDocument()
    expect(screen.getByText(/同口径补齐/)).toBeInTheDocument()
  })

  it('全通道都是实测时不写成演示数据', () => {
    render(
      <PredictionPanel
        device={device({
          is_demo: false,
          reading_sources: {
            R: 'hardware', P: 'hardware', T: 'hardware', H: 'hardware',
            RN: 'hardware', S: 'hardware', D: 'hardware',
          },
        })}
      />,
    )
    expect(screen.getByText(/硬件通道记录/)).toBeInTheDocument()
    expect(screen.queryByText(/演示序列/)).toBeNull()
  })

  it('没有逐通道来源时退回按设备标注（不假装知道细节）', () => {
    render(<PredictionPanel device={device({ is_demo: true })} />)
    expect(screen.getByText(/演示序列/)).toBeInTheDocument()
  })
})
