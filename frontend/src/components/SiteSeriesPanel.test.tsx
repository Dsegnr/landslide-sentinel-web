import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let SiteSeriesPanel: typeof import('./SiteSeriesPanel')['default']
beforeEach(async () => { vi.resetModules(); SiteSeriesPanel=(await import('./SiteSeriesPanel')).default })

const SERIES = {
  site: 'shuiping',
  name: '树坪滑坡专业监测点',
  source: '测试数据源',
  period: ['2024-01-01', '2024-01-03'],
  level: [['2024-01-01', 145.7], ['2024-01-02', 150.2], ['2024-01-03', 148.0]] as [string, number][],
  rain: [['2024-01-01', 0], ['2024-01-02', 12.4], ['2024-01-03', 3.1]] as [string, number][],
  gps: { ZG86: [['2023-12', 5398], ['2024-01', 5404]] as [string, number][] },
}

afterEach(() => vi.unstubAllGlobals())

describe('数据集观测序列面板', () => {
  it('有导出数据时画出水位/降雨，并默认收起位移', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(SERIES) })))
    render(<SiteSeriesPanel siteId="shuiping" />)
    expect(await screen.findByText('库水位（日）')).toBeInTheDocument()
    expect(screen.getByText('降雨量（日）')).toBeInTheDocument()
    expect(screen.getByText('展开 1 个测点')).toBeInTheDocument()
    expect(screen.getByText(/测试数据源/)).toBeInTheDocument()
    // 位移默认不画，点开才出现测点名
    expect(screen.queryByText('ZG86')).not.toBeInTheDocument()
  })

  it('没有导出序列的站点明确说明缺项，不请求不存在的文件', async () => {
    const fetcher=vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const { container } = render(<SiteSeriesPanel siteId="xintan" />)
    await vi.waitFor(() => expect(container.textContent).not.toContain('正在读取'))
    expect(container.querySelector('.site-series')).toBeNull()
    expect(screen.getByText('该站点暂无已整理的连续观测序列。')).toBeInTheDocument()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('有导出序列的站点读取失败时显示可理解的提示', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 503 })))
    render(<SiteSeriesPanel siteId="shuiping" />)
    expect(await screen.findByText('观测序列暂不可用，请稍后重试。')).toBeInTheDocument()
  })
})
