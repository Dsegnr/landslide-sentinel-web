import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import TopBar from './TopBar'
const noop = () => {}
const props = { devices: [], selectedId: '', onSelect: noop, hasRealDevice: false, connected: false, streamStatus: 'connecting' as const, session: { name: 'monitor', role: 'user' as const }, onLogout: noop, route: 'dashboard' as const, onNavigate: noop, updatedAt: 0, pollError: '', onRefresh: noop }
describe('dashboard connection state', () => {
  it('initial pending data is not a backend failure', () => {
    render(<TopBar {...props} initialLoading />)
    expect(screen.getByText('正在同步数据')).toBeInTheDocument()
    expect(screen.queryByText('后端异常')).toBeNull()
  })
  it('real failures still show an error', () => {
    render(<TopBar {...props} pollError="读取失败" />)
    expect(screen.getByText('后端异常')).toBeInTheDocument()
    expect(screen.getByText('接口异常：读取失败')).toBeInTheDocument()
  })
})
