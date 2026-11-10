import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError, api } from '../lib/api'
import type { WaveEstimate, WavePreset } from '../lib/api'

const UNCONFIRMED_CN: Record<string, string> = {
  alpha_deg: '入水冲击角 α',
  drop_m: '滑体落差 Δz',
  rho_s_kgm3: '滑体容重 ρ_s',
  centroid_elev_m: '滑体质心高程',
  water_level_m: '静水面高程',
}

const LEVEL_CN = ['平静', '关注', '预警', '高度预警', '警报']

/** 对岸区间：≥1 m 取整（底层不确定性远大于 0.1 m），<1 m 保留两位，避免出现「0~0」 */
function fmtRange(lo: number, hi: number): string {
  const one = (v: number) => (v >= 1 ? String(Math.round(v)) : v > 0 ? v.toFixed(2) : '0')
  return `${one(lo)}~${one(hi)} m`
}

export default function WavePanel() {
  const [presets, setPresets] = useState<WavePreset[]>([])
  const [site, setSite] = useState('baijiabao')
  const [speed, setSpeed] = useState('')          // 监测速率 m/s，留空则不参与
  const [result, setResult] = useState<WaveEstimate | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    api.wavePresets()
      .then((res) => {
        if (!alive) return
        setPresets(res.presets)
        if (res.presets.length && !res.presets.some((p) => p.id === site)) {
          setSite(res.presets[0].id)
        }
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof ApiError ? err.message : String(err))
      })
    return () => { alive = false }
    // site 只用于兜底选择，不作为依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const run = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const body: Record<string, unknown> = { site }
      const v = Number(speed)
      if (speed.trim() !== '' && Number.isFinite(v) && v >= 0) body.monitored_speed_mps = v
      setResult(await api.waveEstimate(body))
    } catch (err) {
      setResult(null)
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [site, speed])

  const preset = presets.find((p) => p.id === site) ?? null

  // 首次拿到预设后自动算一次默认点位：面板默认收起，摘要行也必须已有结论
  useEffect(() => {
    if (!presets.length) return
    void run()
    // 只在预设首次到位时触发一次；此后由用户点按钮
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presets])

  // 摘要行：大屏右栏放不下完整面板，收起时也必须给出结论
  const headline = useMemo(() => {
    if (error) return '估算失败'
    if (!result) return '加载中…'
    const pan = result.rows.map((r) => r.panjiazheng.opposite_max_m)
    const panTxt = pan.length
      ? `潘家铮对岸 ${Math.min(...pan).toFixed(0)}~${Math.max(...pan).toFixed(0)} m`
      : '无可用情景'
    if (!result.heller_applicable) {
      return `${panTxt} · Heller 档不适用`
    }
    const usable = result.rows.filter((r) => r.heller.applicable)
    const inDom = usable.filter((r) => r.heller.in_domain)
    if (!inDom.length) {
      return `${panTxt} · Heller 全部超标定域（外推）`
    }
    const vs = inDom.map((r) => r.heller.amplitude_max_m as number)
    const lo = Math.min(...vs)
    const hi = Math.max(...vs)
    const range = hi - lo < 0.05 ? `${lo.toFixed(1)} m` : `${lo.toFixed(1)}~${hi.toFixed(1)} m`
    return `Heller 波幅 ${range} · 域内 ${inDom.length}/${result.rows.length} 情景`
  }, [result, error])

  return (
    <div className="wave">
      <details className="wave-fold">
        <summary className="wave-summary">
          <span className="wave-headline">{headline}</span>
          <span className="wave-hint">两档方法并列 · 点开看细节</span>
        </summary>

        <div className="wave-fold-body">
      <div className="wave-controls">
        <select value={site} onChange={(e) => setSite(e.target.value)} disabled={!presets.length}
                aria-label="推演点位">
          {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input
          type="text"
          inputMode="decimal"
          value={speed}
          placeholder="监测速率 m/s（可空）"
          aria-label="监测速率"
          onChange={(e) => setSpeed(e.target.value)}
        />
        <button type="button" className="wave-run" onClick={run} disabled={busy || !presets.length}>
          {busy ? '…' : '估算'}
        </button>
      </div>

      {preset && preset.unconfirmed.length > 0 ? (
        <p className="wave-warn">
          ⚠ 未经现场剖面确认，当前为工作值：
          {preset.unconfirmed.map((k) => UNCONFIRMED_CN[k] ?? k).join('、')}
        </p>
      ) : null}

      {error ? <div className="notice">{error}</div> : null}
      {!result && !error ? (
        <div className="empty">选择点位后点「估算涌浪」，将并列给出两档方法的结果</div>
      ) : null}

      {result ? (
        <>
          <table className="wave-table">
            <thead>
              <tr>
                <th>情景</th>
                <th>潘家铮·对岸</th>
                <th>Heller·波幅</th>
                <th>适用域</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => {
                const h = row.heller
                return (
                  <tr key={row.scenario}>
                    <td title={row.panjiazheng.velocity_note}>
                      {row.label}
                      <span className="wave-v">
                        潘 v={row.panjiazheng.velocity_mps.toFixed(2)}
                        {h.applicable && h.velocity_mps !== undefined
                          ? ` · Heller v=${h.velocity_mps.toFixed(2)}` : ''}
                      </span>
                    </td>
                    <td>{fmtRange(row.panjiazheng.opposite_min_m, row.panjiazheng.opposite_max_m)}</td>
                    {/* 前提不成立时**不给数**：显示成"0 m"会被误读成"波很小" */}
                    <td>{h.applicable && h.amplitude_max_m !== undefined
                      ? `${h.amplitude_max_m.toFixed(1)} m`
                      : <span className="wave-na">不适用</span>}</td>
                    <td>
                      {!h.applicable
                        ? <span className="wave-na" title={h.unavailable_reason}>前提不成立</span>
                        : h.in_domain
                          ? <span className="wave-ok">域内</span>
                          : <span className="wave-out" title={`越界：${(h.violations ?? []).join('、')}`}>
                              外推 {(h.violations ?? []).join('、')}
                            </span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {!result.heller_applicable ? (
            <p className="wave-warn">
              B 档（Heller）不适用：{result.rows[0]?.heller.unavailable_reason}
            </p>
          ) : null}

          {/* 细节默认收起：大屏右栏只有 372px 宽，全展开会把「告警台账」压没 */}
          <details className="wave-details">
            <summary>参数与细节</summary>
            {result.rows.map((row) => {
              const h = row.heller
              return (
                <dl className="wave-detail" key={row.scenario}>
                  <div className="wave-detail-head">{row.label}</div>
                  <div><dt>潘家铮速度</dt><dd>{row.panjiazheng.velocity_mps.toFixed(2)} m/s</dd></div>
                  <div><dt>初始涌浪 ζ0</dt><dd>{row.panjiazheng.zeta0_m} m</dd></div>
                  <div><dt>Heller Δz_sc</dt>
                    <dd>{h.centroid_drop_m} m（质心 − 静水面）</dd></div>
                  {h.applicable ? (
                    <>
                      <div><dt>无量纲量</dt>
                        <dd>F={h.F} · S={h.S} · M={h.M} · P={h.P}</dd></div>
                      <div><dt>波型</dt><dd>{h.wave_type_cn}</dd></div>
                      <div><dt>最大波高 / 周期</dt>
                        <dd>{h.height_max_m} m / {h.period_s} s</dd></div>
                      <div><dt>对岸波幅</dt>
                        <dd>
                          {h.at_opposite_m} m
                          {h.at_opposite_uses_decay
                            ? '（式 5.20 衰减）'
                            : '（X<10，未衰减，取近场最大值）'}
                        </dd></div>
                    </>
                  ) : (
                    <div><dt>Heller 档</dt><dd>不适用（不给数）</dd></div>
                  )}
                </dl>
              )
            })}
          </details>

          <p className="wave-limits">
            标定域 Table 5.1：F {result.limits.F?.[0]}–{result.limits.F?.[1]} ·
            S {result.limits.S?.[0]}–{result.limits.S?.[1]} ·
            M {result.limits.M?.[0]}–{result.limits.M?.[1]} ·
            P {result.limits.P?.[0]}–{result.limits.P?.[1]}
          </p>
          {/* 告警口径：只有"前提成立且域内"的档才有资格进告警，否则明说给不出结论 */}
          <p className={result.advisory.status === 'ok' ? 'wave-advice' : 'wave-warn'}>
            告警口径：
            {result.advisory.status === 'ok'
              ? <>{LEVEL_CN[result.advisory.level ?? 0]} —— 取 {result.advisory.basis} 的{' '}
                  <b>{result.advisory.usable_m} m</b></>
              : result.advisory.reason}
          </p>
          <p className="wave-note">
            阈值 {result.advisory.thresholds_m.join(' / ')} m：{result.advisory.thresholds_source}
          </p>
          {/* 给不出结论时，把三档**逐条**列出来 —— 让"为什么给不出"看得见，
              而不是留一句空话。每一条都有原文依据。 */}
          {result.advisory.status !== 'ok' ? (
            <div className="wave-brackets">
              <div className="wave-detail-head">三档逐条核查</div>
              <div>
                <dt>A · 潘家铮法</dt>
                <dd>
                  {result.rows[0]?.panjiazheng.opposite_min_m}~
                  {result.rows[0]?.panjiazheng.opposite_max_m} m ·
                  {' '}<span className="wave-out">无公开适用域</span>，不进告警
                </dd>
              </div>
              <div>
                <dt>B · Heller/Fritz</dt>
                <dd><span className="wave-na">前提不成立</span>
                  {' '}（{result.rows[0]?.heller.unavailable_reason.slice(0, 26)}…）</dd>
              </div>
              <div>
                <dt>C · Watts 方块</dt>
                <dd>
                  {result.watts === null ? <span className="wave-na">未提供映射参数</span>
                    : result.watts.applicable
                      ? <>{((result.watts.amplitude_min_m ?? 0) * 1000).toFixed(1)}~
                          {((result.watts.amplitude_max_m_hi ?? 0) * 1000).toFixed(0)} mm
                          <span className="wave-out"> 映射未核定</span></>
                      : <><span className="wave-na">不适用</span>
                          {' '}（{result.watts.unavailable_reason}）</>}
                </dd>
              </div>
              {result.watts ? (
                <p className="wave-note">
                  C 档映射：{result.watts.mapping.b_rule}；{result.watts.mapping.d_rule}；
                  {result.watts.mapping.theta_rule} → b={result.watts.mapping.values.b_m} m、
                  d={result.watts.mapping.values.d_m} m、θ={result.watts.mapping.values.theta_deg}°。
                  {result.watts.idealization}
                  {' '}（C 档{result.watts.in_advisory_reason}）
                </p>
              ) : null}
            </div>
          ) : null}
          <p className="wave-note">{result.summary.note}</p>
        </>
      ) : null}
        </div>
      </details>
    </div>
  )
}
