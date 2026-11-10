// 登录态存取（浏览器端）。
// 口径：两种身份 —— user（看大屏，只读）/ admin（管理人员密钥进入，可确认告警）。

export type Role = 'user' | 'admin'

export interface Session {
  token: string
  role: Role
  name: string
}

export interface LoginResult {
  token: string
  role: Role
  name: string
  expires_in: number
}

const KEY = 'sentinel.session'

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Session
    if (!parsed?.token || (parsed.role !== 'user' && parsed.role !== 'admin')) return null
    return parsed
  } catch {
    return null
  }
}

export function saveSession(result: LoginResult): Session {
  const session: Session = { token: result.token, role: result.role, name: result.name }
  localStorage.setItem(KEY, JSON.stringify(session))
  return session
}

export function clearSession(): void {
  localStorage.removeItem(KEY)
}

export function roleLabel(role: Role | undefined): string {
  return role === 'admin' ? '管理人员' : '普通用户'
}
