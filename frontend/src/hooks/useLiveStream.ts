import { useEffect, useState } from 'react'

import { openStream, type StreamEvent, type StreamStatus } from '../lib/stream'

/** 订阅后端实时事件流；失败自动重连，组件卸载时断开。 */
export function useLiveStream(enabled = true, deviceId?: string, token?: string | null) {
  const [status, setStatus] = useState<StreamStatus>('connecting')
  const [event, setEvent] = useState<StreamEvent | null>(null)

  useEffect(() => {
    if (!enabled) return
    const handle = openStream({
      deviceId,
      token,
      onEvent: setEvent,
      onStatus: setStatus,
    })
    return () => handle.close()
  }, [enabled, deviceId, token])

  return { status, event }
}
