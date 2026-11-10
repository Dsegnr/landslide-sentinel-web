import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpsDevice } from '../../lib/api'
import { api } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { CopyBlock } from './OpsUi'
import GuideView from './GuideView'
import NotifyView from './NotifyView'
import TokenSecurityView from './TokenSecurityView'
vi.mock('./TelemetryCharts', () => ({ Plot: () => <div data-testid="plot" />, timeLabel: (v: string) => v }))
vi.mock('../../lib/clipboard', () => ({ copyText: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: { opsSelfcheck: vi.fn(), opsNotify: vi.fn(), opsNotifyTest: vi.fn(), opsSecurity: vi.fn() } }))
const device = { device_id: 'a', name: '设备A', measured_channels: ['D', 'P', 'T', 'S', 'RN'], token_registered: true } as OpsDevice
const notify = (configured = false) => ({ configured, kind: 'wecom', host: null, min_level: 3, queue_size: 0, recent_ok: 1, recent_fail: 1, hint: '', recent: [
  { ts: '2026-10-14T10:00:00Z', device_id: 'ok-device', action: 'created', level: 3, kind: 'wecom', ok: true, detail: 'delivered' },
  { ts: '2026-10-14T11:00:00Z', device_id: 'fail-device', action: 'created', level: 4, kind: 'wecom', ok: false, detail: 'timeout' },
] })
describe('operations workspace interactions', () => {
  beforeEach(() => vi.clearAllMocks())
  it('copy button reports actual success and failure', async () => {
    vi.mocked(copyText).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    render(<CopyBlock title="协议" text="example" />)
    await userEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(await screen.findByRole('status')).toHaveTextContent('复制失败')
    await userEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(await screen.findByRole('button', { name: '已复制' })).toBeInTheDocument()
  })
  it('D and DIST examples are mutually exclusive and never include unmeasured millimetre rain', async () => {
    vi.mocked(api.opsSelfcheck).mockResolvedValue({ device_id: 'a', known: true, name: '设备A', token_registered: true, declared_channels: [], base_url: 'https://example.test', endpoints: { check: 'https://example.test/check', push: 'https://example.test/push' }, sample: { device_id: 'a', ts: 'x', channels: {} }, headers: {}, notes: [] })
    render(<GuideView devices={[device]} current={device} onSelect={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /3 发送采样数据/ }))
    await waitFor(() => expect(document.querySelector('pre')?.textContent).toContain('"D": 10'))
    expect(document.querySelector('pre')?.textContent).not.toContain('RNM')
    await userEvent.click(screen.getByRole('button', { name: '兼容原始 DIST' }))
    expect(document.querySelector('pre')?.textContent).toContain('"DIST": 890')
    expect(document.querySelector('pre')?.textContent).not.toContain('"D":')
    await userEvent.click(screen.getByText('字段字典与单位约定'))
    await userEvent.type(screen.getByLabelText('查找字段'), 'RNM')
    expect(screen.getByRole('cell', { name: '周期降雨量' })).toBeInTheDocument()
  })
  it('notification result filter only shows requested outcomes', async () => {
    vi.mocked(api.opsNotify).mockResolvedValue(notify())
    render(<NotifyView isAdmin={false} />)
    await screen.findByText('ok-device')
    await userEvent.click(screen.getByRole('button', { name: '失败' }))
    expect(screen.queryByText('ok-device')).toBeNull()
    expect(screen.getByText('fail-device')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送渠道自检消息' })).toBeDisabled()
    expect(api.opsNotifyTest).not.toHaveBeenCalled()
  })
  it('unconfigured channels disable sending even for admin', async () => {
    vi.mocked(api.opsNotify).mockResolvedValue(notify())
    render(<NotifyView isAdmin />)
    await screen.findByText('未配置')
    expect(screen.getByRole('button', { name: '发送渠道自检消息' })).toBeDisabled()
  })
  it('configured admin self-check uses the mocked sender once', async () => {
    vi.mocked(api.opsNotify).mockResolvedValue(notify(true))
    vi.mocked(api.opsNotifyTest).mockResolvedValue({ ok: true, detail: 'mock only' })
    render(<NotifyView isAdmin />)
    const button = screen.getByRole('button', { name: '发送渠道自检消息' })
    await waitFor(() => expect(button).toBeEnabled())
    await userEvent.click(button)
    expect(await screen.findByRole('status')).toHaveTextContent('发送成功')
    expect(api.opsNotifyTest).toHaveBeenCalledTimes(1)
  })
  it('no reception audit is not described as a stable source', async () => {
    vi.mocked(api.opsSecurity).mockResolvedValue({ tokens: [{ device_id: 'a', name: '设备A', token_registered: false, last_ingest_ts: null, last_age_minutes: null, last_remote: null, sources: [], source_changed: false, audit_since: '2026-09-23' }], registered_count: 0, policy: { device_auth: '', anti_enumeration: '', login_lock: { max_failures: 5, lock_seconds: 300, scope: '' }, jwt_expire_minutes: 240, admin_entry: '', token_rotation: '' }, note: '' })
    render(<TokenSecurityView devices={[device]} />)
    expect(await screen.findByText('暂无审计')).toBeInTheDocument()
    expect(screen.queryByText('稳定')).toBeNull()
    expect(screen.getByText('该设备暂无接收审计，尚不能判断来源变化。')).toBeInTheDocument()
  })
})
