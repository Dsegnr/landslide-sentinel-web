import type { EChartsOption } from 'echarts'
import { useMemo } from 'react'

import { useECharts } from '../hooks/useECharts'
import { dailyMaxLevel, dayKey } from '../lib/format'
import { levelColor } from '../lib/levels'
import type { SeriesPrediction } from '../lib/types'

interface LevelTimelineProps {
  predictions: SeriesPrediction[]
}

export function timelineDays(predictions: SeriesPrediction[]) {
  const valid = new Map(dailyMaxLevel(predictions).map(d => [d.day, d]))
  const keys = predictions.map(p => dayKey(p.ts)).filter(Boolean).sort()
  if (!keys.length) return []
  const cursor = new Date(keys[0] + 'T00:00:00')
  const result: Array<{ day: string; level: number | null; stage: string }> = []
  while (dayKey(cursor.toISOString()) <= keys[keys.length - 1]) {
    const day = dayKey(cursor.toISOString())
    const row = valid.get(day)
    result.push({ day, level: row?.level ?? null, stage: row?.stage ?? '缺测' })
    cursor.setDate(cursor.getDate() + 1)
  }
  return result
}

// Daily maximum is a discrete state; show zero as a real line/point, not a zero-height bar.
export default function LevelTimeline({ predictions }: LevelTimelineProps) {
  const days = useMemo(() => timelineDays(predictions), [predictions])
  const available = days.filter(d => d.level !== null)
  const allCalm = available.length > 0 && available.every(d => d.level === 0)
  const option = useMemo<EChartsOption>(() => ({
    animation: false,
    backgroundColor: 'transparent',
    grid: { left: 46, right: 18, top: 28, bottom: 26 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(6,20,38,.94)',
      borderColor: 'rgba(79,195,247,.5)',
      textStyle: { color: '#e8f4ff', fontSize: 12 },
      formatter: (params: unknown) => {
        const list = params as Array<{ dataIndex: number }>
        const item = days[list[0]?.dataIndex ?? 0]
        if (!item) return ''
        return item.level === null ? `${item.day}　无可用等级记录` : `${item.day}　当日最高：${item.stage}<br/>最高等级 ${item.level}`
      },
    },
    xAxis: {
      type: 'category',
      data: days.map((d) => d.day.slice(5)),
      axisLine: { lineStyle: { color: 'rgba(100,150,250,.35)' } },
      axisLabel: { color: '#7fa6cc', fontSize: 11, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 4,
      interval: 1,
      axisLabel: {
        color: '#7fa6cc',
        fontSize: 11,
        formatter: (v: number) => ['平静', '关注', '预警', '高度', '警报'][v] ?? v,
      },
      splitLine: { lineStyle: { color: 'rgba(100,150,250,.14)' } },
    },
    series: [
      {
        name: '每日最高等级',
        type: 'line',
        step: 'end',
        connectNulls: false,
        showSymbol: true,
        symbol: 'circle',
        symbolSize: 7,
        clip: false,
        lineStyle: { width: 2, color: allCalm ? levelColor(0) : '#79abc9' },
        data: days.map((d) => ({
          value: d.level,
          itemStyle: { color: d.level === null ? '#94a3b8' : levelColor(d.level) },
        })),
      },
    ],
  }), [days, allCalm])

  const ref = useECharts(option)
  return <div className="timeline-container" data-testid="level-timeline">
    <div className="chart" ref={ref} />
    {available.length ? <div className="timeline-summary" style={{ color: allCalm ? levelColor(0) : undefined }}>{allCalm ? '有记录日期均为0级 · 平静' : '每日最高等级 · 缺测处断开'}</div>
      : <div className="timeline-empty">所选时段无可用等级记录</div>}
  </div>
}
