import { describe, expect, it } from 'vitest'

import type { WeatherResponse } from './api'
import { SEVERITY_COLORS, severityColor, weatherIcon, weatherLine } from './weatherIcon'

describe('天气图标与配色', () => {
  it('天气码 → 图标：晴/阴/雨/雷暴各有对应', () => {
    expect(weatherIcon(0)).toBe('☀️')
    expect(weatherIcon(3)).toBe('☁️')
    expect(weatherIcon(63)).toBe('🌧️')
    expect(weatherIcon(95)).toBe('⛈️')
    expect(weatherIcon(999)).toBe('🌡️')      // 未知码不瞎猜
    expect(weatherIcon(null)).toBe('🌡️')
  })

  it('严重度 → 颜色：五档且越危险越红', () => {
    expect(severityColor(0)).toBe(SEVERITY_COLORS[0])
    expect(severityColor(4)).toBe('#ff4d6d')
    expect(severityColor(99)).toBe('#ff4d6d')   // 越界夹住
    expect(severityColor(-3)).toBe('#7fd4ff')
  })

  it('一行摘要：带上现象、温湿度、风速；无数据时不装作有', () => {
    const w: WeatherResponse = {
      available: true, source: 'open-meteo', weight_bonus: 0.2, weight_reason: '',
      phenomenon: '中雨', severity_label: '中',
      now: { temp: 21.4, precip: 1.2, text: '中雨', humidity: 88, wind: 3.1 },
    }
    const line = weatherLine(w)
    expect(line).toContain('中雨')
    expect(line).toContain('21.4℃')
    expect(line).toContain('湿度 88%')
    expect(weatherLine({ ...w, available: false })).toBe('暂无天气数据')
  })
})
