import type { LoginResult } from './auth'
import { resetOpsSnapshots } from './opsSnapshots'
import type {
  AlertsResponse, DevicesResponse, FieldRecord, MapNode, MapOverview,
  RecordsResponse, SeriesResponse,
} from './types'

// 基地址：默认空字符串（同源 + vite/nginx 代理 /api）。
// 需要直连后端时用 VITE_API_BASE=http://localhost:8081。
const BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '')

/** 二维码图片地址（后端渲染成 SVG）：只编码纯文本，前端不引二维码库。 */
export const qrSvgUrl = (text: string, scale = 6) =>
  `${BASE}/api/qr.svg?text=${encodeURIComponent(text)}&scale=${scale}`

/** 自助二维码（**公开**端点，零输入）：编码服务器自己的地址。
 *  登录页没有登录态、拿不到鉴权头，所以它必须走这个不需要登录的端点。 */
export const qrSvgSelfUrl = (scale = 6) => `${BASE}/api/qr/self.svg?scale=${scale}`

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** 401 单独成一类：前端据此把用户踢回登录页，而不是弹一堆报错。 */
export class AuthError extends ApiError {
  constructor(message: string) {
    super(message, 401)
    this.name = 'AuthError'
  }
}

let authToken: string | null = null

export function setAuthToken(token: string | null): void {
  if (authToken !== token) resetOpsSnapshots()
  authToken = token
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  }
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers })
  } catch (err) {
    throw new ApiError(`无法连接后端（${path}）：${(err as Error).message}`, 0)
  }
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      if (body && typeof body.detail === 'string') detail = body.detail
    } catch {
      // 后端返回非 JSON 时保留 statusText
    }
    if (res.status === 401) throw new AuthError(detail)
    throw new ApiError(`请求失败 ${res.status}：${detail}`, res.status)
  }
  return (await res.json()) as T
}

