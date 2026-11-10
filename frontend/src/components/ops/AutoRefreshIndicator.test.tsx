import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AutoRefreshIndicator from './AutoRefreshIndicator'
afterEach(() => { vi.useRealTimers() })
describe('automatic refresh indicator', () => {
  it('counts down against the real scheduled deadline and shows independent loading', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-01T00:00:00Z'))
    const deadline = Date.now() + 2000
    const { rerender, unmount } = render(<AutoRefreshIndicator nextPollAt={deadline} interval={2000} busy={false} enabled />)
    expect(screen.getByLabelText('下次自动核对 2 秒')).toHaveTextContent('2')
    await act(async () => { await vi.advanceTimersByTimeAsync(1100) })
    expect(screen.getByLabelText('下次自动核对 1 秒')).toHaveTextContent('1')
    rerender(<AutoRefreshIndicator nextPollAt={deadline} interval={2000} busy enabled />)
    expect(screen.getByLabelText('自动核对中')).toHaveClass('checking')
    rerender(<AutoRefreshIndicator nextPollAt={0} interval={2000} busy={false} enabled={false} />)
    expect(screen.getByLabelText('自动核对暂停')).toHaveTextContent('核对暂停')
    unmount(); expect(vi.getTimerCount()).toBe(0)
  })
})
