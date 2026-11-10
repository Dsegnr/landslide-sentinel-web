import { afterEach, describe, expect, it, vi } from 'vitest'

import { copyText } from './clipboard'

// 背景：局域网入口是 http，`navigator.clipboard` 在非安全上下文里不存在。
// 这个测试守住"两条路都要能复制，且失败要如实返回 false"。
describe('copyText', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('安全上下文：用剪贴板 API', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    expect(await copyText('https://example.test/')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('https://example.test/')
  })

  it('http 下没有 clipboard：退回 execCommand，并返回真实结果', async () => {
    vi.stubGlobal('navigator', {})            // 非安全上下文就是这个样子
    const exec = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
    expect(await copyText('curl -H "X-Device-Token: ..."')).toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
  })

  it('剪贴板 API 抛错（用户拒绝）时也要走兜底', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) },
    })
    const exec = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
    expect(await copyText('x')).toBe(true)
    expect(exec).toHaveBeenCalled()
  })

  it('两条路都不行时返回 false（界面据此显示"复制失败"，不能谎报成功）', async () => {
    vi.stubGlobal('navigator', {})
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true })
    expect(await copyText('x')).toBe(false)
  })
})
