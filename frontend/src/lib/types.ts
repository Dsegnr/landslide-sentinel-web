// 与后端接口一一对应的类型（见 web/backend/routers/*.py）。

// 分级：0 平静 / 1 关注 / 2 预警 / 3 高度预警 / 4 警报
export type Level = 0 | 1 | 2 | 3 | 4

export interface Reading {
  R: number | null
  P: number | null
  T: number | null
  H: number | null
  /** 雨量感应强度 %（0–100，平面雨量传感器：表面湿润程度） */
  RN: number | null
  /** 降雨量 mm（本采样周期累计；模型特征用的就是它） */
  RNM: number | null
  S: number | null
  D: number | null
}

export interface PredictionBrief {
  combined_level: number
  stage: string
  sentinel_level: number
  forecast_level: number | null
  p7: number | null
  p30: number | null
  ts: string
  /**
   * 这一行的等级是否真的算得出来。false = 近 24 h 没有可用的位移增量，
   * 等级未更新 —— 界面必须显示"数据不足"，**不能显示"平静/正常监测"**。
   * 老数据可能没有这个字段，缺省按 true 处理。
   */
  data_available?: boolean
}

export interface DeviceInfo {
  presentation?: { at: string; kind: 'archive' | 'simulation'; label: string; aggregation: string }
  device_id: string
  name: string
  // full = 有库水位（双时间尺度融合）；sentinel_only = 仅硬件通道（当下分级）
  mode: 'full' | 'sentinel_only'
  lon: number | null
  lat: number | null
  has_level: boolean
  station_id: string | null
  level_m: number | null
  level_days: number
  /** 水位相对最新读数滞后几天（水文数据通常晚一天到） */
  level_lag_days: number | null
  is_demo: boolean
  latest_ts: string | null
  reading: Reading | null
  /**
   * 逐通道来源：hardware = 硬件实测；simulation = 同口径补齐；unknown = 加列前的历史行。
   * 后端按通道各取"最近一次有值"的读数拼出 reading，所以同一台设备的
   * 不同通道可能来源不同——必须逐通道标注，不能一句话概括。
   */
  reading_sources?: Record<string, string | null>
  prediction: PredictionBrief | null
  open_alerts: number
  acked_alerts: number
}

export interface DevicesResponse {
  count: number
  items: DeviceInfo[]
  tuya_configured: boolean
}

export interface SeriesPoint extends Reading {
  ts: string
  /** 库水位（m）：只有关联了水位站才有值，其余为 null */
  level: number | null
}

export interface SeriesPrediction {
  ts: string
  sentinel_level: number
  forecast_level: number
  combined_level: number
  stage: string
  p7: number | null
  p30: number | null
  data_available?: boolean
}

export interface SeriesResponse {
  device_id: string
  days: number
  count: number
  station_id: string | null
  mode: 'full' | 'sentinel_only'
  items: SeriesPoint[]
  predictions: SeriesPrediction[]
}

export type AlertStatus = 'open' | 'acked' | 'cleared'

export interface AlertItem {
  id: number
  device_id: string
  ts: string
  level: number
  stage: string
  reason: string
  status: AlertStatus
  acked_by: string
  acked_at: string | null
}

export interface AlertsResponse {
  count: number
  items: AlertItem[]
}

/** 现场滑坡记录（后端 field_records 表） */
export interface FieldRecord {
  id: number
  point_name: string
  device_id: string
  level: string
  note: string
  photo_url: string | null
  observed_at: string
  created_by: string
  created_at: string
}

export interface RecordsResponse {
  count: number
  items: FieldRecord[]
}

/** 地图上的点位：设备节点（source=device）或人工新增（source=manual） */
export interface MapNode {
  data_available?: boolean
  id: number | string
  device_id?: string
  name: string
  lon: number
  lat: number
  level: number
  stage: string
  weight: number
  watch: boolean
  note: string
  /** device=监测设备 / manual=人工新增警告点 / site=数据集站点（现场页用） */
  source: 'device' | 'manual' | 'site'
  active: boolean
  mode?: string
  /** 数据集站点专用：状态文案与配色、位置描述 */
  status?: string
  tone?: 'ok' | 'warn' | 'muted'
  location?: string
  created_by?: string
  created_at?: string
  updated_at?: string
}

export interface MapSummary {
  max_level: number
  max_stage: string
  weighted_score: number
  watch_count: number
  manual_count: number
  device_count: number
  level_counts: Record<string, number>
}

export interface MapOverview {
  count: number
  nodes: MapNode[]
  manual: MapNode[]
  summary: MapSummary
}
