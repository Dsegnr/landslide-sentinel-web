import { useState, type FormEvent } from 'react'

import ShareQrModal from './ShareQrModal'

interface LoginViewProps {
  onUser: (username: string, password: string) => Promise<unknown>
  onAdmin: (key: string) => Promise<unknown>
}

type Mode = 'user' | 'admin'

/** 显示/隐藏密码的小眼睛（用内联 SVG，避免 emoji 在不同系统上样式不一致） */
function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      {open ? (
        <>
          <path
            d="M12 5C6.9 5 2.7 8.6 1 12c1.7 3.4 5.9 7 11 7s9.3-3.6 11-7c-1.7-3.4-5.9-7-11-7Z"
            fill="none" stroke="currentColor" strokeWidth="1.6"
          />
          <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </>
      ) : (
        <>
          <path
            d="M12 5C6.9 5 2.7 8.6 1 12c1.7 3.4 5.9 7 11 7s9.3-3.6 11-7c-1.7-3.4-5.9-7-11-7Z"
            fill="none" stroke="currentColor" strokeWidth="1.6"
          />
          <path d="M4 20 20 4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </>
      )}
    </svg>
  )
}

// 登录页：一个普通用户入口 + 一个管理人员密钥入口（按队伍要求，不做三角色）
export default function LoginView({ onUser, onAdmin }: LoginViewProps) {
  const [mode, setMode] = useState<Mode>('user')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [qrOpen, setQrOpen] = useState(false)
  // 密码/密钥默认隐藏，但必须能让人核对——给个"小眼睛"，这是登录页的常规约定
  const [visible, setVisible] = useState(false)
  const changeMode = (next: Mode) => {
    if (next === mode) return
    setMode(next); setError(''); setVisible(false); setPassword(''); setKey('')
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (mode === 'user') await onUser(username.trim(), password)
      else await onAdmin(key.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">边坡哨兵</div>
        <h1>滑坡灾害协同感知与预警系统</h1>
        <p className="login-sub">边坡复合监测节点 · 双时间尺度分级预警</p>

        <div className="login-tabs">
          <button
            type="button"
            className={mode === 'user' ? 'active' : ''}
            onClick={() => changeMode('user')}
          >
            普通用户
          </button>
          <button
            type="button"
            className={mode === 'admin' ? 'active' : ''}
            onClick={() => changeMode('admin')}
          >
            管理人员入口
          </button>
        </div>

        {mode === 'user' ? (
          <>
            <label>
              用户名
              <input
                value={username}
                autoComplete="username"
                onChange={(e) => setUsername(e.target.value)}
                placeholder="请输入用户名"
              />
            </label>
            <label>
              密码
              <div className="pw-field">
                <input
                  type={visible ? 'text' : 'password'}
                  value={password}
                  autoComplete="current-password"
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="请输入密码"
                />
                <button
                  type="button"
                  className={`pw-toggle ${visible ? 'active' : ''}`}
                  onClick={() => setVisible((v) => !v)}
                  aria-label={visible ? '隐藏密码' : '显示密码'}
                  aria-pressed={visible}
                  title={visible ? '隐藏密码' : '显示密码'}
                >
                  <EyeIcon open={visible} />
                </button>
              </div>
            </label>
          </>
        ) : (
          <label>
            管理人员密钥
            <div className="pw-field">
              <input
                type={visible ? 'text' : 'password'}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="由部署方在服务器 .env 里配置"
              />
              <button
                type="button"
                className={`pw-toggle ${visible ? 'active' : ''}`}
                onClick={() => setVisible((v) => !v)}
                aria-label={visible ? '隐藏密钥' : '显示密钥'}
                aria-pressed={visible}
                title={visible ? '隐藏密钥' : '显示密钥'}
              >
                <EyeIcon open={visible} />
              </button>
            </div>
          </label>
        )}

        {error ? <div className="login-error" role="alert">{error}</div> : null}

        <button type="submit" className="login-submit" disabled={busy}>
          {busy ? '登录中…' : mode === 'user' ? '登录查看大屏' : '进入管理后台'}
        </button>

        <p className="login-note">
          普通用户只能查看；<b>确认处置告警、查看审计</b>需要管理人员密钥。
        </p>

        {/* 展台场景：评委还没登录就能扫码在手机上打开 */}
        <button type="button" className="login-qr-btn" onClick={() => setQrOpen(true)}>
          扫码在手机上查看
        </button>
      </form>

      <ShareQrModal open={qrOpen} onClose={() => setQrOpen(false)} />
    </div>
  )
}
