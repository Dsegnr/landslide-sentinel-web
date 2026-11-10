/** 专业底图模式：Leaflet + 高德栅格底图 + RainViewer 雷达降水。
 *
 *  为什么是这套组合（都是实测出来的结论）：
 *   * 演示机的浏览器**完全连不上外网**（连 Open-Meteo 都 Failed to fetch），
 *     所以底图/雷达一律走后端代理 `/api/map/*`（白名单 + 磁盘缓存）；
 *   * 服务器侧实测：高德栅格可用、RainViewer 可用；OSM/Carto/Esri 不可用；
 *   * 渲染选 **Leaflet**：纯 `<img>` 瓦片，没有 worker、没有矢量解码，
 *     避开 MapLibre 在打包环境下"样式永远 ready 不了"的那一堆坑（已实测踩过）。
 *
 *  离线兜底：瓦片反复加载失败会回调 `onOffline()`，上层自动切回离线省份图。
 */
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { gcj02ToWgs84, wgs84ToGcj02 } from '../lib/gcj02'
import { levelColor, levelMeta } from '../lib/levels'
import type { MapNode } from '../lib/types'
import type { WeatherMark } from './ChinaMap'
import { ReliableTileLayer } from '../lib/ReliableTileLayer'
import { loadRadarFrames, type RadarFrame } from '../lib/radarFrames'
import { scheduleViewportWarmup } from '../lib/mapViewportWarmup'

/** RainViewer 雷达色板：4 = TITAN（蓝→绿→黄→橙，接近手机天气 App） */
const RADAR_COLOR = 4

/** 底图：高德矢量路网（浅色，最接近参考图）/ 卫星影像 */
const BASEMAPS = {
  vec: { url: '/api/map/amap/vec/{z}/{x}/{y}', attr: '© 高德地图', label: '矢量路网' },
  img: { url: '/api/map/amap/img/{z}/{x}/{y}', attr: '© 高德地图', label: '卫星影像' },
} as const

type BasemapKind = keyof typeof BASEMAPS

export interface MapProProps {
  nodes: MapNode[]
  selectedKey: string
  onSelect: (key: string) => void
  weather?: WeatherMark[]
  /** 底图或雷达加载失败时回调（上层切回离线图） */
  onOffline?: (reason: string) => void
  /** 选点模式：在地图上点空白处回传 WGS-84 坐标（"新增警告点位"用，与离线图口径一致） */
  pickMode?: boolean
  onPickLocation?: (lonLat: [number, number]) => void
}

