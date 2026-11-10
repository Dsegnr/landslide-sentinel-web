import { useState } from 'react'
import { api, type OpsDevice } from '../../lib/api'
import { useOpsResource } from '../../hooks/useOpsResource'
import { OpsCard, OpsError, OpsHead, OpsMetrics, opsTime } from './OpsUi'

export default function TokenSecurityView({ devices = [] }: { devices?: OpsDevice[] }) {
  const { data, error, loading, refresh, updated } = useOpsResource('security', s => api.opsSecurity(s))
  const [id, setId] = useState('')
  const current = data?.tokens.find(t => t.device_id === id) ?? data?.tokens[0]
  const total = current?.sources.reduce((n, s) => n + s.n, 0) ?? 0
  return <>
    <OpsHead title="令牌与接入安全" description="查看登记状态与真实接入痕迹，不显示令牌原文" loading={loading} refresh={refresh} updated={updated} />
    <OpsError error={error} retained={!!data} />
    <OpsMetrics items={[
      { title: '设备台账', value: data?.tokens.length ?? '—', unit: '台' },
      { title: '令牌已登记', value: data?.registered_count ?? '—', unit: '台', tone: 'ow-good' },
      { title: '有接收审计', value: data ? data.tokens.filter(t => t.last_ingest_ts).length : '—', unit: '台' },
      { title: '存在多个出口', value: data ? data.tokens.filter(t => t.source_changed).length : '—', unit: '台' },
    ]} />
    <div className="ow-two">
      <OpsCard title="设备登记与使用痕迹" extra="点击设备查看来源"><div className="ow-table-scroll"><table className="ow-table"><thead><tr><th>设备</th><th>令牌登记</th><th>最近接收（北京）</th><th>来源</th></tr></thead><tbody>
        {data?.tokens.map(t => <tr key={t.device_id} className={current?.device_id === t.device_id ? 'selected' : ''}><td><button className="ow-table-link" onClick={() => setId(t.device_id)}>{t.name}</button><small>{devices.find(d => d.device_id === t.device_id)?.hardware_marked ? '已接入硬件' : '无硬件接入标记'}</small></td><td className={t.token_registered ? 'ow-good' : 'ow-muted'}>{t.token_registered ? '已登记' : '未登记'}</td><td>{opsTime(t.last_ingest_ts)}</td><td>{!t.last_ingest_ts ? '暂无审计' : t.source_changed ? '多个出口' : '单一出口'}</td></tr>)}
      </tbody></table></div>{!data?.tokens.length ? <div className="ow-empty">{loading ? '正在读取…' : '暂无设备记录'}</div> : null}</OpsCard>
      <OpsCard title="接入来源分布" extra={current?.name}>
        {current?.sources.length ? <><p className="ow-caption">按该设备最近最多200次接收审计统计，最多列出5个出口。</p>
          {current.sources.map(s => <div className="ow-source-row" key={s.remote}><div><b>{s.remote}</b><span>{s.n} 次</span></div><div className="ow-track"><i style={{ width: `${total ? s.n / total * 100 : 0}%` }} /></div><small>{opsTime(s.first)} — {opsTime(s.last)}</small></div>)}
        </> : <div className="ow-empty">该设备暂无接收审计，尚不能判断来源变化。</div>}
        <p className="ow-caption">出口变化可能来自蜂窝网络切换，不能据此认定异常入侵。</p>
      </OpsCard>
    </div>
    <details className="ow-details"><summary>当前接入安全策略</summary>{data ? <div className="ow-policy">
      <div><span>设备鉴权</span><b>X-Device-Token · 每设备独立</b></div><div><span>登录保护</span><b>{data.policy.login_lock.max_failures}次失败后锁定{Math.round(data.policy.login_lock.lock_seconds / 60)}分钟</b></div>
      <div><span>会话有效期</span><b>{data.policy.jwt_expire_minutes}分钟</b></div><div><span>管理入口</span><b>{data.policy.admin_entry}</b></div>
      <p className="ow-caption">{data.policy.anti_enumeration}</p><p className="ow-caption">令牌变更由部署管理员处理，页面仅供查询。</p>
    </div> : <div className="ow-empty">正在读取…</div>}</details>
  </>
}
