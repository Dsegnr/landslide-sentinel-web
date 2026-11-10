import { dailyDeltaFromPoints, fmtNum, todayRain } from '../lib/format'
import type { Reading, SeriesPoint } from '../lib/types'

interface StatCardProps {
  label: string
  value: string
  unit?: string
  hint?: string
  hintColor?: string
}

function StatCard({ label, value, unit, hint, hintColor }: StatCardProps) {
  return (
    <article className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        {value}
        {unit ? <span className="stat-unit">{unit}</span> : null}
      </div>
      <div className="stat-hint" style={hintColor ? { color: hintColor } : undefined}>
        {hint ?? '—'}
      </div>
    </article>
  )
}

interface DataCardsProps {
  reading: Reading | null
  points: SeriesPoint[]
  /** 库水位（m）；null 表示该设备没有关联水位站 */
  level?: number | null
  displacementUnavailable?: boolean
  archive?: boolean
  mixedArchive?: boolean
}

export default function DataCards({ reading, points, level = null, displacementUnavailable = false, archive = false, mixedArchive = false }: DataCardsProps) {
  const delta = dailyDeltaFromPoints(points)
  const rain = todayRain(points)
  const deltaColor = delta === null ? undefined : delta > 0.3 ? '#fbbf24' : '#8fb6d9'
  const hasLevel = typeof level === 'number' && !Number.isNaN(level)

  return (
    <div className={`data-cards ${hasLevel ? 'with-level' : ''}`}>
      <StatCard
        label="地表位移"
        value={fmtNum(reading?.D, 2)}
        unit="mm"
        hint={mixedArchive ? '归档记录 · 多来源通道' : displacementUnavailable ? '最近有效值 · 当前增量不足' : delta === null ? '累计量' : `日增 ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} mm`}
        hintColor={mixedArchive ? undefined : deltaColor}
      />
      <StatCard
        label="土壤湿度响应"
        value={fmtNum(reading?.S, 1)}
        unit="%"
        hint="相对响应 · 含水率需标定"
      />
      <StatCard
        label="倾角"
        value={fmtNum(reading?.R, 2)}
        unit="°"
        hint={`单轴 · 第二轴 ${fmtNum(reading?.P, 2)}°`}
      />
      <StatCard
        label={archive ? '回放日降雨' : '今日降雨'}
      value={fmtNum(rain, 1)}
      unit="mm"
      hint={`瞬时 ${fmtNum(reading?.RNM, 1)} mm`}
      />
      <StatCard
        label="气温 / 湿度"
        value={fmtNum(reading?.T, 1)}
        unit="℃"
        hint={`湿度 ${fmtNum(reading?.H, 0)} %`}
      />
      {hasLevel ? (
        <StatCard
          label="库水位"
          value={fmtNum(level, 2)}
          unit="m"
          hint="外部水文数据 · 非硬件通道"
        />
      ) : null}
    </div>
  )
}
