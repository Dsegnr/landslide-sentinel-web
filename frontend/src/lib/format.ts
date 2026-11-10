// 展示层格式化工具。时间戳统一是后端给的 UTC ISO（带 Z），显示时转本地时间。

export function fmtNum(value: number | null | undefined, digits = 2, unit = ''): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${value.toFixed(digits)}${unit}`
}

/** HTML 转义：把用户可控文本放进 ECharts tooltip 等 HTML 模板前必须调用。

 *  为什么必须有：ECharts 的 tooltip 会把字符串当 HTML 渲染，
 *  而点位名称/备注是用户（管理员）填的——不转义就是一条**存储型 XSS** 路径。
 *  （React 的 JSX 文本插值本身是安全的，但拼进 HTML 字符串就绕过了转义。）
 */
export function escapeHtml(text: unknown): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function fmtPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${(value * 100).toFixed(digits)}%`
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function toDate(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

// 本地时间 MM-DD HH:mm
export function fmtShort(iso: string | null | undefined): string {
  const d = toDate(iso)
  if (!d) return '—'
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 本地时间 MM-DD
export function fmtDay(iso: string | null | undefined): string {
  const d = toDate(iso)
  if (!d) return '—'
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// 本地时间 YYYY-MM-DD HH:mm:ss
export function fmtFull(iso: string | null | undefined): string {
  const d = toDate(iso)
  if (!d) return '—'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// 本地自然日的 key，用于"今日降雨"这类按天累计的展示
export function dayKey(iso: string | null | undefined): string {
  const d = toDate(iso)
  if (!d) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function fmtAgo(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '—'
  const sec = Math.max(0, Math.round((now - ms) / 1000))
  if (sec < 5) return '刚刚'
  if (sec < 60) return `${sec} 秒前`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  return `${Math.floor(min / 60)} 小时前`
}

// 一组点里的位移日增量（mm/d），用于数据卡"日增"
export function dailyDelta(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && !Number.isNaN(v))
  if (nums.length < 2) return null
  return nums[nums.length - 1] - nums[nums.length - 2]
}

// 按本地自然日聚合后的位移日增量：
// 硬件是分钟级采样，直接用末尾两条读数相减会恒为 0（同一天内的微小变化），
// 所以要先"取每日最后一条"、再算相邻两天之差，这才是论文里的日增量口径。
export function dailyDeltaFromPoints(
  points: Array<{ ts: string; D: number | null }>,
): number | null {
  const byDay = new Map<string, number>()
  for (const p of points) {
    if (typeof p.D !== 'number' || Number.isNaN(p.D)) continue
    const key = dayKey(p.ts)
    if (key) byDay.set(key, p.D)
  }
  const values = [...byDay.keys()].sort().map((k) => byDay.get(k) as number)
  if (values.length < 2) return null
  return values[values.length - 1] - values[values.length - 2]
}

// 按本地自然日取"当日最高预警等级"，用于等级演进柱状图（避免分钟级预测刷屏）
export function dailyMaxLevel<T extends { ts: string; combined_level: number; stage: string; data_available?: boolean }>(
  predictions: T[],
): Array<{ day: string; ts: string; level: number; stage: string }> {
  const map = new Map<string, { day: string; ts: string; level: number; stage: string }>()
  for (const p of predictions) {
    if (p.data_available === false) continue
    const key = dayKey(p.ts)
    if (!key) continue
    const prev = map.get(key)
    if (!prev || p.combined_level >= prev.level) {
      map.set(key, { day: key, ts: p.ts, level: p.combined_level, stage: p.stage })
    }
  }
  return [...map.values()].sort((a, b) => (a.day < b.day ? -1 : 1))
}

// 按本地自然日累计降雨（mm）：与算法侧口径一致——论文里的 rain 就是"日累计"，
// 而实时读数给的是"本采样周期内的降雨量"，必须按日相加才能和日尺度历史放在一张图上。
export function dailyRain(
  points: Array<{ ts: string; RNM: number | null }>,
): Array<{ ts: string; mm: number }> {
  const map = new Map<string, { ts: string; mm: number }>()
  for (const p of points) {
    // 降雨量只认 RNM（mm）。RN 是"雨量感应强度 %"（平面雨量传感器）——
    // 累加百分比没有物理意义，口径见 web/docs/硬件接入接口说明_v1.md。
    if (typeof p.RNM !== 'number' || Number.isNaN(p.RNM)) continue
    const key = dayKey(p.ts)
    if (!key) continue
    const prev = map.get(key)
    map.set(key, { ts: p.ts, mm: (prev?.mm ?? 0) + p.RNM })
  }
  return [...map.keys()].sort().map((k) => map.get(k) as { ts: string; mm: number })
}

// 今日降雨累计（mm）：把本地同一天的雨量读数相加
export function todayRain(points: Array<{ ts: string; RNM: number | null }>): number | null {
  if (points.length === 0) return null
  const today = dayKey(points[points.length - 1].ts)
  if (!today) return null
  let sum = 0
  let hit = false
  for (const p of points) {
    if (dayKey(p.ts) !== today) continue
    if (typeof p.RNM === 'number' && !Number.isNaN(p.RNM)) {
      sum += p.RNM
      hit = true
    }
  }
  return hit ? sum : null
}
