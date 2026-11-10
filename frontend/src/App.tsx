import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'

import AdminPanel from './components/AdminPanel'
import AlertPanel from './components/AlertPanel'
import ChinaMap from './components/ChinaMap'
import DataCards from './components/DataCards'
import DatasetSelector from './components/DatasetSelector'
import LevelTimeline from './components/LevelTimeline'
import { appendStreamPoint } from './lib/series'
import LoginView from './components/LoginView'
import Modal from './components/Modal'
import Panel from './components/Panel'
import MobileTabs from './components/MobileTabs'
import PointForm from './components/PointForm'
import PredictionPanel from './components/PredictionPanel'
import RetainedTerrain from './components/RetainedTerrain'
import { scheduleOpsPreparation } from './lib/opsPreparation'
import { scheduleMapPreparation } from './lib/mapTilePool'
import TopBar from './components/TopBar'
import TrendChart from './components/TrendChart'
import WavePanel from './components/WavePanel'
import { useAuth } from './hooks/useAuth'
import { useHashRoute, type Route } from './hooks/useHashRoute'
import { useLiveStream } from './hooks/useLiveStream'
import { usePolling } from './hooks/usePolling'
import { useWeatherMarks } from './hooks/useWeatherMarks'
import { presentationApi as api } from './lib/presentationApi'
import { useSelectedDevice } from './hooks/useSelectedDevice'
import type { Session } from './lib/auth'
import { fmtAgo, fmtNum, fmtShort } from './lib/format'
import { levelColor, levelMeta, stageName } from './lib/levels'
import { SITES } from './lib/sites'
import type { MapNode, MapOverview, SeriesPoint, SeriesResponse } from './lib/types'
import FieldPage from './pages/FieldPage'
import OpsPage from './pages/OpsPage'

// 三维页单独分包：首页就绪后后台准备，导航时复用同一个场景。
// 专业底图同样单独分包：maplibre-gl 有几百 KB，不进首屏包
const MapPro = lazy(() => import('./components/MapPro'))

const RANGES = [
  { label: '24 小时', days: 1 },
  { label: '7 天', days: 7 },
  { label: '30 天', days: 30 },
  { label: '180 天', days: 180 },
]

// 有实时推送时把轮询降频（推送负责"有变化就刷新"）；推送断了就加快轮询兜底。
const POLL_OPEN_MS = 30000
const POLL_FALLBACK_MS = 8000

const EMPTY_SUMMARY = {
  max_level: 0, max_stage: '平静', weighted_score: 0, watch_count: 0,
  manual_count: 0, device_count: 0, level_counts: {},
}

export default function App() {
  const { session, signIn, signInAdmin, signOut } = useAuth()
  const [route, navigate] = useHashRoute()
  const [homeReady, setHomeReady] = useState(false)
  const handleHomeReady = useCallback(() => setHomeReady(true), [])
  useEffect(() => { setHomeReady(false) }, [session?.token])
  useEffect(() => {
    if (!session || !homeReady || route !== 'dashboard') return
    return scheduleOpsPreparation()
  }, [session, homeReady, route])
  useEffect(() => {
    if (!session || !homeReady || route !== 'dashboard') return
    return scheduleMapPreparation()
  }, [session, homeReady, route])

  // 登录页与仪表盘是两个组件：避免"登录前后 hook 数量不同"这种 Hooks 违规
  if (!session) {
    return <LoginView onUser={signIn} onAdmin={signInAdmin} />
  }
  return <>
    {route === 'field' ? <FieldPage session={session} route={route} onNavigate={navigate} onLogout={signOut} />
      : route === 'ops' ? <OpsPage session={session} route={route} onNavigate={navigate} onLogout={signOut} />
      : route === 'dashboard' ? <Dashboard session={session} onLogout={signOut} route={route} onNavigate={navigate} onReady={handleHomeReady} /> : null}
    <RetainedTerrain key={session.token} session={session} active={route === 'terrain'}
      prepareEnabled={homeReady || route !== 'dashboard'} onNavigate={navigate} onLogout={signOut} />
  </>
}

