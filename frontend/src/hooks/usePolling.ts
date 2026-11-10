import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError } from '../lib/api'

export interface PollingResult<T> {
  data: T | null
  error: string
  /** HTTP 状态码（0 = 网络层失败），用于把 401 交给登录态处理 */
  errorStatus: number
  // 最近一次成功刷新的时间戳（ms），用于"x 秒前更新"
  updatedAt: number
  loading: boolean
  refresh: () => void
}

// 定时轮询 + 手动刷新。
// 说明：P6 会换成 WebSocket 推送，这里的轮询是"没有推送也能跑"的保底路径。
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  deps: readonly unknown[] = [],
  enabled = true,
): PollingResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [errorStatus, setErrorStatus] = useState(0)
  const [updatedAt, setUpdatedAt] = useState(0)
  const [nonce, setNonce] = useState(0)

  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  // 代次号：依赖变了或组件卸载就 +1，让"在飞的旧请求"作废。
  // 为什么不用简单的 alive 布尔量：现在"立即取数"和"定时轮询"是两个 effect，
  // 共用一个布尔量时，依赖一变（例如从设备 A 切到 B），A 的迟到响应会被当成
  // 有效结果写进去，页面就会显示成别的设备的数据。用代次号不会有这个问题。
  const genRef = useRef(0)

  const tick = useCallback(async (gen: number) => {
    try {
      const next = await fetcherRef.current()
      if (gen !== genRef.current) return
      setData(next)
      setError('')
      setErrorStatus(0)
      setUpdatedAt(Date.now())
    } catch (err) {
      if (gen !== genRef.current) return
      setError(err instanceof Error ? err.message : String(err))
      setErrorStatus(err instanceof ApiError ? err.status : 0)
    }
  }, [])

  // 立即取数：只在"取什么"变了（手动 refresh、或依赖项变化）时触发。
  // **间隔变化不在这里** —— 见下面那个 effect 的注释。
  useEffect(() => {
    const gen = (genRef.current += 1)
    if (enabled) void tick(gen)
    return () => {
      genRef.current += 1
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, nonce, ...deps])

  // 只负责"按什么节奏轮询"。间隔变化时**不再立刻重取一次**：
  // 大屏的 pollMs 跟着实时推送状态走（连上是 30s、没连上是 8s），
  // WebSocket 一连上间隔就变，原实现会把 devices / alerts / series / map
  // 当场全部重打一遍 —— 实测同一秒里成对出现，一次页面加载白打四五个请求。
  useEffect(() => {
    if (!enabled) return
    const id = window.setInterval(() => void tick(genRef.current), intervalMs)
    return () => window.clearInterval(id)
  }, [enabled, intervalMs, tick])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  return { data, error, errorStatus, updatedAt, loading: data === null && error === '', refresh }
}
