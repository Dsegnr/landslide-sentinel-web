import { useEffect, useState, type ReactNode } from 'react'
import { copyText } from '../../lib/clipboard'

const formatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
export const opsTime = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? formatter.format(new Date(value)) : '暂无记录'
export const opsNumber = (value?: number | null, digits = 1) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: digits })
export function OpsFreshness({ updated, loading }: { updated: number; loading: boolean }) {
  const time = updated ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(updated)) : ''
  return <span className="ow-freshness" title={updated ? `最近核对：${opsTime(new Date(updated).toISOString())}` : undefined}>
    {updated ? `${loading ? '核对中 · 上次' : '最近核对'} ${time}` : loading ? '正在读取…' : ''}
  </span>
}
export function OpsHead({ title, description, loading, refresh, updated = 0 }: { title: string; description: string; loading?: boolean; refresh: () => void; updated?: number }) {
  return <div className="ow-heading"><div><h2>{title}</h2><p>{description}</p><OpsFreshness updated={updated} loading={!!loading} /></div><button onClick={refresh} disabled={loading}>{loading ? '核对中…' : '刷新'}</button></div>
}
export function OpsError({ error, retained }: { error: string; retained: boolean }) {
  return error ? <div className="rx-error" role="alert">{error}。{retained ? '保留上次结果，自动重试中。' : '可点击刷新重试。'}</div> : null
}
export function OpsCard({ title, extra, children, className = '' }: { title: string; extra?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`ow-card ${className}`}><div className="ow-card-head"><h3>{title}</h3>{extra ? <span>{extra}</span> : null}</div>{children}</section>
}
export function OpsMetrics({ items }: { items: { title: string; value: ReactNode; unit?: string; tone?: string }[] }) {
  return <section className="ow-metrics">{items.map(i => <div key={i.title}><span>{i.title}</span><strong className={i.tone ?? ''}>{i.value}<small>{i.unit}</small></strong></div>)}</section>
}
export function CopyBlock({ title, text }: { title: string; text: string }) {
  const [status, setStatus] = useState('')
  useEffect(() => setStatus(''), [text])
  return <div className="ow-code"><header><span>{title}</span><button disabled={!text} onClick={async () => { try { const ok = await copyText(text); setStatus(ok ? '已复制' : '复制失败，请手动选择') } catch { setStatus('复制失败，请手动选择') } }}>{status === '已复制' ? '已复制' : '复制'}</button></header><pre>{text || '正在读取…'}</pre>{status && status !== '已复制' ? <span role="status">{status}</span> : null}</div>
}