function Dashboard({ session, onLogout, route, onNavigate, onReady }: {
  session: Session
  onLogout: () => void
  route: Route
  onNavigate: (r: Route) => void
  onReady: () => void
}) {
  const [selectedId, setSelectedId] = useSelectedDevice()
  const [rangeDays, setRangeDays] = useState(30)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  const [pickMode, setPickMode] = useState(false)
  // 地图模式：专业底图（矢量底图 + 雷达降水） / 离线图（零依赖，断网可用）
  const [mapMode, setMapMode] = useState<'pro' | 'offline'>('pro')
  // 手机端栏目（只在 <768px 生效）：一次看一栏，避免硬缩到看不清
  const [pane, setPane] = useState<'map' | 'chart' | 'alert'>('map')
  const [pickedLocation, setPickedLocation] = useState<[number, number] | null>(null)
  const [selectedKey, setSelectedKey] = useState('')
  const isAdmin = session.role === 'admin'

  const { status: streamStatus, event: streamEvent } = useLiveStream(true, undefined, session.token)
  const pollMs = streamStatus === 'open' ? POLL_OPEN_MS : POLL_FALLBACK_MS

  const {
    data: deviceData,
    error: deviceError,
    errorStatus: deviceStatus,
    updatedAt,
    refresh: refreshDevices,
  } = usePolling(() => api.devices(), pollMs)

  const devices = useMemo(() => deviceData?.items ?? [], [deviceData])
  const presentationReady = devices.length > 0
  useEffect(() => {
    if (presentationReady) onReady()
  }, [presentationReady, onReady])
  const current = devices.find((d) => d.device_id === selectedId) ?? devices[0] ?? null
  const currentId = current?.device_id ?? ''

  const {
    data: seriesData,
    error: seriesError,
    errorStatus: seriesStatus,
  } = usePolling<SeriesResponse | null>(
    () => (currentId ? api.series(currentId, rangeDays) : Promise.resolve(null)),
    pollMs,
    [currentId, rangeDays],
  )
  const { data: alertData, errorStatus: alertStatus, refresh: refreshAlerts } =
    usePolling(() => api.alerts(50), pollMs)
  const { data: mapData, refresh: refreshMap } = usePolling<MapOverview | null>(
    () => api.mapOverview(), pollMs)

  // token 失效（过期/被换密钥）时自动退回登录页，而不是满屏报错
  const expired = [deviceStatus, seriesStatus, alertStatus].includes(401)
  useEffect(() => {
    if (expired) onLogout()
  }, [expired, onLogout])

  const [points, setPoints] = useState<SeriesPoint[]>([])
  const seriesReady = seriesData?.device_id === currentId && seriesData?.days === rangeDays
  useEffect(() => {
    setPoints(seriesReady ? seriesData?.items ?? [] : [])
  }, [seriesData, seriesReady])

  useEffect(() => {
    if (!streamEvent) return
    if (streamEvent.type === 'reading') {
      if (streamEvent.device_id !== currentId || current?.presentation) return
      const raw = streamEvent.reading
      const point: SeriesPoint = {
        ts: streamEvent.ts,
        R: raw.R ?? null,
        P: raw.P ?? null,
        T: raw.T ?? null,
        H: raw.H ?? null,
        RN: raw.RN ?? null,
        RNM: raw.RNM ?? null,
        S: raw.S ?? null,
        D: raw.D ?? null,
        level: null,
      }
      if (seriesReady) setPoints(prev => appendStreamPoint(prev, point, rangeDays))
      refreshDevices()
      return
    }
    if (streamEvent.type === 'prediction' || streamEvent.type === 'alert_ack') {
      refreshDevices()
      refreshAlerts()
    }
  }, [streamEvent, currentId, current?.presentation, seriesReady, rangeDays, refreshDevices, refreshAlerts])

  const predictions = seriesReady ? seriesData?.predictions ?? [] : []
  const alerts = alertData?.items ?? []

  const handleAck = useCallback(
    async (alertId: number) => {
      setBusyId(alertId)
      setNotice('')
      try {
        await api.ackAlert(alertId)                  // 处置人由后端从 token 里取
        setNotice(`告警 #${alertId} 已确认处置`)
        refreshAlerts()
      } catch (err) {
        setNotice(`确认失败：${(err as Error).message}`)
      } finally {
        setBusyId(null)
      }
    },
    [refreshAlerts],
  )

  const refreshAll = useCallback(() => {
    refreshDevices()
    refreshAlerts()
  }, [refreshDevices, refreshAlerts])

  const deviceName = useCallback(
    (id: string) => devices.find((d) => d.device_id === id)?.name ?? id,
    [devices],
  )

  const manualPoints = useMemo(
    () => (mapData?.nodes ?? []).filter((n) => n.source === 'manual'),
    [mapData],
  )

  // 天气图层：设备点位 + 两个数据集站点（真实动态天气，10 分钟刷新）
  const weatherPoints = useMemo(() => [
    ...devices
      .filter((d) => d.lon !== null && d.lat !== null)
      .map((d) => ({
        key: `device:${d.device_id}`, name: d.name,
        lon: d.lon as number, lat: d.lat as number,
      })),
    ...SITES.map((s) => ({
      key: `site:${s.id}`, name: s.name, lon: s.lon, lat: s.lat,
    })),
  ], [devices])
  const weatherMarks = useWeatherMarks(weatherPoints)
  const { data: precipGrid } = usePolling(() => api.weatherGrid(), 10 * 60 * 1000)

  const handleMapSelect = useCallback((key: string) => {
    setSelectedKey(key)
    if (key.startsWith('device:')) setSelectedId(key.slice('device:'.length))
  }, [])

  // 地图选点（新增警告点位）：专业底图与离线图共用同一个回调，口径一致（WGS-84）
  const handlePickLocation = useCallback((lonLat: [number, number]) => {
    setPickedLocation(lonLat)
    setPickMode(false)
  }, [])

  // 大屏地图不只画"我们的点位"：数据集站点（白家包/马家沟/树坪/白水河…）也要落在地图上——
  // 它们用菱形区分（不是危险点，而是"数据从哪来"），图例里已单列。
  const mapNodes = useMemo(() => [
    ...(mapData?.nodes ?? []).map((node) => {
      const device = devices.find((d) => d.device_id === node.device_id)
      return node.source === 'device' ? {
        ...node, data_available: !!device?.prediction && device.prediction.data_available !== false,
      } : node
    }),
    ...SITES.map((s) => ({
      id: `site:${s.id}`,
      name: s.name,
      lon: s.lon,
      lat: s.lat,
      level: 0,
      stage: '',
      weight: 1,
      watch: false,
      note: s.note,
      source: 'site' as const,
      active: true,
      status: s.status,
      tone: s.tone,
      location: s.location,
    })),
  ], [mapData, devices])

  // 底图降级回调必须是**稳定引用**：MapPro 的底图 effect 依赖 [basemap, onOffline]，
  // 这里若写内联箭头函数，App 每次重渲染（每 8/30 s 轮询、每次推送、每次点按钮）
  // 都会让 MapPro 把整层瓦片 remove + 重建——实测空闲 45 s 就重建 22 次瓦片节点、
  // 重复请求同一批瓦片 26 次。它既是"地图卡"的主因，也让瓦片成功计数反复归零，
  // 导致放大瞬间被误判成"底图不可用"而切回离线图。
  const handleMapOffline = useCallback((reason: string) => {
    setMapMode('offline')
    setNotice(`底图不可用，已切回离线地图：${reason}`)
  }, [])

  const patchPoint = useCallback(async (id: number, body: Parameters<typeof api.updatePoint>[1]) => {
    try {
      await api.updatePoint(id, body)
      refreshMap()
      setNotice('点位已更新')
    } catch (err) {
      setNotice(`更新失败：${(err as Error).message}`)
    }
  }, [refreshMap])

  const removePoint = useCallback(async (node: MapNode) => {
    if (!window.confirm(`确认移除警告点位「${node.name}」？（软删除，历史可追溯）`)) return
    try {
      await api.deletePoint(Number(node.id))
      refreshMap()
      setNotice(`已移除点位：${node.name}`)
    } catch (err) {
      setNotice(`移除失败：${(err as Error).message}`)
    }
  }, [refreshMap])

  return (
    <div className="app">
      <TopBar
        devices={devices}
        selectedId={currentId}
        onSelect={(id) => {
          setSelectedId(id)
          setNotice('')
        }}
        hasRealDevice={deviceData ? deviceData.items.some((d) => !d.is_demo) : false}
        connected={deviceError === '' && deviceData !== null}
        initialLoading={deviceData === null && deviceError === ''}
        streamStatus={streamStatus}
        session={{ name: session.name, role: session.role }}
        onLogout={onLogout}
        route={route}
        onNavigate={onNavigate}
        updatedAt={updatedAt}
        pollError={deviceError || seriesError}
        onRefresh={refreshAll}
      />

      <MobileTabs
        tabs={[
          { key: 'map', label: '地图 / 点位' },
          { key: 'chart', label: '曲线 / 等级' },
          { key: 'alert', label: '预警 / 台账' },
        ]}
        value={pane}
        onChange={(k) => setPane(k as 'map' | 'chart' | 'alert')}
      />

      <main className="board">
        <div className={`col col-left ${pane === 'map' ? 'pane-on' : ''}`}>
          <Panel
            title="点位态势（全国）"
            className="grow"
            bodyClassName="tight"
            extra={
              <>
                <button
                  type="button"
                  className={`range-btn ${mapMode === 'pro' ? 'active' : ''}`}
                  onClick={() => setMapMode(mapMode === 'pro' ? 'offline' : 'pro')}
                  title="专业底图：矢量路网/水系底图 + 真实雷达降水（需要联网）"
                >
                  {mapMode === 'pro' ? '离线图' : '专业底图'}
                </button>
                {isAdmin ? (
                  <button
                    type="button"
                    className={`range-btn ${pickMode ? 'active' : ''}`}
                    onClick={() => { setPickMode((v) => !v); setNotice(pickMode ? '' : '点击地图空白处新增警告点位') }}
                  >
                    {pickMode ? '取消新增' : '新增警告点位'}
                  </button>
                ) : null}
              </>
            }
          >
            {mapMode === 'pro' ? (
              <Suspense fallback={<div className="empty">正在加载专业底图…</div>}>
                <MapPro
                  nodes={mapNodes}
                  selectedKey={selectedKey}
                  onSelect={handleMapSelect}
                  weather={weatherMarks}
                  onOffline={handleMapOffline}
                  pickMode={pickMode}
                  onPickLocation={handlePickLocation}
                />
              </Suspense>
            ) : (
              <ChinaMap
                nodes={mapNodes}
                summary={mapData?.summary ?? EMPTY_SUMMARY}
                selectedKey={selectedKey}
                onSelect={handleMapSelect}
                weather={weatherMarks}
                precip={precipGrid?.points ?? []}
                pickMode={pickMode}
                onPickLocation={handlePickLocation}
              />
            )}
          </Panel>
          <Panel title="点位清单" bodyClassName="tight">
            <label className="selection-picker">监测点
              <select aria-label="大屏监测点" value={currentId} disabled={!devices.length} onChange={e => { setSelectedId(e.target.value); setSelectedKey(`device:${e.target.value}`) }}>
                {!devices.length ? <option value="">正在读取点位…</option> : null}
                {devices.map(d => <option key={d.device_id} value={d.device_id}>{d.name} · {!d.prediction || d.prediction.data_available === false ? '数据不足' : stageName(d.prediction.combined_level, d.prediction.stage)}</option>)}
              </select>
            </label>
            {current ? <div className="selection-summary">
              <strong style={{ color: !current.prediction || current.prediction.data_available === false ? '#94a3b8' : levelColor(current.prediction.combined_level) }}>{!current.prediction || current.prediction.data_available === false ? '数据不足' : stageName(current.prediction.combined_level, current.prediction.stage)}</strong>
              <span>位移 {fmtNum(current.reading?.D, 2)} mm · {current.latest_ts ? current.presentation ? fmtShort(current.latest_ts) : fmtAgo(new Date(current.latest_ts).getTime()) : '—'}</span>
              <small>未处理告警 {current.open_alerts} · 已确认 {current.acked_alerts}</small>
            </div> : null}
            <div className="admin-sub">人工警告点位（权重 / 关注）</div>
            {manualPoints.length === 0 ? (
              <div className="empty">
                {isAdmin ? '还没有人工点位，点上方"新增警告点位"在地图上选点' : '暂无人工点位'}
              </div>
            ) : (
              <><label className="selection-picker">人工警告点
                <select aria-label="选择人工警告点" value={manualPoints.some(p => String(p.id) === selectedKey) ? selectedKey : ''} onChange={e => { if (e.target.value) setSelectedKey(e.target.value) }}>
                  <option value="">选择点位定位…</option>
                  {manualPoints.map(p => <option key={String(p.id)} value={String(p.id)}>{p.watch ? '★ ' : ''}{p.name} · {levelMeta(p.level).name}</option>)}
                </select>
              </label><ul className="point-list">
                {manualPoints.filter(p => String(p.id) === selectedKey).map((p) => (
                  <li
                    key={String(p.id)}
                    className={selectedKey === String(p.id) ? 'active' : ''}
                    onClick={() => setSelectedKey(String(p.id))}
                  >
                    <span className="point-name" style={{ color: levelColor(p.level) }}>
                      {p.watch ? '★ ' : ''}{p.name}
                    </span>
                    <span className="point-stage">{levelMeta(p.level).name}</span>
                    <span className="point-weight">权重 {p.weight.toFixed(1)}</span>
                    {isAdmin ? (
                      <span className="point-actions">
                        <select
                          value={p.level}
                          onChange={(e) => patchPoint(Number(p.id), { level: Number(e.target.value) })}
                          aria-label={`调整 ${p.name} 等级`}
                        >
                          {levelMeta && [0, 1, 2, 3, 4].map((i) => (
                            <option key={i} value={i}>{levelMeta(i).name}</option>
                          ))}
                        </select>
                        <input
                          type="number" min={0.2} max={3} step={0.1} value={p.weight}
                          aria-label={`调整 ${p.name} 权重`}
                          onChange={(e) => patchPoint(Number(p.id), { weight: Number(e.target.value) })}
                        />
                        <label className="watch-toggle">
                          <input
                            type="checkbox" checked={p.watch}
                            onChange={(e) => patchPoint(Number(p.id), { watch: e.target.checked })}
                          />
                          关注
                        </label>
                        <button type="button" className="link-btn" onClick={() => removePoint(p)}>
                          移除
                        </button>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul></>
            )}
            <div className="notice">
              {notice || '监测与演示数据按来源区分；接收时间不代表所有通道均为新采样。'}
            </div>
          </Panel>

          {/* 数据集站点：全国尺度下它们挤在库区一小块，光靠地图看不见——这里列出来点一下就定位 */}
          <Panel title="数据集站点" bodyClassName="tight">
            <DatasetSelector value={selectedKey.startsWith('site:') ? selectedKey.slice(5) : ''} onSelect={id => setSelectedKey(`site:${id}`)} />
            <div className="selection-caption">资料站点用于数据溯源，不表示实时危险等级。</div>
          </Panel>
        </div>

        <div className={`col col-center ${pane === 'chart' ? 'pane-on' : ''}`}>
          <DataCards
            archive={!!current?.presentation}
            mixedArchive={current?.presentation?.kind === 'archive'}
            displacementUnavailable={!current?.prediction || current.prediction.data_available === false}
            reading={current?.reading ?? null}
            points={points}
            level={current?.level_m ?? null}
          />
          <Panel
            title={current?.presentation ? '历史回放 · 位移 / 降雨过程线' : '地表位移 / 降雨 过程线'}
            className="grow"
            bodyClassName="tight"
            extra={
              <div className="range-switch">
                {RANGES.map((r) => (
                  <button
                    key={r.days}
                    type="button"
                    className={`range-btn ${r.days === rangeDays ? 'active' : ''}`}
                    onClick={() => setRangeDays(r.days)}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            }
          >
            {seriesReady ? <TrendChart points={points} rangeDays={rangeDays} /> : <div className="empty">{seriesError ? '曲线加载失败，请刷新重试' : '正在加载曲线…'}</div>}
          </Panel>
          <Panel title="预警等级演进（0–4 级）" className="grow" bodyClassName="tight">
            {seriesReady ? <LevelTimeline predictions={predictions} /> : <div className="empty">{seriesError ? '等级历史加载失败，请刷新重试' : '正在加载等级历史…'}</div>}
          </Panel>
        </div>

        <div className={`col col-right ${pane === 'alert' ? 'pane-on' : ''}`}>
          <Panel title={current?.presentation ? '回放时刻预警等级' : '当前预警等级'} bodyClassName="tight">
            <PredictionPanel device={current} />
          </Panel>
          <Panel title="涌浪风险推演" bodyClassName="tight">
            <WavePanel />
          </Panel>
          <Panel
            title="实时告警台账（全部点位）"
            className="grow"
            bodyClassName="tight"
            extra={notice ? <span className="notice">{notice}</span> : null}
          >
            <AlertPanel
              alerts={alerts}
              deviceName={deviceName}
              currentLevel={(id) =>
                devices.find((d) => d.device_id === id)?.prediction?.combined_level ?? null
              }
              canAck={isAdmin}
              onAck={handleAck}
              busyId={busyId}
            />
          </Panel>
          {isAdmin ? (
            <Panel title="管理人员后台" className="grow" bodyClassName="tight">
              <AdminPanel />
            </Panel>
          ) : null}
        </div>
      </main>

      {pickedLocation ? (
        <Modal title="新增警告点位" onClose={() => setPickedLocation(null)}>
          <PointForm
            lonLat={pickedLocation}
            onCancel={() => setPickedLocation(null)}
            onDone={(msg) => { setPickedLocation(null); setNotice(msg); refreshMap() }}
          />
        </Modal>
      ) : null}
    </div>
  )
}
