// 分级口径的唯一来源（前端展示用）。
// 必须与后端 web/backend/services/predictor.py 的 LEVEL_NAME / LEVEL_ADVICE 保持一致，
// 否则会出现"后端说警报、大屏显示关注"这种答辩现场翻车。
export const LEVEL_META = [
  { name: '平静', color: '#34d399', advice: '正常监测，无需动作' },
  { name: '关注', color: '#38bdf8', advice: '加密数据巡检，留意趋势' },
  { name: '预警', color: '#fbbf24', advice: '安排现场核查，准备应急预案' },
  { name: '高度预警', color: '#fb923c', advice: '启动应急值守，限制坡下通行' },
  { name: '警报', color: '#f87171', advice: '立即避险转移并上报' },
] as const

export const MAX_LEVEL = LEVEL_META.length - 1

export function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return 0
  return Math.min(MAX_LEVEL, Math.max(0, Math.round(level)))
}

export function levelMeta(level: number) {
  return LEVEL_META[clampLevel(level)]
}

export function levelColor(level: number): string {
  return levelMeta(level).color
}

// 后端已给出 stage 时优先用后端的，避免两边口径漂移时前端自己编。
export function stageName(level: number, stage?: string | null): string {
  return stage && stage.length > 0 ? stage : levelMeta(level).name
}

// 两种运行模式下给用户的一句话解释。
export const MODE_NOTE: Record<string, string> = {
  full: '已接入库水位：输出哨兵级 + 未来 7/30 天概率的双时间尺度融合结果',
  sentinel_only: '本设备未接入库水位：只输出当下 0~4 级（不做无依据的外推）',
}
