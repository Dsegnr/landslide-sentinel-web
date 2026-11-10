import { useCallback, useState } from 'react'

import { api, setAuthToken } from '../lib/api'
import { clearSession, loadSession, saveSession, type Session } from '../lib/auth'

/** 登录态：普通用户（账号密码）与管理人员（密钥入口），token 存 localStorage。 */
export function useAuth() {
  const [session, setSession] = useState<Session | null>(() => loadSession())

  // 关键：必须在**渲染期间同步**把 token 交给 api 层。
  // 如果放在 useEffect 里，子组件（Dashboard）的首个请求会先跑，漏带 token -> 401 -> 被踢回登录页
  // （这个 bug 在服务器上实测踩到过：登录成功却立刻弹回登录页）。
  const token = session?.token ?? null
  if (appliedToken !== token) {
    appliedToken = token
    setAuthToken(token)
  }

  const signIn = useCallback(async (username: string, password: string) => {
    const next = saveSession(await api.login(username, password))
    setSession(next)
    return next
  }, [])

  const signInAdmin = useCallback(async (key: string) => {
    const next = saveSession(await api.adminLogin(key))
    setSession(next)
    return next
  }, [])

  const signOut = useCallback(() => {
    clearSession()
    setAuthToken(null)
    setSession(null)
  }, [])

  return { session, signIn, signInAdmin, signOut }
}

/** 记录已经同步给 api 层的 token，避免每次渲染都写一遍 */
let appliedToken: string | null | undefined
