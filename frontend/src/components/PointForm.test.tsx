import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const createPoint = vi.fn(async (_body: Record<string, unknown>) => ({ ok: true, point: { id: 1 } }))
vi.mock('../lib/api', () => ({
  api: { createPoint: (body: Record<string, unknown>) => createPoint(body) },
  setAuthToken: vi.fn(),
  ApiError: class extends Error { status = 0 },
  AuthError: class extends Error {},
}))

import PointForm from './PointForm'

beforeEach(() => {
  createPoint.mockClear()
})

describe('人工新增警告点位', () => {
  it('带上地图点击的经纬度，并把等级/权重/关注一起提交', async () => {
    const onDone = vi.fn()
    render(<PointForm lonLat={[110.7654, 30.9876]} onDone={onDone} onCancel={vi.fn()} />)

    expect(screen.getByText(/30.9876, 110.7654/)).toBeInTheDocument()   // 显示为 纬, 经
    await userEvent.type(screen.getByPlaceholderText(/巡检发现裂缝点/), '坡脚裂缝点')
    await userEvent.selectOptions(screen.getByRole('combobox'), '3')
    // 权重滑到 2.0（range 用 fireEvent.change，userEvent.clear 对滑杆不适用）
    fireEvent.change(screen.getByRole('slider'), { target: { value: '2' } })
    await userEvent.click(screen.getByRole('button', { name: '确认新增' }))

    expect(createPoint).toHaveBeenCalledTimes(1)
    const body = createPoint.mock.calls[0][0]
    expect(body.weight).toBeCloseTo(2)
    expect(body.lon).toBeCloseTo(110.7654)
    expect(body.lat).toBeCloseTo(30.9876)
    expect(body.level).toBe(3)
    expect(body.watch).toBe(true)
    expect(onDone).toHaveBeenCalled()
  })

  it('名称为空时拦住并给出提示', async () => {
    render(<PointForm lonLat={[110, 30]} onDone={vi.fn()} onCancel={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: '确认新增' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('请填写点位名称')
    expect(createPoint).not.toHaveBeenCalled()
  })
})