export default function MapPro({
  nodes, selectedKey, onSelect, weather = [], onOffline,
  pickMode = false, onPickLocation,
}: MapProProps) {
  const holder = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const baseRef = useRef<L.TileLayer | null>(null)
  const radarRef = useRef<L.TileLayer | null>(null)
  const markersRef = useRef<L.Marker[]>([])
  const failCount = useRef(0)
  const okCount = useRef(0)
  // 本次底图选择有没有**成功加载过**瓦片：用来守"整层不可用"的判定。
  // 一旦成功过，后续批量失败（快速缩放/放大时上游限流）只是局部丢图，
  // 不该把整张专业底图踢回离线图。
  const layerOk = useRef(false)
  // 已经飞过的选中项：避免数据刷新时反复抢镜
  const flownKey = useRef('')
  // 选点模式的实时值：标记的 click 回调建立一次就不重建，用 ref 拿最新状态
  const pickRef = useRef(false)

  const [basemap, setBasemap] = useState<BasemapKind>('vec')
  const [showRadar, setShowRadar] = useState(true)
  const [status, setStatus] = useState('正在加载底图…')
  const [radarStatus, setRadarStatus] = useState('')
  const [radarReady, setRadarReady] = useState(false)
  const [currentRadar, setCurrentRadar] = useState<RadarFrame | null>(null)
  const [frames, setFrames] = useState<RadarFrame[]>([])
  const [frameIdx, setFrameIdx] = useState(-1)
  const [playing, setPlaying] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => { pickRef.current = pickMode }, [pickMode])

  // 建图（只建一次）
  useEffect(() => {
    const el = holder.current
    if (!el) return
    const map = L.map(el, {
      center: [35.5, 104],          // 全国视图
      zoom: 4,
      minZoom: 3,
      maxZoom: 17,
      zoomControl: true,
      preferCanvas: true,
      wheelDebounceTime: 90,
      wheelPxPerZoomLevel: 100,
    })
    mapRef.current = map
    L.control.scale({ imperial: false }).addTo(map)
    // Layout changes include breakpoints, column tabs and browser zoom, not only
    // the expanded toggle. Resize the tile viewport whenever its holder changes.
    let resizeFrame = 0
    const resize = () => {
      cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => {
        if (el.clientWidth && el.clientHeight) map.invalidateSize({ pan: false, debounceMoveend: true })
      })
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    observer?.observe(el)
    window.addEventListener('resize', resize)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', resize)
      cancelAnimationFrame(resizeFrame)
      markersRef.current.forEach((m) => m.remove())
      markersRef.current = []
      map.remove()
      mapRef.current = null
      baseRef.current = null
      radarRef.current = null
    }
  }, [])

  // 底图瓦片（高德，经后端代理）
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (baseRef.current) {
      baseRef.current.remove()
      baseRef.current = null
    }
    failCount.current = 0
    okCount.current = 0
    layerOk.current = false
    const cfg = BASEMAPS[basemap]
    const layer = new ReliableTileLayer(cfg.url, {
      attribution: cfg.attr,
      subdomains: [],
      maxZoom: 17,
    }, 0)
    const failed = new Set<HTMLElement>()
    layer.on('loading', () => setStatus('底图加载中…'))
    layer.on('load', () => setStatus([...failed].some(tile => tile.isConnected) ? '部分底图未加载，可重试' : ''))
    layer.on('tileunload', e => { failed.delete(e.tile) })
    layer.on('tileload', e => {
      failed.delete(e.tile)
      okCount.current += 1
      layerOk.current = true
    })
    layer.on('tileerror', e => {
      failed.add(e.tile)
      e.tile.style.visibility = 'hidden'
      failCount.current += 1
      // 判定"底图不可用"要**本次底图选择一张都没成功 + 失败足够多**：
      // 只看失败数会把"快速缩放时被上游限流的几张瓦片"误判成整层不可用，
      // 结果是正常浏览中被自动切回离线图（实测踩过：点击"放大查看"要一次拉 64 张瓦片，
      // 先失败的 8 张就把专业底图踢回了离线图，用户看到的现象是"放大之后功能就没了"）。
      if (layerOk.current || okCount.current > 0) return
      if (failCount.current >= 8) {
        setStatus('底图瓦片加载失败')
        onOffline?.('底图瓦片加载失败（网络或代理不可用）')
      }
    })
    const fallbackTimer = window.setTimeout(() => {
      if (!layerOk.current && okCount.current === 0) onOffline?.('在线底图超时，已显示离线点位图')
    }, 12000)
    layer.addTo(map)
    baseRef.current = layer
    const stopWarmup = scheduleViewportWarmup(map, layer, basemap)
    return () => { stopWarmup(); window.clearTimeout(fallbackTimer); layer.remove(); layer.off(); if (baseRef.current === layer) baseRef.current = null }
  }, [basemap, onOffline])

  // 雷达帧列表（后端代理，含过去 2 小时）
  useEffect(() => {
    let alive = true
    loadRadarFrames()
      .then((all) => {
        if (!alive) return
        setFrames(all)
        setFrameIdx(all.length - 1)
      })
      .catch((err: Error) => {
        if (alive) setRadarStatus(`雷达不可用：${err.message}`)
      })
    return () => { alive = false }
  }, [])

  // 雷达图层（跟随当前帧）
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!showRadar || frameIdx < 0 || !frames[frameIdx]) {
      radarRef.current?.remove(); radarRef.current?.off(); radarRef.current = null
      setCurrentRadar(null); setRadarReady(false); setRadarStatus('')
      return
    }
    const old = radarRef.current
    const url = `/api/map/radar${frames[frameIdx].path}/256/{z}/{x}/{y}/${RADAR_COLOR}/1_1.png`
    // maxNativeZoom 必须设：RainViewer 的雷达瓦片**只到 z=7**，z≥8 时上游会返回一张
    // "Zoom Level Not Supported" 的半透明灰底占位图（实测 z=8 与 z=10 返回的图片 MD5 完全相同）。
    // 现场页点站点后会飞到 zoom 8，整屏就会糊上成排灰块。
    // 设了 maxNativeZoom 之后，Leaflet 在 z>7 时复用并放大 z7 的瓦片，不再请求不支持的级别。
    const layer = new ReliableTileLayer(url, {
      opacity: old ? 0 : .75, maxZoom: 17, maxNativeZoom: 7, zIndex: 5,
    }, 1)
    let alive = true, shown = false
    const failed = new Set<HTMLElement>()
    const succeeded = new Set<HTMLElement>()
    setRadarReady(false); setRadarStatus('降水帧加载中…')
    layer.on('loading', () => { if (alive) { setRadarReady(false); setRadarStatus('降水瓦片加载中…') } })
    layer.on('tileerror', e => { failed.add(e.tile); e.tile.style.visibility = 'hidden' })
    layer.on('tileload', e => {
      succeeded.add(e.tile)
      // On the first frame, reveal valid tiles progressively. Later frames keep
      // the previous complete image until the replacement is ready.
      if (alive && !old && !shown) {
        shown = true; radarRef.current = layer; setCurrentRadar(frames[frameIdx])
      }
    })
    layer.on('tileunload', e => { failed.delete(e.tile); succeeded.delete(e.tile) })
    layer.on('load', () => {
      if (!alive) return
      if (![...succeeded].some(tile => tile.isConnected)) {
        layer.remove(); layer.off()
        setRadarReady(true); setRadarStatus(old ? '该降水帧暂不可用，保留上一帧' : '该降水帧暂不可用')
        return
      }
      layer.setOpacity(.75); shown = true
      if (old && old !== layer) { old.remove(); old.off() }
      radarRef.current = layer
      setCurrentRadar(frames[frameIdx]); setRadarReady(true)
      setRadarStatus([...failed].some(tile => tile.isConnected) ? '部分降水瓦片暂缺' : '')
    })
    layer.addTo(map)
    return () => { alive = false; if (!shown) { layer.remove(); layer.off() } }
  }, [frames, frameIdx, showRadar])

  // 回放
  useEffect(() => {
    if (!playing || !showRadar || !radarReady || frames.length < 2) return
    const timer = setTimeout(() => {
      setFrameIdx((i) => (i + 1 >= frames.length ? 0 : i + 1))
    }, 700)
    return () => clearTimeout(timer)
  }, [playing, showRadar, radarReady, frames.length, frameIdx])

  // 放大/退出放大后要让 Leaflet 重新量尺寸，否则瓦片铺不满
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const timer = setTimeout(() => map.invalidateSize(), 120)
    return () => clearTimeout(timer)
  }, [expanded])

  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  // 点位与天气图标（WGS-84 → GCJ-02，才和高德底图对齐）
  // nodes 每次轮询都是**新数组**（内容往往一模一样）；直接拿它当依赖会让所有标记
  // 每 8~30 秒被整体删除重建（实测空闲 45 秒重建 2 轮），既卡、又会把用户打开的弹窗弄没。
  // 所以用"内容签名"决定要不要重算：签名不变 → marks 身份不变 → 下面的 effect 不重建标记。
  const marksKey = useMemo(
    () => nodes
      .map((n) => [n.id, n.name, n.lon, n.lat, n.level, n.weight, n.watch, n.source, n.status, n.note, n.data_available].join('~'))
      .join('|'),
    [nodes],
  )

  const marks = useMemo(() => {
    const wxByKey = new Map(weather.map((w) => [w.key, w]))
    return nodes
      .filter((n) => Number.isFinite(n.lon) && Number.isFinite(n.lat))
      .map((n) => {
        const key = String(n.id)
        const [lon, lat] = wgs84ToGcj02(n.lon, n.lat)
        return { key, node: n, lon, lat, wx: wxByKey.get(key) }
      })
    // 依赖签名而不是 nodes（理由见上）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marksKey, weather])

  const popupHtml = useCallback((m: (typeof marks)[number]) => {
    const n = m.node
    const isSite = n.source === 'site'
    return [
      `<b>${n.name}</b>`,
      isSite
        ? `数据集站点${n.status ? ` · ${n.status}` : ''}`
        : `等级：<b style="color:${(n.data_available === false ? '#94a3b8' : levelColor(n.level))}">${(n.data_available === false ? '数据不足' : levelMeta(n.level).name)}</b>`
          + `　权重：${n.weight.toFixed(1)}`,
      n.note ? `<span style="color:#666">${n.note}</span>` : '',
      m.wx
        ? '<hr style="border:none;border-top:1px solid #d5e3ef;margin:4px 0"/>'
          + `<b>${m.wx.icon} 天气</b>：${m.wx.lines[0] ?? ''}<br/>`
          + m.wx.lines.slice(1, 4).join('<br/>')
        : '',
    ].filter(Boolean).join('<br/>')
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    markersRef.current.forEach((mk) => mk.remove())
    markersRef.current = []
    for (const m of marks) {
      const isSite = m.node.source === 'site'
      const color = isSite ? '#16a34a' : m.node.data_available === false ? '#94a3b8' : levelColor(m.node.level)
      const html = `<div class="pro-marker" style="border-color:${color}">`
        + `<span class="pro-marker-dot" style="background:${color}"></span>`
        + (m.wx ? `<span class="pro-marker-wx">${m.wx.icon}</span>` : '')
        + '</div>'
      const icon = L.divIcon({ className: 'pro-marker-wrap', html, iconSize: [34, 20], iconAnchor: [17, 10] })
      const marker = L.marker([m.lat, m.lon], { icon, riseOnHover: true })
        .bindPopup(popupHtml(m), { closeButton: false })
        // 选点模式下点击只用于选位置（与离线图 ChinaMap 的行为一致）
        .on('click', () => { if (!pickRef.current) onSelect(m.key) })
        .addTo(map)
      markersRef.current.push(marker)
    }
  }, [marks, onSelect, popupHtml])

  // 选中点位时飞到它（转到 GCJ-02 坐标）
  // 只在"选中项真的变了"时飞一次：marks 会因为轮询数据更新而重算，
  // 若每次都重新 flyTo，用户正在缩放/拖动时会被反复抢镜（手感就是"特别卡"）。
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!selectedKey) {
      if (flownKey.current !== '') {
        flownKey.current = ''
        map.flyTo([35.5, 104], 4, { duration: 0.6 })
      }
      return
    }
    if (flownKey.current === selectedKey) return
    const found = marks.find((m) => m.key === selectedKey)
    if (!found) return          // 数据还没到，等下次 marks 更新再飞
    flownKey.current = selectedKey
    map.flyTo([found.lat, found.lon], 8, { duration: 0.8 })
  }, [selectedKey, marks])

  // 选点模式：点地图空白处 → 回传 WGS-84 坐标。
  // 高德底图是 GCJ-02（火星坐标），必须转回 WGS-84 —— 系统里所有点位（离线图点选、
  // 数据集站点、设备坐标）都存 WGS-84，不转会让新增的点位在离线图上偏几百米。
  useEffect(() => {
    const map = mapRef.current
    const el = holder.current
    if (!map || !pickMode || !onPickLocation) return
    const onClick = (e: L.LeafletMouseEvent) => {
      const [lon, lat] = gcj02ToWgs84(e.latlng.lng, e.latlng.lat)
      onPickLocation([Number(lon.toFixed(4)), Number(lat.toFixed(4))])
    }
    map.on('click', onClick)
    if (el) el.style.cursor = 'crosshair'
    return () => {
      map.off('click', onClick)
      if (el) el.style.cursor = ''
    }
  }, [pickMode, onPickLocation])

  const currentFrame = currentRadar
  const displayedFrameIdx = currentFrame ? frames.findIndex(frame => frame.path === currentFrame.path) : -1
  const timeText = currentFrame
    ? new Date(currentFrame.time * 1000).toLocaleTimeString('zh-CN', {
      hour: '2-digit', minute: '2-digit' })
    : '—'

  return (
    <div className={`map-pro ${expanded ? 'expanded' : ''}`}>
      <div className="map-bar">
        <span className="map-stat">底图：<b>高德 {BASEMAPS[basemap].label}</b></span>
        <span className="map-stat">降水：<b>RainViewer 雷达</b></span>
        <button
          type="button"
          className={`range-btn ${basemap === 'vec' ? 'active' : ''}`}
          onClick={() => setBasemap(basemap === 'vec' ? 'img' : 'vec')}
        >
          {basemap === 'vec' ? '切影像' : '切矢量'}
        </button>
        <button
          type="button"
          className={`range-btn ${showRadar ? 'active' : ''}`}
          onClick={() => { setShowRadar((v) => !v); setPlaying(false) }}
        >
          {showRadar ? '隐藏降水' : '显示降水'}
        </button>
        <button
          type="button"
          className={`range-btn ${expanded ? 'active' : ''}`}
          onClick={() => setExpanded((v) => !v)}
          title="把地图放大到整屏看（Esc 退出）"
        >
          {expanded ? '退出放大' : '放大查看'}
        </button>
        {selectedKey ? (
          <button type="button" className="range-btn" onClick={() => onSelect('')}>
            全国视图
          </button>
        ) : null}
        {pickMode ? <span className="map-hint">点击地图空白处选点</span> : null}
        {status ? <span className="map-hint">{status}</span> : null}
        {radarStatus ? <span className="map-hint">{radarStatus}</span> : null}
        {status.includes('重试') || radarStatus.includes('暂缺') || radarStatus.includes('暂不可用') ? <button type="button" className="range-btn" onClick={() => { baseRef.current?.redraw(); radarRef.current?.redraw(); if (radarStatus.includes('暂不可用')) setFrames(value => [...value]) }}>重试地图</button> : null}
      </div>

      <div className="map-pro-stage">
        <div className="map-pro-canvas" ref={holder} />
      </div>

      {frames.length > 1 ? (
        <div className="radar-timeline">
          <button
            type="button" className="range-btn"
            onClick={() => setPlaying((v) => !v)}
            aria-label={playing ? '暂停回放' : '播放回放'}
          >{playing ? '⏸' : '▶'}</button>
          <input
            type="range" min={0} max={frames.length - 1} value={Math.max(0, frameIdx)}
            onChange={(e) => { setPlaying(false); setFrameIdx(Number(e.target.value)) }}
            aria-label="雷达时间轴"
          />
          <span className="map-stat">
            雷达 {timeText}
            {!showRadar ? '（已隐藏）' : displayedFrameIdx < 0 ? radarStatus.includes('不可用') ? '（暂不可用）' : '（加载中）' : displayedFrameIdx === frames.length - 1 ? '（最新）' : `（${frames.length - displayedFrameIdx - 1} 帧前）`}
          </span>
        </div>
      ) : <div className="radar-timeline radar-timeline-pending" aria-hidden="true" />}

      <div className="map-legend">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="legend-item">
            <span className="dot" style={{ background: levelColor(i) }} />
            {levelMeta(i).name}
          </span>
        ))}
        <span className="legend-item"><span className="dot precip-dot" />雷达降水 小→大</span>
        {weather.length > 0 ? (
          <span className="legend-item"><span className="dot weather-dot" />天气（真实数据）</span>
        ) : null}
      </div>
    </div>
  )
}
