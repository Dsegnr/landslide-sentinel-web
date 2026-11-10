import { useEffect, useState } from 'react'

/** This lightweight ticker never rerenders the reception charts. */
export default function AutoRefreshIndicator({ nextPollAt, interval, busy, enabled }: {
  nextPollAt: number; interval: number; busy: boolean; enabled: boolean
}) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    setNow(Date.now())
    if (!enabled || !nextPollAt || document.hidden) return
    const timer = window.setInterval(() => { if (!document.hidden) setNow(Date.now()) }, 100)
    return () => clearInterval(timer)
  }, [enabled, nextPollAt])
  const remaining = Math.max(0, nextPollAt - now)
  const seconds = Math.ceil(remaining / 1000)
  const progress = Math.min(1, remaining / interval)
  const circumference = 2 * Math.PI * 11
  const text = !enabled ? '自动核对暂停' : busy ? '自动核对中' : `下次自动核对 ${seconds} 秒`
  return <span className={`rx-auto-check ${busy && enabled ? 'checking' : ''}`} aria-label={text} title={text}>
    <span className="rx-auto-ring" aria-hidden="true">
      <svg width="28" height="28" viewBox="0 0 28 28"><circle className="rx-auto-track" cx="14" cy="14" r="11" />
        <circle className="rx-auto-progress" cx="14" cy="14" r="11" strokeDasharray={busy ? '18 51.1' : circumference} strokeDashoffset={busy ? 0 : circumference * (1 - progress)} />
      </svg><span className="rx-auto-value">{!enabled ? '—' : busy ? '·' : seconds}</span>
    </span><span>{!enabled ? '核对暂停' : busy ? '自动核对中' : '自动核对'}</span>
  </span>
}
