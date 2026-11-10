import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LastReceptionTime from './LastReceptionTime'
afterEach(() => { vi.useRealTimers() })
describe('truthful reception timestamp', () => {
  it('shows seconds and updates only elapsed age every five seconds without inventing a new reception', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-01T00:00:10Z'))
    const { container, rerender, unmount } = render(<LastReceptionTime timestamp="2026-11-01T00:00:00Z" ready />)
    expect(container.querySelector('time')).toHaveTextContent('08:00:00')
    expect(screen.getByText('距上次接收 10秒')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(screen.getByText('距上次接收 15秒')).toBeInTheDocument()
    expect(container.querySelector('time')).toHaveAttribute('datetime', '2026-11-01T00:00:00Z')
    expect(container.querySelector('time')).toHaveTextContent('08:00:00')
    rerender(<LastReceptionTime timestamp="2026-11-01T00:00:15Z" ready />)
    expect(container.querySelector('time')).toHaveTextContent('08:00:15')
    expect(screen.getByText('刚刚收到')).toBeInTheDocument()
    unmount(); expect(vi.getTimerCount()).toBe(0)
  })
  it('leaves a missing reception empty instead of showing the current clock', () => {
    const { container } = render(<LastReceptionTime timestamp={null} ready />)
    expect(screen.getByText('尚无记录')).toBeInTheDocument()
    expect(container.querySelector('time')).toBeNull()
  })
})
