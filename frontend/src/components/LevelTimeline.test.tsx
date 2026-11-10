import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SeriesPrediction } from '../lib/types'
import { useECharts } from '../hooks/useECharts'
vi.mock('../hooks/useECharts', () => ({ useECharts: vi.fn(() => ({ current: null })) }))
import LevelTimeline, { timelineDays } from './LevelTimeline'

const row = (day: number, level: number, data_available = true): SeriesPrediction => ({
  ts: `2026-10-${String(day).padStart(2, '0')}T00:00:00Z`, combined_level: level,
  sentinel_level: level, forecast_level: 0, stage: level === 0 ? '平静' : '预警',
  p7: null, p30: null, data_available,
})
describe('等级演进的零级和缺测表达', () => {
  it('零级保留数值0并以可见阶梯线和点绘制', () => {
    render(<LevelTimeline predictions={[row(1, 0), row(2, 0)]} />)
    const option = vi.mocked(useECharts).mock.calls.at(-1)![0]
    const series = option.series as Array<{ type: string; symbolSize: number; clip: boolean; data: Array<{ value: number }> }>
    expect(series[0].type).toBe('line')
    expect(series[0].symbolSize).toBeGreaterThan(0)
    expect(series[0].clip).toBe(false)
    expect(series[0].data.map(d => d.value)).toEqual([0, 0])
    expect(screen.getByText('有记录日期均为0级 · 平静')).toBeInTheDocument()
  })
  it('不在缺测日期之间制造连续等级或把缺测填成0', () => {
    const input = [row(1, 0), row(2, 4, false), row(4, 2)]
    expect(timelineDays(input).map(d => d.level)).toEqual([0, null, null, 2])
    expect(input[1].combined_level).toBe(4)
  })
  it('全部缺测时有明确空态', () => {
    render(<LevelTimeline predictions={[row(1, 0, false)]} />)
    expect(screen.getByText('所选时段无可用等级记录')).toBeInTheDocument()
    expect(timelineDays([row(1, 0, false)])[0].level).toBeNull()
  })
})
