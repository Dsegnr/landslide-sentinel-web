import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'

import ChinaMap from '../components/ChinaMap'
import Modal from '../components/Modal'
import MobileTabs from '../components/MobileTabs'
import NavBar from '../components/NavBar'
import Panel from '../components/Panel'
import RecordForm from '../components/RecordForm'
import SiteSeriesPanel from '../components/SiteSeriesPanel'
import DatasetSelector from '../components/DatasetSelector'
import { usePolling } from '../hooks/usePolling'
import { useWeatherMarks } from '../hooks/useWeatherMarks'
import type { Route } from '../hooks/useHashRoute'
import { presentationApi as api } from '../lib/presentationApi'
import { useSelectedDevice } from '../hooks/useSelectedDevice'
import type { Session } from '../lib/auth'
import { fmtAgo, fmtShort } from '../lib/format'
import { levelColor, levelMeta, MODE_NOTE, stageName } from '../lib/levels'
import { SITES, findSite, type SiteInfo } from '../lib/sites'
import fieldThumbnails from '../lib/fieldThumbnails.json'
import type { FieldRecord, MapNode } from '../lib/types'

// 专业底图单独分包：leaflet 有 150+ KB，只在需要时才下载（与大屏共用同一个 chunk）
const MapPro = lazy(() => import('../components/MapPro'))
const thumbnailUrls: Record<string, string> = fieldThumbnails
const thumbnailFor = (src: string) => thumbnailUrls[src] ?? src

interface FieldPageProps {
  session: Session
  route: Route
  onNavigate: (r: Route) => void
  onLogout: () => void
}

/** 现场监测页：**以地图为中心**——地图上标出四个数据集站点与我们的监测节点，
 *  点任意站点切换右侧的"现场影像"（视频/照片）与站点详情。
 *  数据集不再是干巴巴一张表，而是"点得进去、看得见画面"的地点。
 */
