/** 天气现象的图标与配色（WMO 天气码 → 图标；严重度 → 颜色）。

 *  前端只做"显现"，判定逻辑在后端（services/weather.py 的 classify_weather），
 *  这样同一套分档不会出现前后端两个版本。
 */
import type { WeatherResponse } from './api'

const WMO_ICON: Record<number, string> = {
  0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️',
  45: '🌫️', 48: '🌫️',
  51: '🌦️', 53: '🌦️', 55: '🌧️', 56: '🌧️', 57: '🌧️',
  61: '🌦️', 63: '🌧️', 65: '⛈️', 66: '🌧️', 67: '🌧️',
  71: '🌨️', 73: '🌨️', 75: '❄️', 77: '🌨️',
  80: '🌦️', 81: '🌧️', 82: '⛈️',
  85: '🌨️', 86: '❄️',
  95: '⛈️', 96: '⛈️', 99: '⛈️',
}

export function weatherIcon(code?: number | null): string {
  if (code === undefined || code === null) return '🌡️'
  return WMO_ICON[code] ?? '🌡️'
}

/** 与后端 SEVERITY_COLOR 一致：0 无 / 1 小 / 2 中 / 3 大 / 4 特大 */
export const SEVERITY_COLORS = ['#7fd4ff', '#4fc3f7', '#ffd166', '#ff8a4c', '#ff4d6d']

export function severityColor(severity?: number | null): string {
  const s = Math.max(0, Math.min(4, Math.round(severity ?? 0)))
  return SEVERITY_COLORS[s]
}

/** 降水色块配色：按雨强从浅蓝 → 亮蓝 → 绿 → 黄 → 橙（与参考图一致） */
export function precipColor(mm: number): string {
  if (mm >= 2.0) return '#fb923c'
  if (mm >= 1.0) return '#facc15'
  if (mm >= 0.5) return '#22c55e'
  if (mm >= 0.2) return '#38bdf8'
  return '#7dd3fc'
}

/** 给 tooltip / 面板用的一行摘要 */
export function weatherLine(w: WeatherResponse): string {
  if (!w.available) return '暂无天气数据'
  const now = w.now
  const parts = [
    `${w.phenomenon ?? '—'} ${w.severity_label ?? ''}`.trim(),
    now?.temp !== null && now?.temp !== undefined ? `${now.temp}℃` : '',
    now?.humidity !== null && now?.humidity !== undefined ? `湿度 ${now.humidity}%` : '',
    now?.wind !== null && now?.wind !== undefined ? `风速 ${now.wind} m/s` : '',
  ].filter(Boolean)
  return parts.join(' · ')
}
