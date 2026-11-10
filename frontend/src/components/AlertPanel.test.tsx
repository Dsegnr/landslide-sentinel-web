import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import AlertPanel from './AlertPanel'
import type { AlertItem } from '../lib/types'

const DEVICE_NAME = (id: string) => (id === 'slope-node-01' ? '边坡复合监测节点 01' : id)
const LEVEL_NULL = () => null

const ALERTS: AlertItem[] = [
  {
    id: 1, device_id: 'slope-node-01', ts: '2026-09-13T23:00:00Z', level: 4, stage: '警报',
    reason: "哨兵=2 通道=['disp']；升级：哨兵=4 通道=['disp']", status: 'open',
    acked_by: '', acked_at: null,
  },
  {
    id: 2, device_id: 'slope-node-02', ts: '2026-09-01T01:00:00Z', level: 2, stage: '预警',
    reason: '哨兵=2 通道=[disp]', status: 'acked', acked_by: 'admin@test',
    acked_at: '2026-09-01T02:00:00Z',
  },
]

describe('告警台账', () => {
  it('默认只显示未处理告警，并显示未处理计数', () => {
    render(<AlertPanel alerts={ALERTS} deviceName={DEVICE_NAME} currentLevel={LEVEL_NULL} canAck
                       onAck={vi.fn()} busyId={null} />)
    expect(screen.getByText('警报')).toBeInTheDocument()
    expect(screen.getByText('边坡复合监测节点 01')).toBeInTheDocument()
    expect(screen.queryByText('预警')).not.toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('点确认处置会把告警 id 交给上层', async () => {
    const onAck = vi.fn()
    render(<AlertPanel alerts={ALERTS} deviceName={DEVICE_NAME} currentLevel={LEVEL_NULL} canAck
                       onAck={onAck} busyId={null} />)
    await userEvent.click(screen.getByRole('button', { name: '确认处置' }))
    expect(onAck).toHaveBeenCalledWith(1)
  })

  it('切到"已确认"标签能看到处置人，且不再出现确认按钮', async () => {
    render(<AlertPanel alerts={ALERTS} deviceName={DEVICE_NAME} currentLevel={LEVEL_NULL} canAck
                       onAck={vi.fn()} busyId={null} />)
    await userEvent.click(screen.getByRole('button', { name: /已确认/ }))
    expect(screen.getByText(/由 admin@test 确认/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '确认处置' })).not.toBeInTheDocument()
  })

  it('没有告警时给出空状态而不是空白', () => {
    render(<AlertPanel alerts={[]} deviceName={DEVICE_NAME} currentLevel={LEVEL_NULL} canAck
                       onAck={vi.fn()} busyId={null} />)
    expect(screen.getByText('当前没有未处理告警')).toBeInTheDocument()
  })

  it('当前等级已回落时，明确标注"这是本轮峰值"而不是让人以为数字对不上', () => {
    render(
      <AlertPanel
        alerts={ALERTS}
        deviceName={DEVICE_NAME}
        currentLevel={() => 2}
        canAck
        onAck={vi.fn()}
        busyId={null}
      />,
    )
    expect(screen.getByText(/本记录是本轮事件的峰值，当前已回落至 预警/)).toBeInTheDocument()
  })

  it('普通用户（canAck=false）看不到确认按钮，并提示需要管理人员密钥', () => {
    render(<AlertPanel alerts={ALERTS} deviceName={DEVICE_NAME} currentLevel={LEVEL_NULL}
                       canAck={false} onAck={vi.fn()} busyId={null} />)
    expect(screen.queryByRole('button', { name: '确认处置' })).not.toBeInTheDocument()
    expect(screen.getByText(/确认处置需管理人员密钥入口/)).toBeInTheDocument()
  })
})