export default function FieldPage({ session, route, onNavigate, onLogout }: FieldPageProps) {
  const isAdmin = session.role === 'admin'
  const { data: deviceData, loading: devicesLoading } = usePolling(() => api.devices(), 30000)
  const { data: recordData, refresh: refreshRecords } = usePolling(() => api.records(50), 60000)
  const { data: alertData } = usePolling(() => api.alerts(30), 30000)

  const [selectedSiteId, setSelectedSiteId] = useState(SITES[0].id)
  const [selectedDeviceId, setSelectedDeviceId] = useSelectedDevice()
  const [showForm, setShowForm] = useState(false)
  const [photo, setPhoto] = useState<FieldRecord | null>(null)
  const [photoError, setPhotoError] = useState(false)
  const [gallery, setGallery] = useState(0)
  // 手机端栏目（<768px 生效）：站点列表 / 站点地图 / 现场影像
  const [pane, setPane] = useState<'list' | 'map' | 'media'>('map')
  const [notice, setNotice] = useState('')
  // 地图模式：专业底图（高德矢量/影像 + RainViewer 雷达）/ 离线图（零依赖，断网可用）。
  // 与大屏同一套组件和回退策略；mapKey 单独存，初值留空 = 先看全国，
  // 用户点了站点/节点再飞过去（避免一进页面就贴着默认站点）。
  const [mapMode, setMapMode] = useState<'pro' | 'offline'>('pro')
  const [mapKey, setMapKey] = useState('')

  // 回退回调必须是**稳定引用**：MapPro 的底图 effect 依赖 [basemap, onOffline]，
  // 传内联箭头函数会让它每次重渲染都重建整层瓦片（P20 踩过的坑）。
  const handleMapOffline = useCallback((reason: string) => {
    setMapMode('offline')
    setNotice(`底图不可用，已切回离线地图：${reason}`)
  }, [])

  const handleMapSelect = useCallback((key: string) => {
    setMapKey(key)
    if (key.startsWith('site:')) setSelectedSiteId(key.slice('site:'.length))
    else if (key.startsWith('device:')) setSelectedDeviceId(key.slice('device:'.length))
  }, [])

  // 点左侧列表也要让地图跟过去，列表与地图的选中态保持一致
  const pickSite = useCallback((id: string) => {
    setSelectedSiteId(id)
    setMapKey(`site:${id}`)
  }, [])

  const devices = useMemo(() => deviceData?.items ?? [], [deviceData])
  const records = recordData?.items ?? []
  const alerts = alertData?.items ?? []
  const site = findSite(selectedSiteId) ?? SITES[0]
  const current = devices.find((d) => d.device_id === selectedDeviceId) ?? devices[0] ?? null

  useEffect(() => {
    setGallery(0)                     // 切站点时把相册复位
  }, [selectedSiteId])

  const siteNodes: MapNode[] = useMemo(() => SITES.map((s) => ({
    id: `site:${s.id}`, name: s.name, lon: s.lon, lat: s.lat,
    level: 0, stage: '', weight: 1, watch: false, note: s.note,
    source: 'site', active: true, status: s.status, tone: s.tone, location: s.location,
  })), [])

  // 天气图层：站点 + 设备点位（真实动态天气）
  const weatherPoints = useMemo(() => [
    ...SITES.map((s) => ({ key: `site:${s.id}`, name: s.name, lon: s.lon, lat: s.lat })),
    ...devices
      .filter((d) => d.lon !== null && d.lat !== null)
      .map((d) => ({
        key: `device:${d.device_id}`, name: d.name,
        lon: d.lon as number, lat: d.lat as number,
      })),
  ], [devices])
  const weatherMarks = useWeatherMarks(weatherPoints)

  const deviceNodes: MapNode[] = useMemo(() => devices
    .filter((d) => d.lon !== null && d.lat !== null)
    .map((d) => ({
      id: `device:${d.device_id}`, device_id: d.device_id, name: d.name,
      lon: d.lon as number, lat: d.lat as number,
      level: d.prediction?.combined_level ?? 0, stage: d.prediction?.stage ?? '',
      data_available: !!d.prediction && d.prediction.data_available !== false,
      weight: 1, watch: false, note: '', source: 'device', active: true, mode: d.mode,
    })), [devices])

  const level = current?.prediction?.combined_level ?? 0
  const noData = !current?.prediction || current.prediction.data_available === false
  const accent = noData ? '#94a3b8' : levelColor(level)

  return (
    <div className="app">
      <header className="topbar topbar-slim">
        <div className="brand">
          <div className="brand-mark">边坡哨兵</div>
          <div className="brand-text">
            <h1>现场监测 · 站点地图与现场影像</h1>
            <p>点地图上的站点切换现场影像 / 滑坡记录 / 数据集与点位</p>
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

      <MobileTabs
        tabs={[
          { key: 'map', label: '站点地图' },
          { key: 'media', label: '现场影像' },
          { key: 'list', label: '站点 / 记录' },
        ]}
        value={pane}
        onChange={(k) => setPane(k as 'list' | 'map' | 'media')}
      />

      <main className="board board-field">
        <div className={`col col-field-left ${pane === 'list' ? 'pane-on' : ''}`}>
          <Panel title="数据集站点" bodyClassName="tight">
            <DatasetSelector value={site.id} onSelect={pickSite} label="现场数据集站点" />
            <details className="selection-note"><summary>资料说明</summary><div className="notice">
              这些是<b>外部公开数据集</b>（各自覆盖不同的研究时段），用于离线对照与跨期分析；
              它们不是我们的实时监测点，<b>不产生实时预警等级</b> —— 右侧「预警状态」显示的是
              现场监测节点，切换站点不会改变它。网点为数据集实际位置；标记为"示意位置"的
              表示公开资料未给权威坐标。
            </div></details>
          </Panel>

          <Panel
            title="滑坡探测记录"
            className="grow"
            bodyClassName="tight"
            extra={isAdmin ? (
              <button type="button" className="ack-btn" onClick={() => setShowForm(true)}>
                新增记录
              </button>
            ) : <span className="notice">只读</span>}
          >
            {notice ? <div className="notice">{notice}</div> : null}
            {records.length === 0 ? (
              <div className="empty">还没有现场记录{isAdmin ? '，点右上角"新增记录"添加' : ''}</div>
            ) : (
              <ul className="record-list compact">
                {records.map((r) => (
                  <li key={r.id}>
                    <span className="record-point">{r.point_name}</span>
                    <span className="record-level" style={{ color: levelColor(levelOf(r.level)) }}>
                      {r.level}
                    </span>
                    <span className="record-time">{fmtShort(r.observed_at)}</span>
                    {r.photo_url ? (
                      <button type="button" className="link-btn" onClick={() => { setPhotoError(false); setPhoto(r) }}>
                        查看图片
                      </button>
                    ) : <span className="record-nophoto">无照片</span>}
                    {r.note ? <span className="record-note">{r.note}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="巡检设备状态（模拟）" bodyClassName="tight">
            <ul className="drone-list">
              <li><span>电量</span><b>85%</b></li>
              <li><span>飞行高度</span><b>120 m</b></li>
              <li><span>设备温度</span><b>45 ℃</b></li>
            </ul>
          </Panel>
        </div>

        <div className={`col col-field-mid ${pane === 'map' ? 'pane-on' : ''}`}>
          <Panel
            title="站点地图（点选查看该地点现场影像）"
            className="grow"
            bodyClassName="tight"
            extra={
              <button
                type="button"
                className={`range-btn ${mapMode === 'pro' ? 'active' : ''}`}
                onClick={() => setMapMode(mapMode === 'pro' ? 'offline' : 'pro')}
                title="专业底图：矢量路网/水系底图 + 真实雷达降水（需要联网）"
              >
                {mapMode === 'pro' ? '离线图' : '专业底图'}
              </button>
            }
          >
            {mapMode === 'pro' ? (
              <Suspense fallback={<div className="empty">正在加载专业底图…</div>}>
                <MapPro
                  nodes={[...siteNodes, ...deviceNodes]}
                  selectedKey={mapKey}
                  onSelect={handleMapSelect}
                  weather={weatherMarks}
                  onOffline={handleMapOffline}
                />
              </Suspense>
            ) : (
              <ChinaMap
                nodes={[...siteNodes, ...deviceNodes]}
                variant="sites"
                weather={weatherMarks}
                summary={{
                  max_level: level, max_stage: levelMeta(level).name, weighted_score: level,
                  watch_count: 0, manual_count: deviceNodes.length, device_count: deviceNodes.length,
                  level_counts: {},
                }}
                selectedKey={mapKey}
                onSelect={handleMapSelect}
              />
            )}
          </Panel>

          <Panel title={`站点详情 · ${site.short}`} bodyClassName="tight">
            <SiteDetail site={site} />
          </Panel>

          {/* 数据集观测序列：只有导出了序列的站点（如树坪、白家包）才会渲染 */}
          <Panel title={`数据集观测序列 · ${site.short}`} bodyClassName="tight">
            <SiteSeriesPanel siteId={site.id} />
          </Panel>
        </div>

        <div className={`col col-field-right ${pane === 'media' ? 'pane-on' : ''}`}>
          <Panel
            title="现场影像"
            bodyClassName="tight"
            extra={
              <select
                className="site-picker"
                value={site.id}
                onChange={(e) => setSelectedSiteId(e.target.value)}
                aria-label="选择站点"
              >
                {SITES.map((s) => <option key={s.id} value={s.id}>{s.short}</option>)}
              </select>
            }
          >
            <SiteMedia site={site} gallery={gallery} onPick={setGallery} />
          </Panel>

          <Panel title="预警状态（现场监测节点）" bodyClassName="tight">
            <div className="level-block" style={{ borderColor: accent }}>
              <div className="level-ring"
                   style={{ boxShadow: `0 0 22px ${accent}55`, borderColor: accent }}>
                <span className="level-num" style={{ color: accent }}>{devicesLoading ? '…' : noData ? '—' : level}</span>
                <span className="level-unit">{noData ? '' : '级'}</span>
              </div>
              <div className="level-text">
                <div className="level-stage" style={{ color: accent }}>
                  {devicesLoading ? '正在同步预警' : noData ? '数据不足' : stageName(level, current?.prediction?.stage)}
                </div>
                <div className="level-advice">{devicesLoading ? '正在读取监测点位数据' : noData ? '检查位移通道与数据更新情况' : levelMeta(level).advice}</div>
              </div>
            </div>
            <div className="field-meta">
              <div>点位：{current?.name ?? '—'}</div>
              <div>运行模式：{current?.mode === 'full' ? '双时间尺度融合' : current?.presentation ? '哨兵层' : '哨兵层（实时分级）'}</div>
              <div>{current?.presentation ? '回放读数' : '最近读数'}：{current?.latest_ts ? current.presentation ? fmtShort(current.latest_ts) : fmtAgo(new Date(current.latest_ts).getTime()) : '—'}</div>
              {current?.presentation && <div className="archive-note">历史回放 · 非当前实测</div>}
              <div className="notice">{MODE_NOTE[current?.mode ?? 'sentinel_only']}</div>
            </div>
          </Panel>

          <Panel title="实时告警台账（只读）" className="grow" bodyClassName="tight">
            {alerts.length === 0 ? <div className="empty">当前没有告警</div> : (
              <ul className="alert-list">
                {alerts.slice(0, 6).map((a) => (
                  <li key={a.id} className="alert-item" style={{ borderLeftColor: levelColor(a.level) }}>
                    <div className="alert-head">
                      <span className="alert-stage"
                            style={{ background: `${levelColor(a.level)}22`, color: levelColor(a.level) }}>
                        {stageName(a.level, a.stage)}
                      </span>
                      <span className="alert-time">{fmtShort(a.ts)}</span>
                    </div>
                    <div className="alert-reason">{a.reason || '—'}</div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </main>

      {showForm ? (
        <Modal title="新增滑坡记录" onClose={() => setShowForm(false)}>
          <RecordForm
            points={SITES.map((s) => s.short)}
            onCancel={() => setShowForm(false)}
            onDone={(msg) => { setShowForm(false); setNotice(msg); refreshRecords() }}
          />
        </Modal>
      ) : null}

      {photo ? (
        <Modal title={`${photo.point_name} · ${photo.level}`} wide onClose={() => setPhoto(null)}>
          {photoError ? (
            <div className="empty" role="status">该记录的照片文件无法显示，文字记录仍可查看。</div>
          ) : photo.photo_url ? (
            <img className="photo-full" src={photo.photo_url} alt={`${photo.point_name} 现场照片`} onError={() => setPhotoError(true)} />
          ) : null}
          <div className="photo-meta">
            {fmtShort(photo.observed_at)} · 记录人 {photo.created_by}
            {photo.note ? ` · ${photo.note}` : ''}
          </div>
        </Modal>
      ) : null}
    </div>
  )
}

/** 记录里的"轻度/中度/重度/预警"映射到 0–4 级取颜色 */
function levelOf(text: string): number {
  return { 轻度: 1, 中度: 2, 重度: 3, 预警: 4 }[text] ?? 2
}

function SiteDetail({ site }: { site: SiteInfo }) {
  return (
    <table className="dataset-table">
      <tbody>
        <tr><th>位置</th><td>{site.location}{site.approx ? '（示意坐标）' : ''}</td></tr>
        <tr><th>时间范围</th><td>{site.period}</td></tr>
        <tr><th>数据规模</th><td>{site.scale}</td></tr>
        <tr><th>通道 / 字段</th><td>{site.channels}</td></tr>
        <tr><th>本项目用途</th><td>{site.role}</td></tr>
        <tr><th>状态</th><td><span className={`site-status tone-${site.tone}`}>{site.status}</span></td></tr>
        <tr><th>说明</th><td>{site.note}</td></tr>
      </tbody>
    </table>
  )
}

type MediaItem =
  | { kind: 'video'; src: string; label: string; poster?: string }
  | { kind: 'image'; src: string; label: string }

function SiteMedia({ site, gallery, onPick }: {
  site: SiteInfo
  gallery: number
  onPick: (i: number) => void
}) {
  // 录像与照片放在同一条缩略图条里：录像排第一格，避免"有录像就看不到实拍照片"
  const items: MediaItem[] = []
  if (site.media.video) {
    items.push({
      kind: 'video',
      src: site.media.video.src,
      label: site.media.video.label,
      poster: site.media.images[0]?.src,
    })
  }
  site.media.images.forEach((img) => items.push({ kind: 'image', src: img.src, label: img.label }))

  if (items.length === 0) {
    return (
      <div className="media-empty">
        <div className="media-empty-icon">📷</div>
        <div className="media-empty-title">暂无现场素材</div>
        <div className="video-note">{site.media.caption}</div>
      </div>
    )
  }

  const index = Math.min(gallery, items.length - 1)
  const current = items[index]
  return (
    <div className="video-box">
      {current.kind === 'video' ? (
        <video
          key={current.src}
          src={current.src}
          poster={current.poster}
          controls
          loop
          muted
          playsInline
          preload="metadata"
        />
      ) : (
        <img className="site-photo" src={current.src} alt={`${site.name} 现场影像`} decoding="async" fetchPriority="high" />
      )}
      {items.length > 1 ? (
        <div className="thumb-row">
          {items.map((item, i) => (
            <button
              key={item.src}
              type="button"
              className={`thumb ${i === index ? 'active' : ''}`}
              onClick={() => onPick(i)}
              aria-label={item.kind === 'video' ? '播放滑坡实景参考录像' : `查看第 ${i} 张影像`}
              title={item.label}
            >
              {item.kind === 'video' ? (
                <span
                  className="thumb-video"
                  style={item.poster ? { backgroundImage: `url(${thumbnailFor(item.poster)})` } : undefined}
                >
                  <span className="thumb-badge">▶</span>
                </span>
              ) : (
                <img src={thumbnailFor(item.src)} alt="" decoding="async" fetchPriority="low" />
              )}
            </button>
          ))}
        </div>
      ) : null}
      <div className="video-note">
        <b>{current.label}</b>
        <br />
        {site.name} · {site.media.caption}
      </div>
    </div>
  )
}
