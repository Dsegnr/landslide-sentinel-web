import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import DataCards from './DataCards'
import type { Reading, SeriesPoint } from '../lib/types'

// RN = 雨量感应强度 %（平面传感器）；RNM = 降雨量 mm（卡片与曲线用的就是它）
const READING: Reading = {
  R: 2.02, P: 0.69, T: 21.4, H: 62, RN: 38, RNM: 3.5, S: 45.4, D: 19.14,
}

const POINTS: SeriesPoint[] = [
  { ts: '2026-09-11T00:00:00Z', R: 1, P: 1, T: 20, H: 60, RN: 5, RNM: 0, S: 44, D: 18.0, level: null },
  { ts: '2026-09-12T00:00:00Z', R: 1, P: 1, T: 20, H: 60, RN: 40, RNM: 2, S: 45, D: 18.5, level: null },
  { ts: '2026-09-13T00:00:00Z', R: 1, P: 1, T: 20, H: 60, RN: 60, RNM: 4, S: 45, D: 19.14, level: null },
]

describe('数据卡', () => {
  it('展示四类硬件通道与位移日增量', () => {
    render(<DataCards reading={READING} points={POINTS} />)
    expect(screen.getByText('地表位移')).toBeInTheDocument()
    expect(screen.getByText('19.14')).toBeInTheDocument()
    expect(screen.getByText(/日增 \+\d\.\d\d mm/)).toBeInTheDocument()
    expect(screen.getByText('45.4')).toBeInTheDocument()
    expect(screen.getByText('2.02')).toBeInTheDocument()
    expect(screen.getByText(/单轴 · 第二轴 0.69°/)).toBeInTheDocument()
  })

  it('今日降雨按本地同一天累计', () => {
    render(<DataCards reading={READING} points={POINTS} />)
    const today = new Date(POINTS[POINTS.length - 1].ts)
    const sameDay = new Date(POINTS[1].ts).getDate() === today.getDate()
    expect(screen.getByText('今日降雨')).toBeInTheDocument()
    expect(screen.getByText(sameDay ? '6.0' : '4.0')).toBeInTheDocument()
  })

  it('没有读数时显示破折号，不渲染 NaN', () => {
    render(<DataCards reading={null} points={[]} />)
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(5)
  })
})
