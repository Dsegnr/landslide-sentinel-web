// 实时事件流客户端：连后端 `/ws/stream`，断线自动重连（指数退避）。
// 设计取舍：推送只做"有变化"的通知与增量，**不替代**接口轮询——
// WebSocket 断了大屏还能靠轮询继续跑，这是比赛现场最要紧的保底。

export interface ReadingEvent {
  type: 'reading'
  device_id: string
  ts: string
  reading: Record<string, number>
}

export interface PredictionEvent {
  type: 'prediction'
  device_id: string
  ts: string | null
  mode: string
  sentinel_level: number
  forecast_level: number | null
  combined_level: number
  stage: string
  advice: string
  p7: number | null
  p30: number | null
  notes: string[]
  alert_action: string | null
  alert_id: number | null
}

export interface AlertAckEvent {
  type: 'alert_ack'
  alert_id: number
  device_id: string
  by: string
  ts: string
}

export interface HelloEvent {
  type: 'hello'
  ts: string
  clients: number
  device_filter: string | null
}

export interface PingEvent {
  type: 'ping'
  ts: string
}

export type StreamEvent =
  | ReadingEvent | PredictionEvent | AlertAckEvent | HelloEvent | PingEvent

export type StreamStatus = 'connecting' | 'open' | 'closed'

export function streamUrl(deviceId?: string, base?: string, token?: string | null): string {
  const origin = base ?? (typeof location === 'undefined'
    ? 'ws://localhost:8081'
    : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`)
  const url = `${origin.replace(/\/$/, '')}/ws/stream`
  // 手写拼参而不是 URLSearchParams：后者会把空格编成 '+'，虽然合法，
  // 但不同服务端解析口径不一，用 encodeURIComponent 更可预期
  const parts: string[] = []
  if (deviceId) parts.push(`device_id=${encodeURIComponent(deviceId)}`)
  if (token) parts.push(`token=${encodeURIComponent(token)}`)   // WS 不能带请求头，只能走 query
  const query = parts.join('&')
  return query ? `${url}?${query}` : url
}

export interface StreamOptions {
  onEvent: (event: StreamEvent) => void
  onStatus?: (status: StreamStatus) => void
  deviceId?: string
  token?: string | null
  base?: string
  maxBackoffMs?: number
}

export interface StreamHandle {
  close: () => void
}

export function openStream(options: StreamOptions): StreamHandle {
  const { onEvent, onStatus, deviceId, token, base, maxBackoffMs = 15000 } = options
  let socket: WebSocket | null = null
  let stopped = false
  let attempt = 0
  let timer: number | null = null

  const connect = () => {
    if (stopped) return
    onStatus?.('connecting')
    socket = new WebSocket(streamUrl(deviceId, base, token))
    socket.onopen = () => {
      attempt = 0
      onStatus?.('open')
    }
    socket.onmessage = (message: MessageEvent) => {
      try {
        onEvent(JSON.parse(String(message.data)) as StreamEvent)
      } catch {
        // 坏帧直接丢，不能因为一条脏数据让大屏崩掉
      }
    }
    socket.onclose = () => {
      onStatus?.('closed')
      if (stopped) return
      const delay = Math.min(maxBackoffMs, 1000 * 2 ** attempt)
      attempt += 1
      timer = window.setTimeout(connect, delay)
    }
    socket.onerror = () => socket?.close()
  }

  connect()
  return {
    close: () => {
      stopped = true
      if (timer !== null) window.clearTimeout(timer)
      socket?.close()
    },
  }
}
