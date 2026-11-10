import { describe, expect, it } from 'vitest'

import {
  dailyDelta,
  dailyDeltaFromPoints,
  dailyMaxLevel,
  dailyRain,
  escapeHtml,
  fmtAgo,
  fmtNum,
  fmtPercent,
  todayRain,
} from './format'

describe('数值格式化', () => {
  it('HTML 转义：拼进 tooltip 的用户文本不能带出标签（防存储型 XSS）', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;')
    expect(escapeHtml('"><script>alert(1)</script>')).toBe(
      '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(escapeHtml(`a & b 'c'`)).toBe('a &amp; b &#39;c&#39;')
    expect(escapeHtml(null)).toBe('')
  })

  it('缺失值统一显示为破折号，不显示 NaN/null', () => {
    expect(fmtNum(null)).toBe('—')
    expect(fmtNum(undefined)).toBe('—')
    expect(fmtNum(Number.NaN)).toBe('—')
    expect(fmtPercent(null)).toBe('—')
  })

  it('按位数格式化并带单位', () => {
    expect(fmtNum(19.14420965578003, 2)).toBe('19.14')
    expect(fmtNum(8, 1, ' mm')).toBe('8.0 mm')
    expect(fmtPercent(0.0334, 1)).toBe('3.3%')
  })

  it('相对时间分档', () => {
    const now = new Date('2026-09-14T10:00:00Z').getTime()
    expect(fmtAgo(now - 1000, now)).toBe('刚刚')
    expect(fmtAgo(now - 30_000, now)).toBe('30 秒前')
    expect(fmtAgo(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(fmtAgo(now - 3 * 3600_000, now)).toBe('3 小时前')
  })
})

describe('序列派生量', () => {
  it('位移日增量取末尾两点之差', () => {
    expect(dailyDelta([1, 2, 3.5])).toBeCloseTo(1.5)
    expect(dailyDelta([1])).toBeNull()
    expect(dailyDelta([1, null, null])).toBeNull()
  })

  it('今日降雨只累计本地同一天的读数', () => {
    const rain = todayRain([
      { ts: '2026-09-13T02:00:00Z', RNM: 5 },
      { ts: '2026-09-14T02:00:00Z', RNM: 2 },
      { ts: '2026-09-14T03:00:00Z', RNM: 3 },
    ])
    // 以本机时区为准：同一天的两条相加，跨天的不算
    const today = new Date('2026-09-14T03:00:00Z')
    const sameDay = new Date('2026-09-14T02:00:00Z').getDate() === today.getDate()
    expect(rain).toBe(sameDay ? 5 : 3)
  })

  it('位移日增量先按自然日聚合再作差（分钟级采样下不能直接取末尾两点）', () => {
    const points = [
      { ts: '2026-09-12T00:00:00Z', D: 10.0 },
      { ts: '2026-09-14T00:00:00Z', D: 10.5 },
      { ts: '2026-09-14T00:01:00Z', D: 10.52 },
      { ts: '2026-09-14T00:02:00Z', D: 10.53 },
    ]
    // 相邻两天（09-12 -> 09-14，以本机时区归一）应为 0.53，而不是同一天内的 0.01
    const delta = dailyDeltaFromPoints(points)
    expect(delta).not.toBeNull()
    expect(delta as number).toBeGreaterThan(0.4)
  })

  it('等级演进按自然日取当日最高等级', () => {
    const rows = dailyMaxLevel([
      { ts: '2026-09-10T00:00:00Z', combined_level: 1, stage: '关注' },
      { ts: '2026-09-10T01:00:00Z', combined_level: 3, stage: '高度预警' },
      { ts: '2026-09-11T00:00:00Z', combined_level: 4, stage: '警报' },
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0].level).toBe(3)
    expect(rows[1].level).toBe(4)
  })

  it('缺测记录不作为平静等级进入历史汇总', () => {
    expect(dailyMaxLevel([
      { ts: '2026-09-10T00:00:00Z', combined_level: 0, stage: '平静', data_available: false },
      { ts: '2026-09-11T00:00:00Z', combined_level: 2, stage: '预警', data_available: true },
    ])).toEqual([{ day: '2026-09-11', ts: '2026-09-11T00:00:00Z', level: 2, stage: '预警' }])
  })

  it('降雨按自然日累计（实时读数是"本周期降雨量"，不能与日累计混画）', () => {
    const rows = dailyRain([
      { ts: '2026-09-13T00:00:00Z', RNM: 12 },
      { ts: '2026-09-14T00:00:00Z', RNM: 0.5 },
      { ts: '2026-09-14T00:01:00Z', RNM: 0.25 },
    ])
    expect(rows).toHaveLength(2)
    expect(Math.max(...rows.map((r) => r.mm))).toBeCloseTo(12, 5)
  })
})
