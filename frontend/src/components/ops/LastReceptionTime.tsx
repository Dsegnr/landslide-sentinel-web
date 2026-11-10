import { useEffect, useState } from 'react'

const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const date = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })

function elapsed(timestamp: number, now: number) {
  const seconds = Math.floor((now - timestamp) / 1000)
  if (seconds < -5) return '接收时间晚于本机时钟，请核对时间'
  if (seconds <= 0) return '刚刚收到'
  const s = seconds % 60, m = Math.floor(seconds / 60) % 60, h = Math.floor(seconds / 3600)
  return `距上次接收 ${h ? `${h}小时` : ''}${h || m ? `${m}分` : ''}${s}秒`
}

/** Refresh elapsed age only; never replace a server reception timestamp with the clock. */
export default function LastReceptionTime({ timestamp, ready }: { timestamp?: string | null; ready: boolean }) {
  const [now, setNow] = useState(Date.now)
  const received = timestamp ? Date.parse(timestamp) : NaN
  const valid = Number.isFinite(received)
  useEffect(() => {
    let timer: number | undefined
    const arm = () => {
      clearInterval(timer); setNow(Date.now())
      if (valid && !document.hidden) timer = window.setInterval(() => setNow(Date.now()), 5000)
    }
    arm(); document.addEventListener('visibilitychange', arm)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', arm) }
  }, [timestamp, valid])
  return <div className="rx-last">
    <span>最近真实接收</span>
    <strong>{valid ? <time dateTime={timestamp!}>{clock.format(received)}</time> : ready ? '尚无记录' : '—'}</strong>
    <small>{valid ? `${date.format(received)} · 北京时间` : '不含模拟与补齐'}</small>
    {valid ? <small className="rx-reception-age">{elapsed(received, now)}</small> : null}
  </div>
}