export const api = {
  login: (username: string, password: string) =>
    request<LoginResult>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
  adminLogin: (key: string) =>
    request<LoginResult>('/api/auth/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    }),
  me: () => request<{ name: string; role: string }>('/api/auth/me'),
  adminOverview: () => request<AdminOverview>('/api/admin/overview'),
  audit: (limit = 50) => request<AuditResponse>(`/api/admin/audit?limit=${limit}`),
  devices: () => request<DevicesResponse>('/api/devices'),
  // 设备与通信运维
  opsOverview: () => request<OpsOverview>('/api/ops/overview'),
  // 首屏一次取全（总览 + 设备台账 + 接入审计）。三个子接口仍在，语义完全一致，
  // 只是走公网时每次请求有近 1 秒固定往返，合成一次能把首屏从"三个往返"压到一个。
  opsSummary: () => request<OpsSummary>('/api/ops/summary'),
  opsTelemetry: (deviceId: string, query: TelemetryQuery, signal?: AbortSignal) => {
    const params = new URLSearchParams({ hours: String(query.hours), anchor: query.anchor, channels: query.channels })
    if (query.end) params.set('end', query.end)
    return request<TelemetryHistory>(`/api/ops/telemetry/${encodeURIComponent(deviceId)}?${params}`, { signal })
  },
  opsDevices: (signal?: AbortSignal) => request<{ count: number; items: OpsDevice[] }>('/api/ops/devices', { signal }),
  opsLink: (deviceId: string, hours = 72) =>
    request<OpsLink>(`/api/ops/link/${encodeURIComponent(deviceId)}?hours=${hours}`),
  opsChannels: (deviceId: string, hours = 24) =>
    request<{ device_id: string; hours: number; count: number; items: OpsChannel[] }>(
      `/api/ops/channels/${encodeURIComponent(deviceId)}?hours=${hours}`),
  opsEvents: (limit = 30) =>
    request<{ count: number; items: OpsEvent[] }>(`/api/ops/events?limit=${limit}`),
  opsSelfcheck: (deviceId: string, signal?: AbortSignal) =>
    request<OpsSelfcheck>(`/api/ops/selfcheck/${encodeURIComponent(deviceId)}`, { signal }),
  opsQuality: (deviceId: string, hours: number, anchor: 'live' | 'latest', signal?: AbortSignal) =>
    request<OpsQuality>(`/api/ops/quality/${encodeURIComponent(deviceId)}?hours=${hours}&anchor=${anchor}`, { signal }),
  opsSecurity: (signal?: AbortSignal) => request<OpsSecurity>('/api/ops/security', { signal }),
  opsSystem: (signal?: AbortSignal) => request<OpsSystem>('/api/ops/system', { signal }),
  opsNotify: (limit = 50, signal?: AbortSignal) => request<OpsNotify>(`/api/ops/notify?limit=${limit}`, { signal }),
  opsNotifyTest: () =>
    request<{ ok: boolean; detail: string }>('/api/ops/notify/test', { method: 'POST' }),
  opsCompleteness: (hours = 72) =>
    request<OpsCompleteness>(`/api/ops/completeness?hours=${hours}`),
  series: (deviceId: string, days: number) =>
    request<SeriesResponse>(`/api/sensors/${encodeURIComponent(deviceId)}?days=${days}`),
  alerts: (limit = 100) => request<AlertsResponse>(`/api/alerts?limit=${limit}`),
  records: (limit = 50) => request<RecordsResponse>(`/api/records?limit=${limit}`),
  mapOverview: () => request<MapOverview>('/api/map/overview'),
  createPoint: (body: {
    name: string; lon: number; lat: number; level: number
    weight: number; watch: boolean; note?: string
  }) => request<{ ok: boolean; point: MapNode }>('/api/points', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  updatePoint: (id: number, body: Partial<Pick<MapNode, 'name' | 'level' | 'weight' | 'watch' | 'note' | 'active'>>) =>
    request<{ ok: boolean; point: MapNode }>(`/api/points/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deletePoint: (id: number) =>
    request<{ ok: boolean }>(`/api/points/${id}`, { method: 'DELETE' }),
  createRecord: (form: FormData) =>
    request<{ ok: boolean; record: FieldRecord }>('/api/records', {
      method: 'POST',
      body: form,          // 交给浏览器自己带 multipart 边界，别手动设 Content-Type
    }),
  deleteRecord: (id: number) =>
    request<{ ok: boolean }>(`/api/records/${id}`, { method: 'DELETE' }),
  ackAlert: (id: number) =>
    request<{ ok: boolean; alert_id: number; status: string }>(
      `/api/alerts/${id}/ack`,
      { method: 'POST' },
    ),
  weather: (lon: number, lat: number) =>
    request<WeatherResponse>(`/api/weather?lon=${lon}&lat=${lat}`),
  // 批量天气：地图上有 20+ 个点位，逐个请求在公网下要三四秒。
  // 返回的 items 与传入点位**一一对应、顺序一致**，且每个元素的 weather 字段
  // 与单点接口返回的结构完全相同（同一个后端函数、同一套缓存与降级）。
  weatherBatch: (points: { lon: number; lat: number }[]) =>
    request<WeatherBatchResponse>(
      `/api/weather/batch?points=${encodeURIComponent(
        points.map((p) => `${p.lon},${p.lat}`).join(';'),
      )}`,
    ),
  weatherGrid: () => request<WeatherGridResponse>('/api/weather/grid'),
  wavePresets: () => request<WavePresetsResponse>('/api/wave/presets'),
  waveEstimate: (body: Record<string, unknown>) =>
    request<WaveEstimate>('/api/wave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  health: () => request<Record<string, unknown>>('/api/health'),
}

// 涌浪估算

/** 情景：失稳情景（两档各按原文口径算速度）/ 监测速率（外部输入，外推）。 */
export type WaveScenario = 'drop' | 'monitoring'

/** 潘家铮法（薄滑体入水）一档的结果。 */
export interface PanjiazhengRow {
  velocity_mps: number
  velocity_note: string
  zeta0_m: number
  opposite_min_m: number
  opposite_max_m: number
  celerity_mps: number
  froude: number
}

/** Heller/Fritz 族（厚滑体深水）一档。

    `applicable=false` 表示**前提不成立、该档不出数**（例如滑体质心已没入水面）——
    此时下面的数值字段**一个都没有**，页面必须按"不适用"呈现，不能显示成"波很小"。
    `in_domain=false` 是另一回事：前提成立但落在标定域外（外推）。 */
export interface HellerRow {
  applicable: boolean
  unavailable_reason: string
  /** Δz_sc = 滑体质心释放高程 − 静水面高程（可为负） */
  centroid_drop_m: number
  velocity_source: string
  velocity_mps?: number
  P?: number
  F?: number
  S?: number
  M?: number
  amplitude_max_m?: number
  height_max_m?: number
  period_s?: number
  x_max_m?: number
  primary_volume_m3?: number
  wave_type?: string
  wave_type_cn?: string
  at_opposite_m?: number
  at_opposite_uses_decay?: boolean
  in_domain?: boolean
  /** 越界的无量纲量名（F/S/M/P），非空即表示该情景是外推 */
  violations?: string[]
}

export interface WaveRow {
  scenario: WaveScenario
  label: string
  panjiazheng: PanjiazhengRow
  heller: HellerRow
}

export interface WaveEstimate {
  input: Record<string, number | null>
  rows: WaveRow[]
  /** B 档前提是否整体成立（不成立时所有行的 Heller 都不出数） */
  heller_applicable: boolean
  /** 告警口径：只有「前提成立且域内」的档才有资格进告警 */
  advisory: WaveAdvisory
  /** C 档（Watts 方块）。参数没给时为 null。**不参与告警** */
  watts: WattsSection | null
  limits: Record<string, [number, number]>
  summary: { advisory_m: number; note: string }
  preset: { id: string; name: string; note: string; unconfirmed: string[] } | null
  wave_type_cn: Record<string, string>
}

export interface WattsSection {
  applicable: boolean
  unavailable_reason: string
  idealization: string
  bib: string
  in_advisory: boolean
  in_advisory_reason: string
  mapping: {
    b_rule: string; d_rule: string; theta_rule: string
    values: { b_m: number; d_m: number; theta_deg: number }
  }
  amplitude_min_m?: number
  amplitude_max_m?: number
  amplitude_max_m_hi?: number
  lambda_o_m?: number
  deepwater?: boolean
}

export interface WaveAdvisory {
  status: 'ok' | 'extrapolated_only' | 'not_applicable'
  /** 可出结论时的保守值；`status !== 'ok'` 时为 null（不给数） */
  usable_m: number | null
  /** 0–4 级；`status !== 'ok'` 时为 null */
  level: number | null
  basis: string
  reason: string
  thresholds_m: number[]
  thresholds_source: string
}

export interface WavePreset {
  id: string
  name: string
  note: string
  unconfirmed: string[]
  input: Record<string, number>
}

export interface WavePresetsResponse {
  presets: WavePreset[]
  limits: Record<string, [number, number]>
  defaults: { rho_s_kgm3: number; alpha_deg: number; delta_deg: number }
}

export interface WeatherGridPoint {
  lon: number
  lat: number
  precip: number
  code: number
  severity: number
  phenomenon: string
}

export interface WeatherGridResponse {
  available: boolean
  source: string
  count?: number
  wet?: number
  stale?: boolean
  cached?: boolean
  error?: string
  points: WeatherGridPoint[]
}

export interface WeatherHour {
  t: string
  precip: number
  temp: number | null
}

export interface WeatherResponse {
  available: boolean
  source: string
  lon?: number
  lat?: number
  fetched_at?: string
  stale?: boolean
  cached?: boolean
  error?: string
  now?: {
    temp: number | null
    precip: number
    text: string | null
    humidity?: number | null
    wind?: number | null
    pop?: number | null
  }
  hourly?: WeatherHour[]
  rain24h?: number
  rain72h?: number
  max_hourly?: number
  weight_bonus: number
  weight_reason: string
  /** 天气现象（后端按 WMO 码 + 雨强判定） */
  code?: number
  phenomenon?: string
  severity?: number
  severity_label?: string
  severity_color?: string
  risk_note?: string
}

/** 批量天气：items 与传入点位一一对应、顺序一致。 */
export interface WeatherBatchResponse {
  count: number
  items: { lon: number; lat: number; weather: WeatherResponse }[]
}

// ===== 设备与通信运维（/api/ops/*）=====
// 这一组回答的是"设备与链路怎么样"，不是"数据是多少"。
// 注意：接口**不返回令牌原文**，只有 token_registered 这个布尔值。

export interface OpsOverview {
  devices: number
  hardware_devices: number
  online: number
  stale: number
  offline: number
  never: number
  /** 没有物理链路（纯模拟/演示点）——与"离线"是两回事，必须分开 */
  no_link: number
  registered_tokens: number
  unregistered_tokens: string[]
  readings_24h: number
  ingest_events_24h: number
  storage: {
    readings_total: number
    db_size_mb: number | null
    first_ts: string | null
    last_ts: string | null
    span_days: number | null
    readings_per_day: number | null
    note: string
  }
}

export type LinkStatus = 'online' | 'stale' | 'offline' | 'never' | 'no_link'

export interface TelemetryQuery {
  hours: number
  anchor: 'live' | 'latest' | 'at'
  channels: string
  end?: string
}
export interface TelemetryHistory {
  device_id: string; anchor: string; start: string; end: string; hours: number; bucket_seconds: number
  latest_received: string | null; latest_sample: string | null
  summary: { events: number; accepted: number; duplicated: number; samples: number }
  bins: { ts: string; events: number; accepted: number; duplicated: number; cumulative: number }[]
  heat: { ts: string; rows: number; counts: number[] }[]
  heat_channels: string[]; channels: string[]
  points: { ts: string; values: Record<string, number | null>; ranges: Record<string, (number | null)[]> }[]
  aggregation: 'raw' | 'mean_min_max'
  recent: { ts: string; accepted: number; duplicated: number; remote: string }[]
}

/** 首屏汇总：三个子接口的内容原样打包，字段与单独调用时完全一致。 */
export interface OpsSummary {
  overview: OpsOverview
  devices: { count: number; items: OpsDevice[] }
  events: { count: number; items: OpsEvent[] }
}

export interface OpsDevice {
  device_id: string
  name: string
  is_virtual: boolean
  /** DB devices 表里的持久标记：这台是否已接入真实硬件 */
  hardware_marked: boolean
  token_registered: boolean
  mode: string
  station_id: string | null
  lon: number | null
  lat: number | null
  declared_channels: string[]
  measured_channels: string[]
  missing_channels: string[]
  last_ts: string | null
  /** 最后一条**硬件推送**的时间：链路是否在线只看它 */
  last_hw_ts: string | null
  link_age_minutes: number | null
  last_age_minutes: number | null
  status: LinkStatus
  n_24h: number
}

export interface OpsLinkGap { from: string; to: string; seconds: number }

export interface OpsLink {
  device_id: string
  hours: number
  n: number
  note?: string
  delay: { p50?: number; p90?: number; max?: number; min?: number }
  delay_series?: [string, number][]
  normal_interval_s?: number
  gaps: OpsLinkGap[]
  backfill: { n: number; ratio?: number; segments: [string, number][] }
}

export type ChannelState = 'ok' | 'stuck' | 'out_of_range' | 'not_connected'

export interface OpsChannel {
  channel: string
  state: ChannelState
  n_window: number
  last_ts: string | null
  last_value: number | null
  source: string | null
  age_minutes?: number
}

export interface OpsEvent {
  device_id: string
  ts: string
  accepted: number
  duplicated: number
  remote: string
}

export interface OpsSelfcheck {
  device_id: string
  known: boolean
  name: string | null
  declared_channels: string[]
  token_registered: boolean
  base_url: string
  endpoints: { check: string; push: string }
  headers: Record<string, string>
  sample: { device_id: string; ts: string; channels: Record<string, number> }
  notes: string[]
}

// ===== 设备与通信：令牌与安全 / 运行态 / 通知 / 数据完整性 =====

export interface OpsTokenSource {
  remote: string
  n: number
  first: string
  last: string
}

export interface OpsTokenRow {
  device_id: string
  name: string
  token_registered: boolean
  last_ingest_ts: string | null
  last_age_minutes: number | null
  last_remote: string | null
  sources: OpsTokenSource[]
  source_changed: boolean
  /** 接入审计表的启用日期：早于它的推送没有记录，不能读成"从未上报" */
  audit_since: string
}

export interface OpsSecurity {
  tokens: OpsTokenRow[]
  registered_count: number
  policy: {
    device_auth: string
    anti_enumeration: string
    login_lock: { max_failures: number; lock_seconds: number; scope: string }
    jwt_expire_minutes: number
    admin_entry: string
    token_rotation: string
  }
  note: string
}

export interface OpsSystem {
  processes: Record<'app' | 'tunnel', { pid: number | null; alive: boolean; uptime_hours: number | null }>
  disk: { total_gb: number; used_gb: number; free_gb: number; used_pct: number }
  storage: OpsOverview['storage']
  backups: { file: string; mb: number; ts: string }[]
  models: { file: string; kb: number; ts: string }[]
  logs: { file: string; mb: number; ts: string }[]
  runtime: { python: string; platform: string; tz: string }
  maintenance: { prune: string; backup: string }
}

export interface OpsNotifyEvent {
  ts: string | null
  device_id: string
  action: string
  level: number
  kind: string
  ok: boolean
  detail: string
}

export interface OpsNotify {
  configured: boolean
  kind: string
  /** 只给主机名：webhook 地址里含密钥，不返回原文 */
  host: string | null
  min_level: number
  queue_size: number
  recent: OpsNotifyEvent[]
  recent_ok: number
  recent_fail: number
  hint: string
}

export interface OpsCompletenessItem {
  device_id: string
  name: string
  rows: number
  hardware: number
  simulation: number
  hardware_ratio: number
  channels: Record<string, { n: number; ratio: number }>
  gaps: { from: string; to: string; minutes: number }[]
  gap_count: number
}

export interface OpsCompleteness {
  hours: number
  items: OpsCompletenessItem[]
  note: string
}

export interface OpsQuality {
  history: TelemetryHistory
  sources: { source: string; count: number }[]
  delay: { n: number; mean: number | null; max: number | null; negative: number; late: number }
  delay_series: [string, number | null][]
  gaps: { from: string; to: string; minutes: number }[]; gap_count: number
  channels: { channel: string; last_ts: string | null; value: number | null; age_minutes: number | null; count: number; out_of_range: boolean; repeated: boolean }[]
}

export interface AdminOverview {
  now: string
  uptime_seconds: number
  devices: Array<{ device_id: string; name: string; mode: string }>
  counts: Record<string, number>
  alerts: { open: number; acked: number; cleared: number }
  reservoir: Array<{ station_id: string; n: number; latest_m: number | null }>
  ws_clients: number
  database: number | null
  operator: string
}

export interface AuditItem {
  ts: string
  action: string
  target: string
  detail: string
  by: string
}

export interface AuditResponse {
  count: number
  items: AuditItem[]
}
