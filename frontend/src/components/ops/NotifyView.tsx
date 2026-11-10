import { useMemo, useState } from 'react'
import type { EChartsOption } from 'echarts'
import { api } from '../../lib/api'
import { useOpsResource } from '../../hooks/useOpsResource'
import { Plot, timeLabel } from './TelemetryCharts'
import { OpsCard, OpsError, OpsHead, OpsMetrics, opsTime } from './OpsUi'

const actionName: Record<string, string> = { created: '新增告警', escalated: '等级升级', cleared: '解除告警', acked: '确认处置', test: '渠道自检' }

export default function NotifyView({ isAdmin }: { isAdmin: boolean }) {
  const [busy, setBusy] = useState(false), [result, setResult] = useState(''), [filter, setFilter] = useState('all')
  const { data, error, loading, refresh, updated } = useOpsResource('notify', s => api.opsNotify(50, s))
  const recent = data?.recent ?? [], shown = recent.filter(e => filter === 'all' || e.ok === (filter === 'ok'))
  const option = useMemo<EChartsOption>(() => {
    const bins = new Map<string, [number, number]>()
    for (const r of recent) { if (!r.ts || !Number.isFinite(Date.parse(r.ts))) continue; const key = new Date(Math.floor(Date.parse(r.ts) / 3600000) * 3600000).toISOString(); const b = bins.get(key) ?? [0, 0]; b[r.ok ? 0 : 1]++; bins.set(key, b) }
    const keys = [...bins.keys()].sort()
    return { grid: { top: 35, left: 35, right: 15, bottom: 30 }, tooltip: { trigger: 'axis', confine: true }, legend: { top: 0, textStyle: { color: '#8faac1' } }, xAxis: { type: 'category', data: keys.map(k => timeLabel(k, true)), axisLabel: { color: '#8faac1', hideOverlap: true }, axisLine: { lineStyle: { color: '#31465b' } } }, yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#8faac1' }, splitLine: { lineStyle: { color: '#213248' } } }, series: [{ name: '成功', type: 'bar', stack: 'outcome', barMaxWidth: 25, itemStyle: { color: '#34d399' }, data: keys.map(k => bins.get(k)![0]) }, { name: '失败', type: 'bar', stack: 'outcome', barMaxWidth: 25, itemStyle: { color: '#eea1a1' }, data: keys.map(k => bins.get(k)![1]) }] }
  }, [recent])
  const test = async () => { setBusy(true); setResult(''); try { const r = await api.opsNotifyTest(); setResult(r.ok ? '渠道返回发送成功' : `发送失败：${r.detail}`); refresh() } catch (e) { setResult(`调用失败：${(e as Error).message}`) } finally { setBusy(false) } }
  return <>
    <OpsHead title="通知与派发" description="站内告警与外部通知分别记录，外发失败不阻断监测" loading={loading} refresh={refresh} updated={updated} />
    <OpsError error={error} retained={!!data} />
    <OpsMetrics items={[
      { title: '外发渠道', value: data ? data.configured ? '已配置' : '未配置' : '—', tone: data?.configured ? 'ow-good' : '' },
      { title: '外发起始等级', value: data?.min_level ?? '—', unit: '级' },
      { title: '待发队列', value: data?.queue_size ?? '—', unit: '条' },
      { title: '最近记录成功 / 失败', value: data ? `${data.recent_ok} / ${data.recent_fail}` : '—', unit: '条' },
    ]} />
    <div className="ow-two">
      <OpsCard title="派发结果分布" extra="最近50条记录 · 按小时汇总">
        {recent.length ? <Plot option={option} label="最近派发成功与失败记录的时段分布" /> : <div className="ow-empty ow-empty-large"><strong>暂无外发记录</strong><p>{data?.configured ? '渠道已配置，等待新的告警派发。' : '外发渠道尚未配置，告警仍可在站内展示与留痕。'}</p></div>}
      </OpsCard>
      <OpsCard title="当前通知链路" extra={data?.configured ? '外部渠道已配置' : '站内告警可用'}>
        <ol className="ow-flow"><li><b>告警产生</b><span>达到分级与去重规则后生成</span></li><li><b>站内记录</b><span>大屏展示、处置记录与审计留痕</span></li><li className={data?.configured ? '' : 'muted'}><b>外部通知</b><span>{data?.configured ? `${data.kind === 'wecom' ? '企业微信' : data.kind} · ${data.host ?? '渠道已配置'}` : '未配置 · 不向外发送'}</span></li></ol>
        <div className="ow-actions"><button disabled={!isAdmin || !data?.configured || busy} onClick={() => void test()}>{busy ? '发送中…' : '发送渠道自检消息'}</button><span className="ow-caption">{!isAdmin ? '仅管理人员可发送' : !data?.configured ? '配置渠道后可测试' : '将实际发送一条测试消息'}</span></div>
        {result ? <p role="status" className="ow-caption">{result}</p> : null}
      </OpsCard>
    </div>
    <OpsCard title="派发记录" extra={<div className="ow-segment">{[['all', '全部'], ['ok', '成功'], ['fail', '失败']].map(([v, t]) => <button key={v} className={filter === v ? 'active' : ''} onClick={() => setFilter(v)}>{t}</button>)}</div>}>
      <div className="ow-table-scroll"><table className="ow-table"><thead><tr><th>时间（北京）</th><th>设备</th><th>动作 / 等级</th><th>结果</th></tr></thead><tbody>{shown.map((e, i) => <tr key={`${e.ts}/${i}`}><td>{opsTime(e.ts)}</td><td>{e.device_id || '渠道自检'}</td><td>{actionName[e.action] ?? e.action} / {e.level}级</td><td><span className={e.ok ? 'ow-good' : 'ow-bad'}>{e.ok ? '成功' : '失败'}</span><small>{e.detail}</small></td></tr>)}</tbody></table></div>
      {!shown.length ? <div className="ow-empty">{loading ? '正在读取…' : recent.length ? '没有符合当前筛选的记录' : '暂无派发记录'}</div> : null}
    </OpsCard>
  </>
}
