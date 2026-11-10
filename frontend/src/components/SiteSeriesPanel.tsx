import { useEffect, useMemo, useState } from 'react'
import { createResourceCache } from '../lib/resourceCache'

/** 站点观测序列（静态 JSON，`tools/build_site_series.py` 生成） */
interface SiteSeries {
  site: string
  name: string
  source?: string
  note?: string
  period: string[]
  level?: [string, number][]
  rain?: [string, number][]
  gps?: Record<string, [string, number][]>
}

const W = 600
// Only these exported series exist in the current release; other sites keep their
// metadata and imagery without probing nonexistent JSON files on each visit.
const SERIES_SITES = new Set(['baijiabao', 'shuiping', 'baishuihe'])
const seriesCache = createResourceCache<SiteSeries>(3)

function MiniChart({ points, kind, color, height = 86, unit, digits = 1 }: {
  points: [string, number][]
  kind: 'line' | 'bar'
  color: string
  height?: number
  unit: string
  digits?: number
}) {
  const geom = useMemo(() => {
    const values = points.map((p) => p[1])
    if (!values.length) return null
    const min = Math.min(...values)
    const max = Math.max(...values)
    const span = max - min || 1
    const x = (i: number) => (i / Math.max(1, points.length - 1)) * W
    const y = (v: number) => height - 10 - ((v - min) / span) * (height - 22)
    const d = kind === 'line'
      ? points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ')
      : ''
    const barW = Math.max(0.6, W / points.length - 0.2)
    return { min, max, x, y, d, barW }
  }, [points, kind, height])

  if (!geom) return null
  const fmt = (v: number) => v.toFixed(digits)

  return (
    <div className="spark">
      <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" role="img"
           aria-label={`${unit} 序列，${points.length} 个点`}>
        <line x1="0" y1={height - 10} x2={W} y2={height - 10} className="spark-axis" />
        {kind === 'line' ? (
          <path d={geom.d} fill="none" stroke={color} strokeWidth="1.6" />
        ) : (
          points.map((p, i) => (
            <rect key={i} x={geom.x(i)} y={geom.y(p[1])} width={geom.barW}
                  height={Math.max(0.6, height - 10 - geom.y(p[1]))} fill={color} />
          ))
        )}
      </svg>
      <div className="spark-meta">
        <span>{points[0][0]}</span>
        <span className="spark-range">
          {fmt(geom.min)} ~ {fmt(geom.max)} {unit}
        </span>
        <span>{points[points.length - 1][0]}</span>
      </div>
    </div>
  )
}

/**
 * 数据集站点观测序列面板：库水位 / 降雨（日），可选 GPS 位移（月）。
 * 未导出连续序列的站点显示缺项说明，不把资料/影像站点误认为都有序列。
 */
export default function SiteSeriesPanel({ siteId }: { siteId: string }) {
  const [data, setData] = useState<SiteSeries | null>(null)
  const [missing, setMissing] = useState(false)
  const [showGps, setShowGps] = useState(false)

  useEffect(() => {
    let alive = true
    setData(null)
    setMissing(false)
    if (!SERIES_SITES.has(siteId)) return
    seriesCache(siteId, () => fetch(`/data/sites/${siteId}.json`)
      .then((r) => (r.ok ? r.json() as Promise<SiteSeries> : Promise.reject(new Error(String(r.status))))))
      .then((json: SiteSeries) => { if (alive) setData(json) })
      .catch(() => { if (alive) setMissing(true) })
    return () => { alive = false }
  }, [siteId])

  if (!SERIES_SITES.has(siteId)) return <div className="empty small">该站点暂无已整理的连续观测序列。</div>
  if (missing) return <div className="empty small">观测序列暂不可用，请稍后重试。</div>
  if (!data) return <div className="empty small site-series-loading" aria-busy="true">正在读取该站点的观测序列…</div>

  const gpsPoints = Object.entries(data.gps ?? {})

  return (
    <div className="site-series">
      {data.level?.length ? (
        <>
          <div className="series-title">库水位（日）</div>
          <MiniChart points={data.level} kind="line" color="#4fc3f7" unit="m" digits={2} />
        </>
      ) : null}
      {data.rain?.length ? (
        <>
          <div className="series-title">降雨量（日）</div>
          <MiniChart points={data.rain} kind="bar" color="#7ec8a0" unit="mm" />
        </>
      ) : null}
      {gpsPoints.length ? (
        <>
          <div className="series-title">
            GPS 累计位移（月）
            <button type="button" className="link-btn" onClick={() => setShowGps((v) => !v)}>
              {showGps ? '收起' : `展开 ${gpsPoints.length} 个测点`}
            </button>
          </div>
          {showGps
            ? gpsPoints.map(([point, series]) => (
                <div key={point}>
                  <div className="series-sub">{point}</div>
                  <MiniChart points={series} kind="line" color="#ffb74d" unit="mm" digits={0} />
                </div>
              ))
            : null}
        </>
      ) : null}
      <div className="series-note">
        来源：{data.source}
        {data.note ? ` · ${data.note}` : ''}
      </div>
    </div>
  )
}
