import type { EChartsOption } from 'echarts'
import { useEffect, useMemo, useRef } from 'react'
import { echarts } from '../../lib/echarts'
import type { TelemetryHistory } from '../../lib/api'

const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
const day = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' })
export const timeLabel = (ts: string, dates = false) => `${dates ? `${day.format(new Date(ts))} ` : ''}${clock.format(new Date(ts))}`
export const CHANNEL_INFO: Record<string, [string, string]> = {
  D: ['相对位移', 'mm'], R: ['倾角 R', '°'], P: ['倾角 P', '°'], T: ['温度', '°C'], H: ['空气湿度', '%'],
  RN: ['雨滴响应', '%'], S: ['土壤湿度响应', '%'], RNM: ['周期降雨量', 'mm'], DIST: ['原始测距', 'mm'],
}
const colors = ['#4fc3f7', '#b6a1eb']
const axis = { axisLine: { lineStyle: { color: '#31465b' } }, axisTick: { show: false }, axisLabel: { color: '#8faac1', fontSize: 11 } }
const splits = { lineStyle: { color: '#213248', type: 'dashed' as const } }
const tooltip = { trigger: 'axis' as const, confine: true, backgroundColor: '#102438', borderColor: '#365871', textStyle: { color: '#dce9f3', fontSize: 12 }, transitionDuration: 0 }

/** Stable instance and zoom across updates, disposed on leaving this page. */
export function Plot({ option, label, className = '' }: { option: EChartsOption; label: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const instance = useRef<ReturnType<typeof echarts.init> | null>(null)
  const initialized = useRef(false)
  useEffect(() => {
    if (!ref.current) return
    const chart = echarts.init(ref.current)
    instance.current = chart
    let frame = 0
    const resize = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => chart.resize()) }
    const observer = new ResizeObserver(resize)
    observer.observe(ref.current)
    return () => { cancelAnimationFrame(frame); observer.disconnect(); chart.dispose(); instance.current = null; initialized.current = false }
  }, [])
  useEffect(() => {
    const next = { ...option }
    if (initialized.current) delete next.dataZoom
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    instance.current?.setOption({ ...next, animation: !reduced && option.animation !== false, animationDuration: 0, animationDurationUpdate: 180 }, { replaceMerge: ['series'], lazyUpdate: true })
    initialized.current = true
  }, [option])
  return <div ref={ref} className={`rx-plot ${className}`} role="img" aria-label={label} />
}

export function receptionOption(data: TelemetryHistory, cursor: number): EChartsOption {
  const bins = data.bins.slice(0, cursor)
  return {
    tooltip, grid: { top: 52, left: 46, right: 46, bottom: 30 },
    legend: { top: 0, right: 8, textStyle: { color: '#a9bfd0', fontSize: 11 }, itemWidth: 12, itemHeight: 7 },
    xAxis: { ...axis, type: 'category', data: data.bins.map(b => b.ts), axisLabel: { ...axis.axisLabel, hideOverlap: true, formatter: (v: string) => timeLabel(v, data.hours >= 24) } },
    yAxis: [{ ...axis, type: 'value', name: '条 / 时段', minInterval: 1, splitLine: splits, nameTextStyle: { color: '#8faac1', fontSize: 11 } },
      { ...axis, type: 'value', name: '累计入库 · 条', minInterval: 1, splitLine: { show: false }, nameTextStyle: { color: '#8faac1', fontSize: 11 } }],
    series: [
      { id: 'accepted', name: '新入库', type: 'bar', stack: 'rows', data: bins.map(b => b.accepted), itemStyle: { color: '#34d399', borderRadius: [2, 2, 0, 0] }, barMaxWidth: 12 },
      { id: 'duplicated', name: '重复行', type: 'bar', stack: 'rows', data: bins.map(b => b.duplicated), itemStyle: { color: '#b6a1eb' }, barMaxWidth: 12 },
      { id: 'cumulative', name: '累计入库', type: 'line', step: 'end', yAxisIndex: 1, data: bins.map(b => b.cumulative), showSymbol: false, lineStyle: { width: 2, color: '#4fc3f7' }, itemStyle: { color: '#4fc3f7' } },
    ],
  }
}

export function ReceptionChart({ data, cursor }: { data: TelemetryHistory; cursor: number }) {
  const option = useMemo(() => receptionOption(data, cursor), [data, cursor])
  return <Plot option={option} label="接收与入库趋势：新入库条数、重复行和窗口内累计入库条数" />
}

