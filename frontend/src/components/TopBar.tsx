import { useState } from 'react'

import { useClock } from '../hooks/useClock'
import type { Route } from '../hooks/useHashRoute'
import { fmtAgo, fmtFull } from '../lib/format'
import { levelColor } from '../lib/levels'
import type { StreamStatus } from '../lib/stream'
import type { DeviceInfo } from '../lib/types'
import NavBar from './NavBar'
import ShareQrModal from './ShareQrModal'

interface TopBarProps {
  devices: DeviceInfo[]
  selectedId: string
  onSelect: (deviceId: string) => void
  /** 是否**至少有一台**已接入真实硬件的设备。决定"硬件直连 · 真实数据"徽标的配色：
   *  绿=确实接了真实硬件；琥珀=当前全是模拟源。原先这个颜色挂的是"配没配涂鸦"，
   *  文案改成正向陈述之后两者就对不上了（文案说真实、配色却在报警告）。 */
  hasRealDevice: boolean
  connected: boolean
  initialLoading?: boolean
  streamStatus: StreamStatus
  session: { name: string; role: 'user' | 'admin' }
  onLogout: () => void
  route: Route
  onNavigate: (r: Route) => void
  updatedAt: number
  pollError: string
  onRefresh: () => void
}

export default function TopBar({
  devices,
  selectedId,
  onSelect,
  hasRealDevice,
  connected,
  initialLoading = false,
  streamStatus,
  session,
  onLogout,
  route,
  onNavigate,
  updatedAt,
  pollError,
  onRefresh,
}: TopBarProps) {
  const now = useClock()
  const alertCount = devices.reduce((sum, d) => sum + d.open_alerts, 0)
  const [qrOpen, setQrOpen] = useState(false)

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">边坡哨兵</div>
        <div className="brand-text">
          <h1>滑坡灾害协同感知与预警系统</h1>
          <p>边坡复合监测节点 · 库水位驱动双时间尺度分级预警</p>
        </div>
      </div>

      <NavBar route={route} onNavigate={onNavigate} />

      <nav className="device-tabs" aria-label="监测点位">
        {devices.map((d) => {
          const level = d.prediction?.combined_level ?? 0
          // 数据不足时不能显示"平静"：掉线被读成一切正常是预警系统最危险的错觉
          const noData = d.prediction?.data_available === false
          const dotColor = noData ? '#94a3b8' : levelColor(level)
          return (
            <button
              key={d.device_id}
              type="button"
              className={`device-tab ${d.device_id === selectedId ? 'active' : ''}`}
              onClick={() => onSelect(d.device_id)}
            >
              <span className="dot" style={{ background: dotColor }} />
              <span className="device-tab-name">{d.name}</span>
              <span className="device-tab-level" style={{ color: noData ? '#94a3b8' : levelColor(level) }}>
                {d.prediction ? (noData ? '数据不足' : d.prediction.stage) : '无数据'}
              </span>
              {d.open_alerts > 0 ? <span className="badge-count">{d.open_alerts}</span> : null}
            </button>
          )
        })}
      </nav>

      <div className="topbar-right">
        <div className={`pill ${hasRealDevice ? 'pill-live' : 'pill-demo'}`}>
          {devices.some(d => d.presentation) ? '历史回放 · 固定点位' : '监测数据 · 分通道溯源'}
        </div>
        {/* 连通状态合成一个徽标：原来"后端已连接"与"实时推送"各占一个，
            两个说的都是"链路通不通"，合并后省下约 90px ——
            顶栏要腾地方给设备标签（5 个节点分不出两行就只能滚动）。 */}
        <div className={`pill ${initialLoading ? 'pill-demo' : !connected ? 'pill-bad'
          : streamStatus === 'open' ? 'pill-ok' : 'pill-demo'}`}>
          <span
            className="dot"
            style={{
              background: initialLoading ? '#8fb6d9' : !connected ? '#f87171'
                : streamStatus === 'open' ? '#34d399' : '#fbbf24',
            }}
          />
          {initialLoading ? '正在同步数据' : !connected ? '后端异常'
            : streamStatus === 'open' ? devices.some(d => d.presentation) ? '服务器已连接' : '已连接 · 实时推送'
              : streamStatus === 'connecting' ? '连接中' : '已连接 · 轮询模式'}
        </div>
        <div className="pill pill-total">实时未处理告警 {alertCount}</div>
        {/* 扫码查看：演示时手机上扫一下就打开，不用手输地址 */}
        <button type="button" className="ghost-btn" title="扫码在手机上打开"
                onClick={() => setQrOpen(true)}>
          二维码
        </button>
        <div className={`pill ${session.role === 'admin' ? 'pill-live' : ''}`}>
          {session.role === 'admin' ? '管理人员' : '普通用户'} · {session.name}
        </div>
        <div className="clock">
          <div className="clock-time">
            {fmtFull(now.toISOString()).slice(11)}
          </div>
          <div className="clock-ago">
            {fmtFull(now.toISOString()).slice(0, 10)} · 页面{fmtAgo(updatedAt, now.getTime())}同步
          </div>
        </div>
        <button type="button" className="ghost-btn" onClick={onRefresh} title="立即刷新">
          刷新
        </button>
        <button type="button" className="ghost-btn" onClick={onLogout} title="退出登录">
          退出
        </button>
      </div>

      {pollError ? <div className="topbar-error">接口异常：{pollError}</div> : null}
      <ShareQrModal open={qrOpen} onClose={() => setQrOpen(false)} />
    </header>
  )
}
