import { useState } from 'react'

import { fmtShort } from '../lib/format'
import { levelColor, levelMeta, stageName } from '../lib/levels'
import type { AlertItem } from '../lib/types'

interface AlertPanelProps {
  alerts: AlertItem[]
  deviceName: (deviceId: string) => string
  /** 该设备"当下"的融合等级（用于说明告警峰值与当前等级的差异） */
  currentLevel: (deviceId: string) => number | null
  /** 只有管理人员能确认处置；普通用户只读 */
  canAck: boolean
  onAck: (alertId: number) => void
  busyId: number | null
}

type Filter = 'open' | 'acked' | 'all'

const FILTER_LABEL: Record<Filter, string> = {
  open: '未处理',
  acked: '已确认',
  all: '全部',
}

export default function AlertPanel({
  alerts,
  deviceName,
  currentLevel,
  canAck,
  onAck,
  busyId,
}: AlertPanelProps) {
  const [filter, setFilter] = useState<Filter>('open')
  const list = alerts.filter((a) => (filter === 'all' ? true : a.status === filter))
  const openCount = alerts.filter((a) => a.status === 'open').length

  return (
    <div className="alert-panel">
      <div className="alert-tabs">
        {(Object.keys(FILTER_LABEL) as Filter[]).map((key) => (
          <button
            key={key}
            type="button"
            className={`alert-tab ${filter === key ? 'active' : ''}`}
            onClick={() => setFilter(key)}
          >
            {FILTER_LABEL[key]}
            {key === 'open' && openCount > 0 ? <span className="badge-count">{openCount}</span> : null}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <div className="empty">当前没有{FILTER_LABEL[filter]}告警</div>
      ) : (
        <ul className="alert-list">
          {list.map((a) => {
            const color = levelColor(a.level)
            const now = currentLevel(a.device_id)
            return (
              <li key={a.id} className="alert-item" style={{ borderLeftColor: color }}>
                <div className="alert-head">
                  <span className="alert-stage" style={{ background: `${color}22`, color }}>
                    {stageName(a.level, a.stage)}
                  </span>
                  <span className="alert-device">{deviceName(a.device_id)}</span>
                  <span className={`alert-status status-${a.status}`}>
                    {a.status === 'open' ? '未处理' : a.status === 'acked' ? '已确认' : '已解除'}
                  </span>
                </div>
                <div className="alert-time">{fmtShort(a.ts)}</div>
                <div className="alert-reason">{a.reason || '—'}</div>
                {now !== null && now < a.level ? (
                  <div className="alert-fallen">
                    本记录是本轮事件的峰值，当前已回落至 {levelMeta(now).name}
                  </div>
                ) : null}
                {a.status === 'open' && canAck ? (
                  <button
                    type="button"
                    className="ack-btn"
                    disabled={busyId === a.id}
                    onClick={() => onAck(a.id)}
                  >
                    {busyId === a.id ? '提交中…' : '确认处置'}
                  </button>
                ) : a.status === 'open' ? (
                  <div className="alert-acked">只读账号：确认处置需管理人员密钥入口</div>
                ) : (
                  <div className="alert-acked">
                    {a.acked_by ? `由 ${a.acked_by} 确认` : '已确认'}
                    {a.acked_at ? `（${fmtShort(a.acked_at)}）` : ''}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
