import type { EChartsOption } from 'echarts'
import { useEffect, useRef } from 'react'

import { echarts } from '../lib/echarts'

// 把 ECharts 实例的创建/更新/销毁与容器尺寸变化接起来。
export function useECharts(
  option: EChartsOption,
  onClick?: (params: unknown, chart: ReturnType<typeof echarts.init>) => void,
  onZrClick?: (offset: [number, number], chart: ReturnType<typeof echarts.init>) => void,
) {
  const container = useRef<HTMLDivElement | null>(null)
  const chart = useRef<ReturnType<typeof echarts.init> | null>(null)
  const clickRef = useRef(onClick)
  clickRef.current = onClick
  const zrClickRef = useRef(onZrClick)
  zrClickRef.current = onZrClick

  useEffect(() => {
    const el = container.current
    if (!el) return
    const instance = echarts.init(el)
    chart.current = instance
    instance.on('click', (params) => clickRef.current?.(params, instance))
    // 底层点击：ECharts 的 click 只覆盖"有数据的图元"，点在地图空白处收不到，
    // 所以选点必须监听 zrender 事件（offsetX/offsetY 是画布坐标）。
    instance.getZr().on('click', (e: { offsetX: number; offsetY: number }) => {
      zrClickRef.current?.([e.offsetX, e.offsetY], instance)
    })
    const resize = () => instance.resize()
    window.addEventListener('resize', resize)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    observer?.observe(el)
    return () => {
      window.removeEventListener('resize', resize)
      observer?.disconnect()
      instance.dispose()
      chart.current = null
    }
  }, [])

  useEffect(() => {
    chart.current?.setOption(option, true)
  }, [option])

  return container
}
