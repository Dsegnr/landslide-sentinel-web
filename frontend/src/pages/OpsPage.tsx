import { useEffect, useMemo, useState } from 'react'

import NavBar from '../components/NavBar'
import ReceptionDashboard from '../components/ops/ReceptionDashboard'
import DataQualityView from '../components/ops/DataQualityView'
import GuideView from '../components/ops/GuideView'
import NotifyView from '../components/ops/NotifyView'
import SystemView from '../components/ops/SystemView'
import TokenSecurityView from '../components/ops/TokenSecurityView'
import { useOpsResource } from '../hooks/useOpsResource'
import type { Route } from '../hooks/useHashRoute'
import { api } from '../lib/api'
import type { OpsDevice } from '../lib/api'
import type { Session } from '../lib/auth'

interface OpsPageProps {
  session: Session
  route: Route
  onNavigate: (r: Route) => void
  onLogout: () => void
}

// 六个子页签：一个入口（顶栏不新增导航，否则又会挤），页内分视图 ——
// 每个视图都是完整的功能界面，可以单独截图进软著说明书。
const SUB_TABS = [
  { key: 'overview', label: '接入总览与台账' },
  { key: 'link', label: '链路与数据完整性' },
  { key: 'security', label: '令牌与接入安全' },
  { key: 'notify', label: '通知与派发' },
  { key: 'system', label: '系统运行态' },
  { key: 'guide', label: '对接指南' },
] as const

type SubTab = typeof SUB_TABS[number]['key']

/** 设备与通信运维页：管设备与链路，不看预警等级。
 *
 * 为什么单独做一页：`/api/devices` 那些接口回答的是"数据是多少"，
 * 回答不了"令牌登记了没、链路断没断、这段是实时还是补传、通道有没有卡值"。
 */
export default function OpsPage({ session, route, onNavigate, onLogout }: OpsPageProps) {
  const isAdmin = session.role === 'admin'
  const [selected, setSelected] = useState('')
  const [tab, setTab] = useState<SubTab>('overview')
  const { data: devices, error: summaryErr, errorStatus: deviceStatus, loading: inventoryLoading, refresh: refreshInventory } = useOpsResource('inventory', signal => api.opsDevices(signal))
  useEffect(() => { if (deviceStatus === 401) onLogout() }, [deviceStatus, onLogout])

  const list: OpsDevice[] = useMemo(() => devices?.items ?? [], [devices])
  const current = useMemo(
    () => list.find((d) => d.device_id === selected) ?? list[0] ?? null,
    [list, selected],
  )
  useEffect(() => {
    if (!selected && list.length) setSelected(list[0].device_id)
  }, [list, selected])

  return (
    <div className="app">
      <header className="topbar topbar-slim">
        <div className="brand">
          <div className="brand-mark">边坡哨兵</div>
          <div className="brand-text">
            <h1>设备与通信 · 接入运维</h1>
            <p>设备台账 / 令牌登记 / 上报时延 / 断线与补传 / 通道健康度 / 接入审计</p>
          </div>
        </div>
        <NavBar route={route} onNavigate={onNavigate} />
        <div className="topbar-right">
          <div className={`pill ${isAdmin ? 'pill-live' : ''}`}>
            {isAdmin ? '管理人员' : '普通用户'} · {session.name}
          </div>
          <button type="button" className="ghost-btn" onClick={onLogout}>退出</button>
        </div>
      </header>

      <nav className="ops-subtabs" aria-label="设备与通信子页">
        {SUB_TABS.map((t) => (
          <button key={t.key} type="button" data-testid={`ops-tab-${t.key}`}
                  className={t.key === tab ? 'active' : ''}
                  onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>

      <main className={`board ${tab === 'overview' ? 'board-reception' : 'board-ops-workspace'}`}>
        {tab === 'overview' ? <ReceptionDashboard devices={list} current={current} onSelect={setSelected} token={session.token} inventoryError={summaryErr} inventoryLoading={inventoryLoading} onRefreshInventory={refreshInventory} /> : null}
        {tab !== 'overview' ? <div className="ow-workspace">
          {tab === 'link' ? <DataQualityView devices={list} current={current} onSelect={setSelected} /> : null}
          {tab === 'security' ? <TokenSecurityView devices={list} /> : null}
          {tab === 'notify' ? <NotifyView isAdmin={isAdmin} /> : null}
          {tab === 'system' ? <SystemView /> : null}
          {tab === 'guide' ? <GuideView devices={list} current={current} onSelect={setSelected} /> : null}
        </div> : null}
      </main>
    </div>
  )
}
