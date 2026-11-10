import { afterEach, describe, expect, it } from 'vitest'

import { clearSession, loadSession, roleLabel, saveSession } from './auth'

afterEach(() => {
  localStorage.clear()
})

describe('登录态存取', () => {
  it('保存后能读回，退出后清空', () => {
    const session = saveSession({ token: 't-123', role: 'admin', name: '管理人员', expires_in: 3600 })
    expect(session.role).toBe('admin')
    expect(loadSession()).toEqual({ token: 't-123', role: 'admin', name: '管理人员' })
    clearSession()
    expect(loadSession()).toBeNull()
  })

  it('本地被塞了脏数据时当作未登录，而不是让大屏崩掉', () => {
    localStorage.setItem('sentinel.session', '{不是 JSON')
    expect(loadSession()).toBeNull()
    localStorage.setItem('sentinel.session', JSON.stringify({ token: '', role: 'user' }))
    expect(loadSession()).toBeNull()
    localStorage.setItem('sentinel.session', JSON.stringify({ token: 'x', role: 'root' }))
    expect(loadSession()).toBeNull()
  })

  it('角色文案', () => {
    expect(roleLabel('admin')).toBe('管理人员')
    expect(roleLabel('user')).toBe('普通用户')
  })
})
