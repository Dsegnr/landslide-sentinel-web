import type { EChartsOption } from 'echarts'
import { useMemo } from 'react'

import { useECharts } from '../hooks/useECharts'
import { dailyRain, fmtDay, fmtNum, fmtShort, toDate } from '../lib/format'
import type { SeriesPoint } from '../lib/types'

interface TrendChartProps {
  points: SeriesPoint[]
  rangeDays: number
}

// 过程线用**时间轴**（不是类目轴）：日尺度历史 + 分钟级实时读数混在一起时，
// 类目轴会把每一条读数平均铺开，视觉上"今天一堆点占掉半个屏幕"且时间被扭曲。
export default function TrendChart({ points, rangeDays }: TrendChartProps) {
  const option = useMemo<EChartsOption>(() => {
    const dense = rangeDays >= 7
    const ms = (ts: string) => toDate(ts)?.getTime() ?? 0
    const label = (value: number) => {
      const iso = new Date(value).toISOString()
      return dense ? fmtDay(iso) : fmtShort(iso)
    }
    const disp = points.map((p) => [ms(p.ts), p.D] as [number, number | null])
    const rain = dailyRain(points).map((p) => [ms(p.ts), p.mm] as [number, number])
    // 库水位只有关联了水位站才有；没有就不画这条线，也不占右侧轴位
    const hasLevel = points.some((p) => typeof p.level === 'number' && !Number.isNaN(p.level))
    const level = points.map((p) => [ms(p.ts), p.level ?? null] as [number, number | null])

    return {
      backgroundColor: 'transparent',
      grid: { left: 58, right: hasLevel ? 96 : 58, top: 62, bottom: 26 },
      tooltip: {
        trigger: 'axis',
        confine: true,
        backgroundColor: 'rgba(6,20,38,.94)',
        borderColor: 'rgba(79,195,247,.5)',
        textStyle: { color: '#e8f4ff', fontSize: 12 },
        formatter: (params: unknown) => {
          const list = params as Array<{ seriesName?: string; value: [number, number | null] }>
          const first = list[0]?.value
          if (!first) return ''
          const lines = [fmtShort(new Date(first[0]).toISOString())]
          for (const item of list) {
            const unit = item.seriesName === '库水位' ? ' m' : ' mm'
            const digits = item.seriesName === '库水位' ? 2 : item.seriesName === '日降雨' ? 1 : 2
            lines.push(`${item.seriesName ?? ''} ${fmtNum(item.value?.[1], digits)}${unit}`)
          }
          return lines.join('<br/>')
        },
      },
      legend: {
        left: 'center',
        top: 0,
        icon: 'roundRect',
        itemWidth: 12,
        itemHeight: 8,
        textStyle: { color: '#8fb6d9', fontSize: 12 },
      },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: 'rgba(100,150,250,.35)' } },
        axisLabel: { color: '#7fa6cc', fontSize: 11, hideOverlap: true, formatter: label },
        splitLine: { show: false },
      },
      yAxis: [
        {
          type: 'value',
          name: '位移 mm',
          position: 'left',
          nameTextStyle: { color: '#64b5f6', fontSize: 11 },
          scale: true,
          axisLabel: { color: '#7fa6cc', fontSize: 11 },
          splitLine: { lineStyle: { color: 'rgba(100,150,250,.14)' } },
        },
        {
          type: 'value',
          name: '降雨 mm',
          position: 'right',
          nameTextStyle: { color: '#64b5f6', fontSize: 11 },
          axisLabel: { color: '#7fa6cc', fontSize: 11 },
          splitLine: { show: false },
        },
        ...(hasLevel
          ? [{
              type: 'value' as const,
              name: '水位 m',
              position: 'right' as const,
              offset: 56,
              scale: true,
              nameTextStyle: { color: '#34d399', fontSize: 11 },
              axisLabel: { color: '#7fa6cc', fontSize: 11 },
              splitLine: { show: false },
            }]
          : []),
      ],
      dataZoom: [{ type: 'inside', throttle: 60 }],
      series: [
        {
          name: '地表位移',
          type: 'line',
          smooth: true,
          showSymbol: false,
          // 系列级 color 决定图例色块：只写 lineStyle.color 的话，图例会退回默认调色板，
          // 出现"图例紫蓝、曲线青色"对不上的情况（实测被视觉核对抓到）。
          color: '#4fc3f7',
          lineStyle: { width: 2.4, color: '#4fc3f7' },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(79,195,247,.42)' },
                { offset: 1, color: 'rgba(79,195,247,.02)' },
              ],
            },
          },
          data: disp,
        },
        {
          name: '降雨（日累计）',
          type: 'bar',
          yAxisIndex: 1,
          barWidth: 5,
          itemStyle: { color: 'rgba(96,165,250,.55)' },
          data: rain,
        },
        ...(hasLevel
          ? [{
              name: '库水位',
              type: 'line' as const,
              yAxisIndex: 2,
              smooth: true,
              showSymbol: false,
              color: '#34d399',
              lineStyle: { width: 2, color: '#34d399', type: 'dashed' as const },
              data: level,
            }]
          : []),
      ],
    }
  }, [points, rangeDays])

  const ref = useECharts(option)
  return <div className="chart" ref={ref} data-testid="trend-chart" />
}
