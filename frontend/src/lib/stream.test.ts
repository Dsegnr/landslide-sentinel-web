import { afterEach, describe, expect, it, vi } from 'vitest'

import { openStream, streamUrl, type StreamEvent } from './stream'

class FakeSocket {
  static instances: FakeSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3

  readyState = FakeSocket.OPEN
  onopen: (() => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }

  close() {
    this.onclose?.()
  }

  emitOpen() {
    this.onopen?.()
  }

  emitMessage(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent)
  }

  emitBrokenFrame() {
    this.onmessage?.({ data: '{不是 JSON' } as MessageEvent)
  }
}

afterEach(() => {
  FakeSocket.instances = []
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('实时事件流', () => {
  it('地址按 http/https 生成 ws/wss，并带上设备过滤', () => {
    expect(streamUrl(undefined, 'ws://localhost:8081')).toBe('ws://localhost:8081/ws/stream')
    expect(streamUrl('slope-node-01', 'ws://localhost:8081/')).toBe(
      'ws://localhost:8081/ws/stream?device_id=slope-node-01',
    )
    expect(streamUrl('a b', 'wss://example.com')).toBe(
      'wss://example.com/ws/stream?device_id=a%20b',
    )
    expect(streamUrl('slope-node-01', 'wss://example.com', 'tok.en-123_AB')).toBe(
      'wss://example.com/ws/stream?device_id=slope-node-01&token=tok.en-123_AB',
    )
  })

  it('收到消息解析后交给上层，坏帧被丢弃而不是崩掉大屏', () => {
    vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket)
    const events: StreamEvent[] = []
    const statuses: string[] = []
    openStream({
      onEvent: (e) => events.push(e),
      onStatus: (s) => statuses.push(s),
      base: 'ws://localhost:8081',
    })
    const socket = FakeSocket.instances[0]
    socket.emitOpen()
    socket.emitMessage({ type: 'reading', device_id: 'slope-node-01', ts: 't', reading: { D: 1 } })
    socket.emitBrokenFrame()
    socket.emitMessage({ type: 'ping', ts: 't2' })

    expect(statuses).toContain('open')
    expect(events.map((e) => e.type)).toEqual(['reading', 'ping'])
  })

  it('断线后按指数退避自动重连，close() 之后不再重连', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket)
    const handle = openStream({
      onEvent: () => {},
      base: 'ws://localhost:8081',
      maxBackoffMs: 4000,
    })
    expect(FakeSocket.instances).toHaveLength(1)

    FakeSocket.instances[0].close()          // 第一次断开 -> 1s 后重连
    vi.advanceTimersByTime(999)
    expect(FakeSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(2)

    FakeSocket.instances[1].close()          // 第二次断开 -> 2s 后重连
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.instances).toHaveLength(3)

    handle.close()
    vi.advanceTimersByTime(60000)
    expect(FakeSocket.instances).toHaveLength(3)
  })
})
