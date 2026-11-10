/** 给地图准备"天气图层"：按点位取真实天气 → 图标 / 颜色 / 悬停详情。

 *  数据是**真实动态天气**（后端 Open-Meteo，10 分钟缓存），与其它模拟数据区分开；
 *  取不到就安静地不显示该点，不弹错、不阻塞地图。
 */
import { useEffect, useMemo, useState } from 'react'

import type { WeatherMark } from '../components/ChinaMap'
import { api, type WeatherResponse } from '../lib/api'
import { severityColor, weatherIcon, weatherLine } from '../lib/weatherIcon'

export interface WeatherPoint {
  key: string
  name: string
  lon: number
  lat: number
}

function toMark(p: WeatherPoint, w?: WeatherResponse): WeatherMark | null {
  if (!w || !w.available) return null
  const lines = [
    weatherLine(w),
    `未来 24 小时降雨 ${(w.rain24h ?? 0).toFixed(1)} mm｜72 小时 ${(w.rain72h ?? 0).toFixed(1)} mm`,
    `关注权重参比 +${(w.weight_bonus ?? 0).toFixed(2)}`,
    w.risk_note ?? '',
    `${w.source === 'open-meteo' ? 'Open-Meteo' : w.source}${w.stale ? '（缓存结果）' : ''}`,
  ].filter((s) => s && s.length > 0)
  return {
    key: p.key,
    name: p.name,
    lon: p.lon,
    lat: p.lat,
    icon: weatherIcon(w.code),
    color: severityColor(w.severity),
    lines,
    severity: w.severity ?? 0,
  }
}

export function useWeatherMarks(points: WeatherPoint[], intervalMs = 10 * 60 * 1000): WeatherMark[] {
  const [data, setData] = useState<Record<string, WeatherResponse>>({})
  const signature = points.map((p) => `${p.key}@${p.lon.toFixed(2)},${p.lat.toFixed(2)}`).join('|')

  useEffect(() => {
    let alive = true
    const load = async () => {
      const next: Record<string, WeatherResponse> = {}
      try {
        // 一次批量取回所有点位的天气。
        // 为什么不再逐个请求：地图上有 20+ 个点位，每个点位一个请求，走公网时
        // 每个请求有近 1 秒固定往返，光天气图层就要三四秒（实测大屏 24 次
        // /api/weather）。后端 /api/weather/batch 用的是同一个取数函数、同一套
        // 缓存与降级，返回的 weather 结构与单点接口一致，所以标记内容不变。
        // 只有 1 个点位时仍走单点接口（少拼一次参数，行为完全等价）。
        if (points.length === 1) {
          const only = points[0]
          try {
            next[only.key] = await api.weather(only.lon, only.lat)
          } catch {
            // 拿不到就安静地不显示该点，和批量的失败处理一致
          }
        } else if (points.length > 1) {
          const res = await api.weatherBatch(points.map((p) => ({ lon: p.lon, lat: p.lat })))
          // items 与传入点位一一对应；仍按坐标兜底匹配一次，避免后端顺序若变化时张冠李戴
          const byCoord = new Map<string, WeatherResponse>()
          for (const item of res.items) {
            byCoord.set(`${item.lon.toFixed(2)},${item.lat.toFixed(2)}`, item.weather)
          }
          points.forEach((p, i) => {
            const w = res.items[i]?.weather
              ?? byCoord.get(`${p.lon.toFixed(2)},${p.lat.toFixed(2)}`)
            if (w) next[p.key] = w
          })
        }
      } catch {
        // 批量接口挂了就退回逐点请求 —— 与改造前完全一样：单点失败只丢那一个点，
        // 其余照常显示。天气图层绝不能影响地图与预警。
        const results = await Promise.allSettled(
          // 包一层 Promise.resolve().then：即使 api.weather 本身抛错（例如测试里没 mock），
          // 也会变成 rejected promise 被 allSettled 吃掉，不会冒出未处理的异常
          points.map((p) => Promise.resolve().then(() => api.weather(p.lon, p.lat))),
        )
        results.forEach((r, i) => {
          if (r.status === 'fulfilled') next[points[i].key] = r.value
        })
      }
      if (!alive) return
      setData(next)
    }
    load()
    const timer = setInterval(load, intervalMs)
    return () => { alive = false; clearInterval(timer) }
    // points 每次渲染都是新数组，用签名判断是否真的变了
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, intervalMs])

  return useMemo(
    () => points.map((p) => toMark(p, data[p.key])).filter((m): m is WeatherMark => m !== null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature, data],
  )
}
