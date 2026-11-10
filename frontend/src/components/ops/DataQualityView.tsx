import { useMemo, useState } from 'react'
import type { EChartsOption } from 'echarts'
import { api, type OpsDevice } from '../../lib/api'
import { useOpsResource } from '../../hooks/useOpsResource'
import { ChannelHeatmap, CHANNEL_INFO, Plot, timeLabel } from './TelemetryCharts'
import { OpsCard, OpsError, OpsHead, OpsMetrics, opsNumber, opsTime } from './OpsUi'

export default function DataQualityView({ devices, current, onSelect }: { devices: OpsDevice[]; current: OpsDevice | null; onSelect: (id: string) => void }) {
  const [hours, setHours] = useState(24)
  const [anchor, setAnchor] = useState<'live' | 'latest'>('latest')
  const id = current?.device_id ?? ''
  const { data, error, loading, refresh, updated } = useOpsResource(`quality/${id}/${hours}/${anchor}`, signal => id ? api.opsQuality(id, hours, anchor, signal) : Promise.resolve(null), 30000, !!id)
  const h = data?.history
  const sourceTotal = data?.sources.reduce((n, s) => n + s.count, 0) ?? 0
  const option = useMemo<EChartsOption>(() => ({
    grid: { top: 24, left: 58, right: 18, bottom: 32 },
    tooltip: { trigger: 'axis', confine: true, backgroundColor: '#102438', textStyle: { color: '#dce9f3' } },
    xAxis: { type: 'time', min: h ? Date.parse(h.start) : undefined, max: h ? Date.parse(h.end) : undefined, axisLabel: { color: '#8faac1', hideOverlap: true, formatter: (v: number) => timeLabel(new Date(v).toISOString(), hours >= 24) }, axisLine: { lineStyle: { color: '#31465b' } } },
    yAxis: { type: 'value', name: '秒', nameTextStyle: { color: '#8faac1' }, axisLabel: { color: '#8faac1' }, splitLine: { lineStyle: { color: '#213248', type: 'dashed' } } },
    series: [{ id: 'delay', name: '采样至入库间隔均值（秒）', type: 'line', showSymbol: (data?.delay_series.filter(([, v]) => v !== null).length ?? 0) < 3, connectNulls: false, data: h?.bins.map(b => [Date.parse(b.ts), data?.delay_series.find(([ts]) => ts === b.ts)?.[1] ?? null]) ?? [], lineStyle: { color: '#4fc3f7', width: 2 }, itemStyle: { color: '#4fc3f7' }, areaStyle: { color: '#4fc3f7', opacity: .07 } }],
  }), [data, h, hours])
  return <>
    <OpsHead title="链路与数据完整性" description="区分真实接入、采样间隔与通道覆盖" loading={loading} refresh={refresh} updated={updated} />
    <div className="ow-toolbar">
      <label>监测设备<select aria-label="链路设备" value={id} onChange={e => onSelect(e.target.value)}>{devices.map(d => <option key={d.device_id} value={d.device_id}>{d.name}</option>)}</select></label>
      <label>统计范围<select aria-label="链路统计范围" value={hours} onChange={e => setHours(Number(e.target.value))}>{[[1, '1小时'], [24, '24小时'], [72, '72小时'], [168, '7天'], [720, '30天']].map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
      <div className="ow-segment"><button className={anchor === 'latest' ? 'active' : ''} onClick={() => setAnchor('latest')}>最近实测</button><button className={anchor === 'live' ? 'active' : ''} onClick={() => setAnchor('live')}>当前窗口</button></div>
      <span className="ow-context">{anchor === 'latest' ? '历史窗口 · 非当前实测' : '当前时间窗口'}{current?.status === 'offline' ? ' · 硬件离线' : current?.status === 'no_link' ? ' · 无物理链路' : ''}</span>
    </div>
    <OpsError error={error} retained={!!data} />
    <p className="ow-window">{h ? `${opsTime(h.start)} — ${opsTime(h.end)}（北京时间）` : '正在读取所选设备…'}</p>
    <OpsMetrics items={[
      { title: '硬件采样记录', value: h ? h.summary.samples.toLocaleString() : '—', unit: '条' },
      { title: '采样至入库均值', value: opsNumber(data?.delay.mean), unit: '秒' },
      { title: '入库间隔超过5分钟', value: data ? data.delay.late : '—', unit: '条' },
      { title: '内部采样间隔超过30分钟', value: h?.summary.samples ? data?.gap_count : '—', unit: h?.summary.samples ? '段' : '' },
    ]} />
    <div className="ow-two"><div className="ow-stack">
      <OpsCard title="采样至入库间隔" extra="仅真实硬件 · 时段均值">
        <div className="rx-chart-wrap"><Plot key={`${id}/${anchor}/${hours}`} option={option} label="硬件采样至入库间隔趋势" />{!data?.delay.n ? <div className="rx-chart-empty">{loading ? '正在读取…' : '所选窗口没有可用硬件记录'}</div> : null}</div>
        <p className="ow-caption">包含采集、传输及入库过程，不等同于纯网络延迟。{data?.delay.negative ? ` ${data.delay.negative}条负间隔已排除，请核对设备时钟。` : ''}</p>
      </OpsCard>
      <OpsCard title="硬件通道覆盖" extra="按已收到的硬件采样统计">
        {h ? <ChannelHeatmap data={h} cursor={h.bins.length} /> : <div className="ow-empty">正在读取覆盖记录…</div>}
        <div className="rx-heat-legend"><span><i />无采样</span><span><i />无该通道</span><span><i />部分有值</span><span><i />完整</span></div>
        <p className="ow-caption">补齐数据不计入硬件覆盖；有值比例不代表通信成功率。</p>
      </OpsCard>
      <details className="ow-details"><summary>查看内部采样间隔 <span>{data?.gap_count ?? 0} 段</span></summary><p className="ow-caption">只检查窗口内相邻硬件采样，不能据此认定网络掉线。最多显示最近20段。</p>
        {data?.gaps.length ? data.gaps.map(g => <div className="ow-line" key={g.to}><span>{opsTime(g.from)} → {opsTime(g.to)}</span><b>{opsNumber(g.minutes)} 分钟</b></div>) : <p className="ow-caption">{h?.summary.samples ? '没有超过30分钟的内部采样间隔。' : '没有硬件采样，无法判断间隔。'}</p>}
      </details>
    </div><aside className="ow-stack">
      <OpsCard title="记录来源构成" extra={`${sourceTotal.toLocaleString()} 条`}>
        <div className="ow-source-bar">{data?.sources.map(s => <i key={s.source} className={s.source === 'hardware' ? 'hw' : s.source === 'simulation' ? 'sim' : 'other'} style={{ width: `${sourceTotal ? s.count / sourceTotal * 100 : 0}%` }} />)}</div>
        {data?.sources.length ? data.sources.map(s => <div className="ow-line" key={s.source}><span>{s.source === 'hardware' ? '硬件实测' : s.source === 'simulation' ? '模拟 / 补齐' : '其他来源'}</span><b>{s.count.toLocaleString()} 条</b></div>) : <div className="ow-empty">所选窗口暂无记录</div>}
      </OpsCard>
      <OpsCard title="硬件通道最近值" extra="当前时效单独标注"><div className="ow-table-scroll"><table className="ow-table"><thead><tr><th>通道</th><th>最近值</th><th>状态</th></tr></thead><tbody>
        {(data?.channels ?? []).map(c => { const info = CHANNEL_INFO[c.channel], stale = c.age_minutes !== null && c.age_minutes > 30
          return <tr key={c.channel}><td>{info?.[0]}<small>{c.last_ts ? opsTime(c.last_ts) : '暂无硬件值'}</small></td><td>{opsNumber(c.value, 2)}<small>{info?.[1]}</small></td><td className={c.out_of_range ? 'ow-bad' : 'ow-muted'}>{c.value === null ? '未接入' : c.out_of_range ? '数值待核查' : stale ? '历史值' : '有更新'}{c.repeated && !stale ? <small>连续5条同值</small> : null}</td></tr>})}
      </tbody></table></div><p className="ow-caption">倾角保留正负方向；位移为相对量。雨滴与土壤为响应值，含水率解释需标定。</p></OpsCard>
    </aside></div>
  </>
}
