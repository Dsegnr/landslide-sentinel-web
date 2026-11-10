import type { EChartsOption } from 'echarts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useECharts } from '../hooks/useECharts'
import type { WeatherGridPoint } from '../lib/api'
import { LABEL_CITIES } from '../lib/cities'
import { escapeHtml, fmtShort } from '../lib/format'
import { loadProvinceIndex, locateText } from '../lib/geo'
import { levelColor, levelMeta } from '../lib/levels'
import type { MapNode, MapSummary } from '../lib/types'
import { echarts } from '../lib/echarts'
import { RAIN_BOUNDS, buildRainCanvas } from '../lib/rainField'

const GEO_NAME = 'china-sentinel'

/** 地图上的天气标记：图标 + 颜色 + 悬停详情（天气 + 原本的滑坡信息一起显示） */
export interface WeatherMark {
  /** 与点位 key 对应（如 `device:slope-node-01`、`site:baijiabao`），用于把天气并进该点的 tooltip */
  key: string
  name: string
  lon: number
  lat: number
  icon: string
  color: string
  /** 多行纯文本；渲染时逐行转义 */
  lines: string[]
  severity: number
}

interface ChinaMapProps {
  nodes: MapNode[]
  summary: MapSummary
  selectedKey: string
  onSelect: (key: string) => void
  /** 天气图层（可选）：没有天气数据时传空数组即可 */
  weather?: WeatherMark[]
  /** 全国粗网格实时降水：地图上的"降水色块" */
  precip?: WeatherGridPoint[]
  /** 管理人员开启"新增点位"后，点地图空白处会回传经纬度 */
  pickMode?: boolean
  onPickLocation?: (lonLat: [number, number]) => void
  /** 现场页用：这里展示的是"数据从哪来"，不是风险态势，顶部条改成站点/节点数量 */
  variant?: 'risk' | 'sites'
}

/** 全国点位图：离线中国地图（本地 GeoJSON）+ 等级着色 + 点蔓延动效。

 *  为什么不直接用在线地图：队长原版依赖阿里 DataV 的远程 JSON，比赛现场断网就白屏。
 *  这里把 GeoJSON **下载成本地文件**（frontend/public/geo/china-full.json），断网照常渲染。
 */
