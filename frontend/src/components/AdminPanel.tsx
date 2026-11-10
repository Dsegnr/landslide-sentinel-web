import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/api'
import { fmtAgo, fmtNum, fmtShort } from '../lib/format'

// 管理人员后台：看运维概览与操作审计（只对 admin token 开放）
export default function AdminPanel() {
  const { data: overview, error, updatedAt } = usePolling(() => api.adminOverview(), 20000)
  const { data: audit } = usePolling(() => api.audit(20), 30000)

  if (error) return <div className="empty">管理接口异常：{error}</div>
  if (!overview) return <div className="empty">加载中…</div>

  return (
    <div className="admin-panel">
      <div className="admin-row">
        <span className="admin-k">运行时长</span>
        <span>
          {Math.floor(overview.uptime_seconds / 3600)} 小时{' '}
          {Math.floor((overview.uptime_seconds % 3600) / 60)} 分
        </span>
      </div>
      <div className="admin-row">
        <span className="admin-k">告警</span>
        <span>
          未处理 <b className="c-bad">{overview.alerts.open}</b> · 已确认 {overview.alerts.acked} ·
          已解除 {overview.alerts.cleared}
        </span>
      </div>
      <div className="admin-row">
        <span className="admin-k">数据量</span>
        <span>
          读数 {overview.counts.readings} · 推理 {overview.counts.predictions} · 审计{' '}
          {overview.counts.audit_logs}
          {overview.database !== null ? ` · 库 ${fmtNum(overview.database, 2)} MB` : ''}
        </span>
      </div>
      <div className="admin-row">
        <span className="admin-k">实时推送</span>
        <span>{overview.ws_clients} 个连接 · 数据{fmtAgo(updatedAt)}更新</span>
      </div>
      <div className="admin-row">
        <span className="admin-k">设备</span>
        <span>
          {overview.devices
            .map((d) => `${d.name}(${d.mode === 'full' ? '融合' : '哨兵'})`)
            .join('、')}
        </span>
      </div>
      {overview.reservoir.length > 0 ? (
        <div className="admin-row">
          <span className="admin-k">库水位</span>
          <span>
            {overview.reservoir
              .map((r) => `${r.station_id} ${fmtNum(r.latest_m, 2)} m（${r.n} 天）`)
              .join('、')}
          </span>
        </div>
      ) : null}

      <div className="admin-sub">最近操作审计</div>
      <ul className="audit-list">
        {(audit?.items ?? []).map((a, i) => (
          <li key={`${a.ts}-${i}`}>
            <span className="audit-time">{fmtShort(a.ts)}</span>
            <span className="audit-action">{a.action}</span>
            <span className="audit-detail">
              {a.target} {a.detail} · {a.by}
            </span>
          </li>
        ))}
        {(audit?.items ?? []).length === 0 ? <li className="empty">暂无记录</li> : null}
      </ul>
    </div>
  )
}
