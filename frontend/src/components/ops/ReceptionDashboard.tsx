import { useEffect, useMemo, useRef, useState } from 'react'
import type { OpsDevice, TelemetryQuery } from '../../lib/api'
import { useLiveStream } from '../../hooks/useLiveStream'
import { useTelemetry } from '../../hooks/useTelemetry'
import { ChannelHeatmap, CHANNEL_INFO, ReceptionChart, SensorChart, timeLabel } from './TelemetryCharts'
import { OpsFreshness } from './OpsUi'
import AutoRefreshIndicator from './AutoRefreshIndicator'
import LastReceptionTime from './LastReceptionTime'

const groups = [
  ['D', '相对位移', 'mm'], ['R,P', '双轴倾角', '°'], ['T', '温度', '°C'], ['H', '空气湿度', '%'],
  ['RN', '雨滴响应', '%'], ['S', '土壤湿度响应', '%'], ['RNM', '周期降雨量', 'mm'], ['DIST', '原始测距', 'mm'],
]
const statusText = { online: '在线', stale: '停更', offline: '离线', never: '从未上报', no_link: '无物理链路' }
const fullTime = (ts: string | null | undefined) => ts ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ts)) : '尚无记录'

export default function ReceptionDashboard({ devices, current, onSelect, token, inventoryError, inventoryLoading = false, onRefreshInventory }: {
  devices: OpsDevice[]; current: OpsDevice | null; onSelect: (id: string) => void; token: string; inventoryError: string | null
  inventoryLoading?: boolean; onRefreshInventory?: () => void
}) {
  const [hours, setHours] = useState(1)
  const [anchor, setAnchor] = useState<TelemetryQuery['anchor']>('latest')
  const [date, setDate] = useState('')
  const [end, setEnd] = useState<string>()
  const [group, setGroup] = useState('D')
  const [cursor, setCursor] = useState(96)
  const [playing, setPlaying] = useState(false)
  const [dateError, setDateError] = useState('')
  const id = current?.device_id ?? ''
  const { status, event } = useLiveStream(anchor === 'live', id, token)
  const query = useMemo(() => ({ hours, anchor, channels: group, end }), [hours, anchor, group, end])
  const { data, loading, error, refreshAndWait, updated, nextPollAt } = useTelemetry(id, query, event?.type === 'reading' ? event : null)
  const [manualPending, setManualPending] = useState(false)
  const manualEpoch = useRef(0)
  const pending = loading || (!current && inventoryLoading)
  const placeholder = pending ? '正在读取硬件接收记录…' : inventoryError || error ? '读取失败，请刷新重试' : current ? '尚无数据' : '暂无可监测设备'
  const selection = `${id}/${hours}/${anchor}/${group}/${end}`
  useEffect(() => { manualEpoch.current++; setManualPending(false); return () => { manualEpoch.current++ } }, [selection])
  const manualRefresh = async () => {
    const epoch = ++manualEpoch.current
    setManualPending(true)
    try { if (current) await refreshAndWait(); else onRefreshInventory?.() }
    finally { if (manualEpoch.current === epoch) setManualPending(false) }
  }
  useEffect(() => { setPlaying(false); setCursor(96) }, [selection])
  useEffect(() => {
    if (!playing || !data) return
    const timer = window.setInterval(() => setCursor(n => Math.min(n + 2, data.bins.length)), 500)
    return () => window.clearInterval(timer)
  }, [playing, data])
  useEffect(() => { if (playing && data && cursor >= data.bins.length) setPlaying(false) }, [playing, data, cursor])
  const progress = data ? Math.min(cursor, data.bins.length) : 0
  const visibleBins = data?.bins.slice(0, progress) ?? []
  const stats = visibleBins.reduce((s, b) => ({ events: s.events + b.events, accepted: s.accepted + b.accepted, duplicated: s.duplicated + b.duplicated }), { events: 0, accepted: 0, duplicated: 0 })
  const cutoff = data && progress ? Date.parse(data.bins[progress - 1].ts) + data.bucket_seconds * 1000 : 0
  const recent = data?.recent.filter(r => Date.parse(r.ts) < cutoff) ?? []
  const hasValues = data?.points.some(p => Object.values(p.values).some(v => v !== null))
  const displayedChannels = group.split(',').map(ch => CHANNEL_INFO[ch][0]).join(' / ')
  const isLive = anchor === 'live'
  const applyDate = () => {
    const value = new Date(`${date}:00+08:00`)
    if (!date || !Number.isFinite(value.getTime())) { setDateError('请选择结束时间'); return }
    setDateError(''); setEnd(value.toISOString()); setAnchor('at')
  }
  return (
    <div className="rx-dashboard" aria-busy={pending}>
      <section className="rx-controls" aria-label="接收数据筛选">
        <label className="rx-device-label">监测设备
          <select aria-label="监测设备" value={id} disabled={!devices.length} onChange={e => onSelect(e.target.value)}>
            {!devices.length ? <option value="">{inventoryLoading ? '正在读取设备台账…' : inventoryError ? '设备台账读取失败' : '暂无可监测设备'}</option> : null}
            {devices.map(d => <option key={d.device_id} value={d.device_id}>{d.name}{d.hardware_marked ? '' : ' · 模拟点'}</option>)}
          </select>
        </label>
        <div className="rx-mode" aria-label="时间定位">
          <button className={isLive ? 'active' : ''} onClick={() => setAnchor('live')}>实时窗口</button>
          <button className={anchor === 'latest' ? 'active' : ''} onClick={() => { setAnchor('latest'); setEnd(undefined) }}>最近实测</button>
        </div>
        <label>时间范围
          <select aria-label="时间范围" value={hours} onChange={e => setHours(Number(e.target.value))}>
            {[[1, '1小时'], [6, '6小时'], [24, '24小时'], [168, '7天'], [720, '30天']].map(([value, title]) => <option key={value} value={value}>{title}</option>)}
          </select>
        </label>
        <button className="rx-refresh" onClick={() => void manualRefresh()} disabled={manualPending || (!data && pending)} aria-busy={manualPending}>{manualPending ? '刷新中…' : '刷新'}</button>
        <AutoRefreshIndicator nextPollAt={nextPollAt} interval={isLive ? 2000 : 30000} busy={loading && !manualPending} enabled={!!current && nextPollAt > 0} />
        <span className={`rx-stream ${isLive && status === 'open' ? 'connected' : ''}`}>{isLive ? status === 'open' ? '推送已连接 · 1秒节流 / 2秒核对' : '2秒自动核对' : '历史数据 · 非当前实测'}</span>
        <details className="rx-date"><summary>指定日期</summary><div>
          <label>结束时间（北京时间）<input type="datetime-local" aria-label="结束时间（北京时间）" value={date} onChange={e => setDate(e.target.value)} /></label>
          <button onClick={applyDate}>查看</button>{dateError ? <span role="alert">{dateError}</span> : null}
        </div></details>
      </section>
      {inventoryError || error ? <div className="rx-error" role="alert">{inventoryError || error}。{data ? '保留上次结果；自动重试中。' : '可点击刷新重试。'}</div> : null}
      <div className="rx-heading">
        <div><h2>数据接收</h2><p>{data ? `${fullTime(data.start)} — ${fullTime(data.end)} · 北京时间` : placeholder}</p><OpsFreshness updated={updated} loading={pending} /></div>
        <span className="rx-source">仅统计真实硬件</span>
      </div>
      <section className="rx-metrics" aria-label="所选时间窗口统计">
        <div><span>接收请求</span><strong>{data ? stats.events.toLocaleString() : '—'}<small>次</small></strong></div>
        <div className="rx-accepted"><span>新入库记录</span><strong>{data ? stats.accepted.toLocaleString() : '—'}<small>条</small></strong></div>
        <div><span>重复记录</span><strong>{data ? stats.duplicated.toLocaleString() : '—'}<small>条</small></strong></div>
        <LastReceptionTime timestamp={data?.latest_received} ready={!!data} />
      </section>
      <div className="rx-layout">
        <div className="rx-main">
          <section className="rx-card">
            <div className="rx-card-head"><h3>接收与入库趋势</h3><span>服务器接收时间</span></div>
            <div className="rx-chart-wrap">
              {data ? <ReceptionChart key={selection} data={data} cursor={progress} /> : <div className="rx-placeholder">{placeholder}</div>}
              {data && !data.summary.events ? <div className="rx-chart-empty">所选时段没有硬件接收记录</div> : null}
            </div>
            <div className="rx-chart-foot"><span>{data ? `每${data.bucket_seconds < 60 ? `${data.bucket_seconds}秒` : `${+(data.bucket_seconds / 60).toFixed(1)}分钟`}汇总` : '按时段汇总'} · 累计仅限当前窗口</span>
              {!isLive && data && data.summary.events > 0 ? <div className="rx-playback">
                <button onClick={() => { if (!playing && cursor >= data.bins.length) setCursor(1); setPlaying(!playing) }} aria-label={playing ? '暂停历史播放' : '播放接收历史'}>{playing ? '暂停' : '播放'}</button>
                <input type="range" aria-label="历史播放进度" min="1" max={data.bins.length} value={progress || 1} onChange={e => { setPlaying(false); setCursor(Number(e.target.value)) }} />
                <span>{progress < data.bins.length ? timeLabel(data.bins[Math.max(0, progress - 1)].ts) : '完整窗口'}</span>
              </div> : null}
            </div>
          </section>
          <section className="rx-card">
            <div className="rx-card-head"><h3>传感数据曲线</h3><span>硬件采样时间</span></div>
            <div className="rx-channel-picker" role="group" aria-label="传感通道组">
              {groups.map(([value, title, unit]) => <button key={value} className={group === value ? 'active' : ''} onClick={() => setGroup(value)}>{title}<small>{unit}</small></button>)}
            </div>
            <div className="rx-chart-wrap">
              {data ? <SensorChart key={selection} data={data} cursor={progress} /> : <div className="rx-placeholder">{placeholder}</div>}
              {data && !hasValues ? <div className="rx-chart-empty">{data.summary.samples ? `该时段未收到${displayedChannels}数据` : '该时段没有硬件采样记录'}</div> : null}
            </div>
            <p className="rx-caption">{data?.aggregation === 'mean_min_max' ? '按时段显示均值；悬停查看最小–最大值。' : '保留原始采样值；拖动底部滑条可缩放。'}{group === 'RN' || group === 'S' ? ' 响应值未经含水率或雨量标定。' : ''}</p>
          </section>
        </div>
        <aside className="rx-aside">
          <section className="rx-card">
            <div className="rx-card-head"><h3>通道数据覆盖</h3><span>采样时间</span></div>
            {data ? <ChannelHeatmap key={selection} data={data} cursor={progress} /> : <div className="rx-placeholder">{placeholder}</div>}
            <div className="rx-heat-legend"><span><i />无采样</span><span><i />无该通道</span><span><i />部分有值</span><span><i />完整</span></div>
            <p className="rx-caption">按已收到的硬件记录统计有值比例。</p>
          </section>
          <section className="rx-card rx-device-status">
            <div className="rx-card-head"><h3>设备与链路</h3><span className={`rx-link-${current?.status}`}>{current ? statusText[current.status] : '—'}</span></div>
            <strong>{current?.name ?? (inventoryLoading ? '正在读取设备台账…' : '暂无可监测设备')}</strong>
            <dl><div><dt>数据来源</dt><dd>{!current ? '—' : current.hardware_marked ? '已接入真实硬件' : '模拟/演示 · 无实测接入'}</dd></div>
              <div><dt>接入令牌</dt><dd>{!current ? '—' : current.token_registered ? '已登记' : '未登记令牌'}</dd></div>
              <div><dt>最新采样</dt><dd>{fullTime(data?.latest_sample)}</dd></div>
              <div><dt>窗口采样</dt><dd>{data ? data.heat.slice(0, progress).reduce((n, b) => n + b.rows, 0) : '—'} 条</dd></div></dl>
            {current && !current.hardware_marked ? <p className="rx-caption">模拟读数不计入本页接收统计。</p> : null}
          </section>
          <details className="rx-card rx-raw"><summary>原始接收记录 <span>最近 {recent.length} 条</span></summary>
            <div className="rx-raw-scroll"><table><thead><tr><th>接收时间（北京）</th><th>入库</th><th>重复</th></tr></thead><tbody>
              {recent.map((r, i) => <tr key={`${r.ts}-${i}`}><td>{fullTime(r.ts).replace(/^\d{4}\//, '')}</td><td>{r.accepted}</td><td>{r.duplicated}</td></tr>)}
            </tbody></table>{!recent.length ? <p className="rx-caption">该时段无记录</p> : null}</div>
          </details>
        </aside>
      </div>
    </div>
  )
}