export default function ChinaMap({
  nodes, summary, selectedKey, onSelect, weather = [], precip = [],
  pickMode = false, onPickLocation,
  variant = 'risk',
}: ChinaMapProps) {
  const [geoReady, setGeoReady] = useState(false)
  const [geoError, setGeoError] = useState('')
  const [showPrecip, setShowPrecip] = useState(true)
  const [lightBase, setLightBase] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement | null>(null)

  // 聚焦由外部选中驱动（点列表 / 点地图都会更新它）；点"全国视图"传空串复位
  const focused = useMemo(
    () => nodes.find((n) => String(n.id) === selectedKey
      || (n.source === 'device' && `device:${n.device_id}` === selectedKey)) ?? null,
    [nodes, selectedKey],
  )

  useEffect(() => {
    let alive = true
    fetch('/geo/china-full.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((geo) => {
        if (!alive) return
        echarts.registerMap(GEO_NAME, geo)
        loadProvinceIndex(geo)          // 建省份索引：tooltip 里显示"这是哪儿"
        setGeoReady(true)
      })
      .catch((err) => alive && setGeoError(String(err)))
    return () => { alive = false }
  }, [])

  const dataKey = useMemo(() => JSON.stringify([nodes, weather, precip]), [nodes, weather, precip])
  const option = useMemo<EChartsOption>(() => {
    // 点位去重叠：同一边坡上的两个节点经纬度几乎一样，会叠成一个点。
    // 对"太近"的点做小幅确定性偏移（±0.045°），保证都能看见、都能点。
    const seen: Array<[number, number]> = []
    const jitter = (n: MapNode): number[] => {
      let lon = n.lon
      let lat = n.lat
      let guard = 0
      while (guard < 8 && seen.some(([a, b]) => Math.abs(a - lon) < 0.05 && Math.abs(b - lat) < 0.05)) {
        const angle = ((guard * 90 + 45) * Math.PI) / 180
        lon = n.lon + Math.cos(angle) * 0.045
        lat = n.lat + Math.sin(angle) * 0.035
        guard += 1
      }
      seen.push([lon, lat])
      return [lon, lat]
    }
    const mk = (n: MapNode) => ({
      name: n.name,
      // value: [经度, 纬度, 等级]；symbolSize 单独给，让它随等级/权重变大
      value: [...jitter(n), n.level],
      symbolSize: 7 + n.level * 3.2 + (n.weight - 1) * 1.6 + (n.watch ? 2 : 0),
      key: String(n.id),
      node: n,
      itemStyle: {
        color: n.data_available === false ? '#94a3b8' : levelColor(n.level),
        borderColor: n.watch ? '#ffffff' : 'rgba(6,20,38,.9)',
        borderWidth: n.watch ? 2 : 1,
      },
    })
    const sites = nodes.filter((n) => n.source === 'site')
    const hazard = nodes.filter((n) => n.source !== 'site')
    // 天气按 key 索引：点位 tooltip 里要能顺带显示它
    const weatherByKey = new Map(weather.map((w) => [w.key, w]))
    // 反向索引：悬停天气图标时，如果它正好压在某个点位上（全国视图下很常见），
    // 要把该点位的滑坡信息一起带出来，而不是只显示天气
    const nodeByKey = new Map(nodes.map((n) => [String(n.id), n]))
    const weatherPoints = weather.map((w) => ({
      name: `${w.name} 天气`,
      value: [w.lon, w.lat, w.severity],
      symbol: 'circle',
      symbolSize: 10 + w.severity * 1.6,
      key: w.key,
      weatherMark: w,
      itemStyle: { color: w.color, borderColor: 'rgba(6,20,38,.85)', borderWidth: 1.2 },
      label: {
        show: true,
        position: 'top' as const,
        distance: 6,
        fontSize: 14,
        formatter: w.icon,
      },
    }))
    const ripple = hazard.filter((n) => n.level >= 2).map(mk)
    const calm = hazard.filter((n) => n.level < 2).map(mk)
    const watched = hazard.filter((n) => n.watch).map((n) => ({ ...mk(n), symbolSize: 20 + n.level * 2 }))
    // 数据集站点用菱形区分（它们不是"危险点"，而是"数据从哪来"）
    const toneColor = { ok: '#34d399', warn: '#fbbf24', muted: '#94a3b8' } as const
    const sitePoints = sites.map((n) => ({
      name: n.name,
      value: [n.lon, n.lat, 0],
      symbol: 'diamond',
      symbolSize: 16,
      key: String(n.id),
      node: n,
      itemStyle: { color: toneColor[n.tone ?? 'muted'],
                   borderColor: 'rgba(6,20,38,.9)', borderWidth: 1.5 },
    }))

    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        renderMode: 'html',
        appendToBody: true,
        className: 'sentinel-map-tooltip',
        enterable: false,
        transitionDuration: 0,
        hideDelay: 100,
        extraCssText: 'pointer-events:none;max-width:260px;white-space:normal;overflow-wrap:anywhere',
        // 点位常在地图边缘，不限制的话提示框会被视口裁掉半截
        confine: true,
        backgroundColor: 'rgba(6,20,38,.94)',
        borderColor: 'rgba(79,195,247,.5)',
        textStyle: { color: '#e8f4ff', fontSize: 12 },
        formatter: (params: unknown) => {
          const p = params as { data?: { node?: MapNode } }
          const wm = (p.data as { weatherMark?: WeatherMark } | undefined)?.weatherMark
          // 悬停天气图标时，若同 key 有点位，就按点位渲染（信息更全），否则只显示天气
          const n = p.data?.node ?? (wm ? nodeByKey.get(wm.key) : undefined)
          if (!n && wm) {
            // 只有天气标记（例如数据集站点本身不在点位列表里）：
            // 顺手把**附近点位**的滑坡信息带出来——国家视图下点位密集，
            // 用户点在天气图标上，多半就是想看"这儿天气怎么样、附近点位什么等级"。
            const near = nodes
              .map((node) => ({
                node,
                d: Math.hypot((node.lon - wm.lon) * 96, (node.lat - wm.lat) * 110.5),
              }))
              .filter((x) => x.d < 5)                 // 5 km 以内
              .sort((a, b) => a.d - b.d)
              .slice(0, 2)
            const nearLines = near.map(({ node, d }) =>
              `${escapeHtml(node.name)}（${node.source === 'device' ? '监测设备' : '人工点位'}）`
              + `｜等级：${escapeHtml(node.data_available === false ? '数据不足' : levelMeta(node.level).name)}｜约 ${d.toFixed(1)} km`)
            return [
              `<b>${escapeHtml(wm.name)}</b> · 天气`,
              ...wm.lines.map((line) => escapeHtml(line)),
              ...(nearLines.length
                ? ['<hr style="border:none;border-top:1px solid rgba(79,195,247,.3);margin:4px 0"/>',
                   '<b>附近点位</b>',
                   ...nearLines]
                : []),
              '<i>点击可查看该地点详情</i>',
            ].join('<br/>')
          }
          if (!n) return ''
          const wx = wm ?? weatherByKey.get(String(n.id))
          const wxBlock = wx
            ? ['<hr style="border:none;border-top:1px solid rgba(79,195,247,.3);margin:4px 0"/>',
               `${wx.icon} <b>天气</b>：${escapeHtml(wx.lines[0] ?? '')}`,
               ...wx.lines.slice(1, 2).map((line) => escapeHtml(line))]
            : []
          // 名称/备注都是用户可控 → 必须转义后再拼 HTML（ECharts tooltip 按 HTML 渲染）
          const source = n.source === 'device' ? '监测设备'
            : n.source === 'site' ? '数据集站点' : '人工新增'
          const where = locateText(n.lon, n.lat)
          if (n.source === 'site') {
            return [
              `<b>${escapeHtml(n.name)}</b>（${source}）`,
              `位置：${escapeHtml(n.location ?? where)}`,
              `坐标：${where}`,
              n.status ? `状态：${escapeHtml(n.status)}` : '',
              '<i>点击查看该地点的现场影像</i>',
              ...wxBlock,
            ].filter(Boolean).join('<br/>')
          }
          return [
            `<b>${escapeHtml(n.name)}</b>（${source}）`,
            `位置：${where}`,
            `等级：${escapeHtml(n.data_available === false ? '数据不足' : levelMeta(n.level).name)}`,
            `权重：${n.weight.toFixed(1)}${n.watch ? ' · <b>已关注</b>' : ''}`,
            n.note ? `说明：${escapeHtml(n.note)}` : '',
            n.updated_at ? `更新：${fmtShort(n.updated_at)}` : '',
            ...wxBlock,
          ].filter(Boolean).join('<br/>')
        },
      },
      geo: {
        map: GEO_NAME,
        roam: true,
        // 选中点位时放大到该点附近：全国视图下 100 米级的两个节点是重合的，
        // 必须靠"聚焦放大"才能分开看（这也是点击变动的可视化反馈）
        zoom: focused ? 7 : 1.15,
        center: focused ? [focused.lon, focused.lat] : [104, 35.5],
        itemStyle: {
          areaColor: lightBase ? 'rgba(226,236,245,.9)' : 'rgba(13,40,71,.85)',
          borderColor: lightBase ? 'rgba(120,152,186,.6)' : 'rgba(79,195,247,.45)',
          borderWidth: 0.6,
        },
        emphasis: {
          disabled: true,
          itemStyle: { areaColor: lightBase ? 'rgba(210,226,240,.95)' : 'rgba(21,64,110,.92)' },
          label: { show: false },
        },
        select: { disabled: true },
        tooltip: { show: false },
      },
      series: [
        {
          name: '报警点位',
          type: 'effectScatter',
          silent: true,
          coordinateSystem: 'geo',
          // 点蔓延：报警点位持续向外扩散的波纹
          rippleEffect: { brushType: 'stroke', scale: 3.4, period: 3.6 },
          zlevel: 2,
          data: ripple,
        },
        {
          name: '报警详情',
          type: 'scatter',
          tooltip: { show: true },
          coordinateSystem: 'geo',
          zlevel: 3,
          emphasis: { scale: false },
          data: ripple,
        },
        {
          name: '平稳点位',
          type: 'scatter',
          tooltip: { show: true },
          emphasis: { scale: false },
          coordinateSystem: 'geo',
          zlevel: 1,
          data: calm,
        },
        {
          name: '关注圈',
          type: 'scatter',
          silent: true,
          coordinateSystem: 'geo',
          symbol: 'circle',
          zlevel: 3,
          itemStyle: { color: 'transparent', borderColor: '#ffffff', borderWidth: 1.4 },
          data: watched,
        },
        {
          name: '数据集站点',
          type: 'scatter',
          tooltip: { show: true },
          emphasis: { scale: false },
          coordinateSystem: 'geo',
          zlevel: 2,
          data: sitePoints,
        },
        {
          name: '天气',
          type: 'scatter',
          tooltip: { show: true },
          emphasis: { scale: false },
          coordinateSystem: 'geo',
          zlevel: 4,
          data: weatherPoints,
        },
        {
          // 城市名：只在降水图层打开时显示，避免地图太挤
          name: '城市',
          type: 'scatter',
          coordinateSystem: 'geo',
          zlevel: 5,
          silent: true,
          symbol: 'circle',
          symbolSize: 3,
          itemStyle: { color: lightBase ? 'rgba(70,110,150,.9)' : 'rgba(150,200,240,.85)' },
          label: {
            show: showPrecip,
            position: 'right' as const,
            distance: 3,
            fontSize: 9,
            color: lightBase ? 'rgba(30,58,88,.95)' : 'rgba(200,228,248,.9)',
            formatter: (p: { data?: unknown }) => {
              const d = p.data as { cityName?: string } | undefined
              return d?.cityName ?? ''
            },
          },
          // 国家视图下城市名会互相压字，交给 ECharts 自动避让（压不住的直接不显示）
          labelLayout: { hideOverlap: true },
          data: LABEL_CITIES.map((c) => ({
            name: c.name,
            cityName: c.name,
            value: [c.lon, c.lat],
          })),
        },
      ],
    }
  // Stable content avoids resetting the geo view and tooltip on every poll.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, focused?.id, focused?.lon, focused?.lat, showPrecip, lightBase])

  const handleClick = useCallback((params: unknown) => {
    const data = (params as { data?: { key?: string } })?.data
    if (data?.key && !pickMode) {          // 选点模式下点击只用于选位置
      onSelect(data.key)
    }
  }, [onSelect, pickMode])

  const handleZrClick = useCallback((offset: [number, number],
                                     chart: ReturnType<typeof echarts.init>) => {
    if (!pickMode || !onPickLocation) return
    const pt = chart.convertFromPixel({ geoIndex: 0 }, offset) as number[]
    if (Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) {
      onPickLocation([Number(pt[0].toFixed(4)), Number(pt[1].toFixed(4))])
    }
  }, [pickMode, onPickLocation])

  // Esc 退出放大
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  const ref = useECharts(geoReady ? option : {}, handleClick, handleZrClick)

  // 雨区图：网格点 → 连续色块，画在一张**独立的透明画布**上，
  // 叠在地图上面但 `pointer-events:none`——所以悬停、点选照常穿透到地图。
  // 每次缩放/平移后按 geo 的实时投影重算位置。
  useEffect(() => {
    const chartEl = ref.current
    const overlay = overlayRef.current
    if (!chartEl || !overlay || !geoReady) return
    const inst = echarts.getInstanceByDom(chartEl)
    if (!inst) return

    let rainCanvas: HTMLCanvasElement | null = null
    if (showPrecip && precip.length) {
      try {
        rainCanvas = buildRainCanvas(precip)
      } catch (err) {
        console.error('[rainField] 生成失败', err)
        rainCanvas = null
      }
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const redraw = () => {
      const w = chartEl.clientWidth
      const h = chartEl.clientHeight
      if (overlay.width !== Math.round(w * dpr) || overlay.height !== Math.round(h * dpr)) {
        overlay.width = Math.round(w * dpr)
        overlay.height = Math.round(h * dpr)
      }
      const ctx = overlay.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      if (!rainCanvas) return
      try {
        const tl = inst.convertToPixel({ geoIndex: 0 },
          [RAIN_BOUNDS.west, RAIN_BOUNDS.north]) as number[]
        const br = inst.convertToPixel({ geoIndex: 0 },
          [RAIN_BOUNDS.east, RAIN_BOUNDS.south]) as number[]
        const rw = br[0] - tl[0]
        const rh = br[1] - tl[1]
        if (!Number.isFinite(rw) || !Number.isFinite(rh) || rw <= 0 || rh <= 0) return
        ctx.drawImage(rainCanvas, tl[0], tl[1], rw, rh)
      } catch (err) {
        console.error('[rainField] 绘制失败', err)
      }
    }
    redraw()
    inst.on('georoam', redraw)
    inst.on('finished', redraw)
    window.addEventListener('resize', redraw)
    return () => {
      inst.off('georoam', redraw)
      inst.off('finished', redraw)
      window.removeEventListener('resize', redraw)
    }
  }, [ref, geoReady, precip, showPrecip])

  const content = (
    <div className={`china-map ${expanded ? 'expanded' : ''}`}>
      <div className="map-bar">
        {variant === 'risk' ? (
          <>
            <span className="map-stat">
              区域最高：<b style={{ color: levelColor(summary.max_level) }}>{summary.max_stage || '平静'}</b>
            </span>
            <span className="map-stat">加权风险：<b>{summary.weighted_score.toFixed(2)}</b> / 4</span>
            <span className="map-stat">关注点位：<b>{summary.watch_count}</b></span>
            <span className="map-stat">点位：设备 {summary.device_count} · 人工 {summary.manual_count}</span>
          </>
        ) : (
          <>
            <span className="map-stat">
              数据集站点：<b>{nodes.filter((n) => n.source === 'site').length}</b>
            </span>
            <span className="map-stat">
              监测节点：<b>{nodes.filter((n) => n.source === 'device').length}</b>
            </span>
            <span className="map-stat">点地图上的 ◆ 或左侧列表，即可切换该地点的现场影像</span>
          </>
        )}
        {focused ? (
          <button type="button" className="range-btn" onClick={() => onSelect('')}>
            全国视图
          </button>
        ) : null}
        {precip.length > 0 ? (
          <button
            type="button"
            className={`range-btn ${showPrecip ? 'active' : ''}`}
            onClick={() => setShowPrecip((v) => !v)}
            title="实时降水色块与城市名（Open-Meteo）"
          >
            {showPrecip ? '隐藏降水' : '降水'}
          </button>
        ) : null}
        <button
          type="button"
          className={`range-btn ${lightBase ? 'active' : ''}`}
          onClick={() => setLightBase((v) => !v)}
          title="底图明暗切换"
        >
          {lightBase ? '深色底图' : '浅色底图'}
        </button>
        <button
          type="button"
          className={`range-btn ${expanded ? 'active' : ''}`}
          onClick={() => setExpanded((v) => !v)}
          title="把地图放大到整屏看（Esc 退出）"
        >
          {expanded ? '退出放大' : '放大查看'}
        </button>
        {pickMode ? <span className="map-hint">点击地图空白处选点</span> : null}
      </div>
      {geoError ? <div className="empty">地图数据加载失败：{geoError}</div> : null}
      <div className="map-stage" ref={stageRef}>
        <div className={`chart map-chart ${selectedKey ? '' : ''}`} ref={ref} data-testid="china-map" />
        <canvas className="rain-overlay" ref={overlayRef} aria-hidden="true" />
      </div>
      <div className="map-legend">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="legend-item">
            <span className="dot" style={{ background: levelColor(i) }} />
            {levelMeta(i).name}
          </span>
        ))}
        <span className="legend-item">
          <span className="dot watch-dot" />已关注（白边）
        </span>
        <span className="legend-item">
          <span className="dot site-dot" />数据集站点
        </span>
        {weather.length > 0 ? (
          <span className="legend-item" title="真实天气（Open-Meteo），颜色按降雨强度分档：蓝→黄→橙→红">
            <span className="dot weather-dot" />天气（真实数据 · 颜色=雨强）
          </span>
        ) : null}
        {precip.length > 0 && showPrecip ? (
          <span className="legend-item" title="全国粗网格实时降水（4°≈400 km 一格）">
            <span className="dot precip-dot" />降水 小→大
          </span>
        ) : null}
      </div>
    </div>
  )
  return content
}
