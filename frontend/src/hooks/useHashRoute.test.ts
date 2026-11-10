import { renderHook, act } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useHashRoute } from './useHashRoute'

describe('hash 路由', () => {
  it('默认为算法大屏，能切到现场页并写回 hash', () => {
    location.hash = ''
    const { result } = renderHook(() => useHashRoute())
    expect(result.current[0]).toBe('dashboard')

    act(() => result.current[1]('field'))
    expect(location.hash).toBe('#/field')
    expect(result.current[0]).toBe('field')
  })

  it('非法 hash 回落到大屏（刷新不会白屏）', () => {
    location.hash = '#/not-exist'
    const { result } = renderHook(() => useHashRoute())
    expect(result.current[0]).toBe('dashboard')
  })

  it('hash 里带查询串也能正确解析（#/field?v=1 应识别为现场页）', () => {
    location.hash = '#/field?v=1'
    const { result } = renderHook(() => useHashRoute())
    expect(result.current[0]).toBe('field')
  })
})