export function SensorChart({ data, cursor }: { data: TelemetryHistory; cursor: number }) {
  const option = useMemo<EChartsOption>(() => {
    const stop = cursor >= data.bins.length ? Date.parse(data.end) : Date.parse(data.bins[Math.max(0, cursor - 1)].ts) + data.bucket_seconds * 1000
    const points = data.points.filter(p => Date.parse(p.ts) < stop)
    const unit = CHANNEL_INFO[data.channels[0]]?.[1] ?? ''
    return {
      tooltip: { ...tooltip, formatter: (raw: unknown) => {
        const items = (Array.isArray(raw) ? raw : [raw]) as { seriesName: string; seriesId: string; dataIndex: number; value: [number, number | null] }[]
        const first = items[0]
        if (!first) return ''
        const p = points[first.dataIndex]
        return [timeLabel(new Date(first.value[0]).toISOString(), true), ...items.map(v => {
          const range = p?.ranges[v.seriesId]
          const ext = range?.[0] != null && range[1] != null ? `<br/>范围 ${range[0].toFixed(2)}–${range[1].toFixed(2)} ${unit}` : ''
          return `${v.seriesName}：${v.value[1] == null ? '未收到' : Number(v.value[1]).toFixed(2)} ${unit}${ext}`
        })].join('<br/>')
      } },
      grid: { top: 30, left: 55, right: 18, bottom: 59 },
      legend: { top: 0, right: 8, textStyle: { color: '#a9bfd0', fontSize: 11 } },
      xAxis: { ...axis, type: 'time', min: Date.parse(data.start), max: Date.parse(data.end), axisLabel: { ...axis.axisLabel, hideOverlap: true, formatter: (v: number) => timeLabel(new Date(v).toISOString(), data.hours >= 24) } },
      yAxis: { ...axis, type: 'value', scale: true, name: unit, splitLine: splits, nameTextStyle: { color: '#8faac1' } },
      dataZoom: [{ type: 'inside', filterMode: 'none' }, { type: 'slider', height: 16, bottom: 6, borderColor: '#294258', textStyle: { color: '#8faac1' }, showDetail: false, brushSelect: false }],
      series: data.channels.map((ch, i) => ({ id: ch, name: CHANNEL_INFO[ch]?.[0] ?? ch, type: 'line',
        data: points.map(p => [Date.parse(p.ts), p.values[ch]]), connectNulls: false, showSymbol: points.length < 3,
        symbolSize: 5, smooth: false, lineStyle: { width: 2, color: colors[i] }, itemStyle: { color: colors[i] },
        areaStyle: data.channels.length === 1 ? { color: colors[i], opacity: .07 } : undefined,
      })),
    }
  }, [data, cursor])
  return <Plot option={option} className="rx-sensor-plot" label={`硬件实测曲线：${data.channels.map(ch => CHANNEL_INFO[ch]?.[0] ?? ch).join('、')}`} />
}

export function ChannelHeatmap({ data, cursor }: { data: TelemetryHistory; cursor: number }) {
  const option = useMemo<EChartsOption>(() => {
    const stride = Math.ceil(data.heat.length / 24)
    const groups = Array.from({ length: Math.ceil(data.heat.length / stride) }, (_, i) => {
      const rows = data.heat.slice(i * stride, Math.min((i + 1) * stride, cursor))
      return { ts: data.heat[i * stride].ts, rows: rows.reduce((n, b) => n + b.rows, 0),
        counts: data.heat_channels.map((_, j) => rows.reduce((n, b) => n + b.counts[j], 0)) }
    })
    return {
      animation: false,
      visualMap: { type: 'piecewise', show: false, dimension: 2, seriesIndex: 0, pieces: [
        { value: -1, color: '#172738' }, { value: 0, color: '#334356' },
        { gt: 0, lt: 1, color: '#437689' }, { value: 1, color: '#3bbaa8' },
      ] },
      tooltip: { ...tooltip, trigger: 'item', formatter: (raw: unknown) => {
        const value = (raw as { value: number[] }).value
        const [i, j] = value, g = groups[i], n = g.counts[j]
        return `${CHANNEL_INFO[data.heat_channels[j]]?.[0] ?? data.heat_channels[j]}<br/>${timeLabel(g.ts, true)} 起<br/>${g.rows ? `${n} / ${g.rows} 条有值（${Math.round(n / g.rows * 100)}%）` : '没有硬件采样记录'}`
      } },
      grid: { top: 4, left: 66, right: 6, bottom: 25 },
      xAxis: { ...axis, type: 'category', data: groups.map(g => g.ts), splitArea: { show: false }, axisLabel: { ...axis.axisLabel, interval: Math.max(1, Math.floor(groups.length / 3)), formatter: (v: string) => timeLabel(v, data.hours >= 24), hideOverlap: true } },
      yAxis: { ...axis, type: 'category', inverse: true, data: data.heat_channels.map(ch => ({ D: '位移', R: '倾角 R', P: '倾角 P', T: '温度', H: '湿度', RN: '雨滴', S: '土壤', RNM: '雨量', DIST: '测距' })[ch] ?? ch), axisLabel: { ...axis.axisLabel, interval: 0 } },
      series: [{ id: 'channels', type: 'heatmap', data: groups.flatMap((g, i) => data.heat_channels.map((_, j) => {
        const ratio = g.rows ? g.counts[j] / g.rows : -1
        return { value: [i, j, ratio], itemStyle: { color: ratio < 0 ? '#172738' : ratio === 0 ? '#334356' : ratio < 1 ? '#437689' : '#3bbaa8', borderColor: '#0b1827', borderWidth: 1 } }
      })), emphasis: { itemStyle: { borderColor: '#dce9f3', borderWidth: 1 } } }],
    }
  }, [data, cursor])
  return <Plot option={option} className="rx-heat-plot" label="硬件通道有值比例热力图；无采样、无该通道、部分、完整四种状态" />
}
