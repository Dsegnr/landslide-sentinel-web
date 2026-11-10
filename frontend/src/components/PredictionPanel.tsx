import { fmtAgo, fmtNum, fmtPercent, fmtShort } from '../lib/format'
import { levelColor, levelMeta, MODE_NOTE, stageName } from '../lib/levels'
import type { DeviceInfo } from '../lib/types'

// 通道中文名：来源说明要给看屏的人读，不能把 R/P/RN/S/D 这些代号甩出去
const CH_LABEL: Record<string, string> = {
  R: '倾角R', P: '倾角P', T: '温度', H: '湿度',
  RN: '雨量感应', RNM: '降雨量', S: '土壤湿度响应', D: '位移', DIST: '原始测距',
}

/** 数据来源说明：按**通道**分清实测与同口径补齐。
 *
 * 硬件只上报部分通道（实测就是"只有温湿度"），所以同一台设备的不同通道来源不同，
 * 一句"硬件直连"或"演示数据"都会说错。这里只列少的那一侧，另一侧归入"其余"，
 * 文案长度可控，不会把右侧面板撑成两行。
 */
function SourceNote({ device }: { device: DeviceInfo }) {
  if (device.presentation) return <>{device.presentation.label} · {device.presentation.aggregation}</>
  const sources = device.reading_sources
  const names = (list: string[]) => list.map((ch) => CH_LABEL[ch] ?? ch).join('/')

  if (!sources) {
    // 老接口/测试桩没有逐通道来源：退回按设备标注，不假装知道细节
    return device.is_demo
      ? <>数据来源：<b>演示序列</b>（同口径生成）</>
      : <>数据来源：<b>硬件通道记录</b></>
  }
  const measured = Object.keys(sources).filter((ch) => sources[ch] === 'hardware')
  const filled = Object.keys(sources).filter((ch) => sources[ch] === 'simulation')
  if (measured.length === 0) return <>数据来源：<b>演示序列</b>（同口径生成）</>
  if (filled.length === 0) return <>数据来源：<b>硬件通道记录</b></>
  return measured.length <= filled.length ? (
    <>数据来源：{names(measured)}为<b>硬件实测</b>，其余<b>同口径补齐</b></>
  ) : (
    <>数据来源：{names(filled)}为<b>同口径补齐</b>，其余<b>硬件实测</b></>
  )
}

interface PredictionPanelProps {
  device: DeviceInfo | null
}

export default function PredictionPanel({ device }: PredictionPanelProps) {
  if (!device) {
    return <div className="empty">尚未选择设备</div>
  }
  const level = device.prediction?.combined_level ?? 0
  // 数据不足时界面必须换一套说法：显示"0 级 平静／正常监测，无需动作"
  // 会把"设备掉线"读成"一切正常"，这是预警系统里最危险的一种错觉。
  const noData = !device.prediction || device.prediction.data_available === false
  const meta = noData
    ? { name: '数据不足', advice: '近 24 小时没有可用的位移增量，等级未更新；请到「设备与通信」页检查链路' }
    : levelMeta(level)
  const color = noData ? '#94a3b8' : levelColor(level)
  const p7 = device.prediction?.p7 ?? null
  const p30 = device.prediction?.p30 ?? null

  return (
    <div className="prediction">
      {device.presentation && <div className="archive-note">历史回放 · {fmtShort(device.presentation.at)} · 非当前实测</div>}
      <div className="level-block" style={{ borderColor: color }}>
        <div className="level-ring" style={{ boxShadow: `0 0 22px ${color}55`, borderColor: color }}>
          {/* 数据不足时环里不显示"0" —— 那个 0 会被读成"0 级平静" */}
          <span className="level-num" style={{ color }}>{noData ? '—' : level}</span>
          <span className="level-unit">{noData ? '' : '级'}</span>
        </div>
        <div className="level-text">
          <div className="level-stage" style={{ color }}>
            {noData ? '数据不足' : stageName(level, device.prediction?.stage)}
          </div>
          <div className="level-advice">{meta.advice}</div>
        </div>
      </div>

      <dl className="prediction-grid">
        <div>
          <dt>运行模式</dt>
          <dd>
            <span className={`tag ${device.mode === 'full' ? 'tag-full' : 'tag-sentinel'}`}>
              {device.mode === 'full' ? '双时间尺度融合' : device.presentation ? '哨兵层' : '哨兵层（实时分级）'}
            </span>
          </dd>
        </div>
        <div>
          <dt>哨兵触发</dt>
          <dd>{device.prediction && device.prediction.data_available !== false ? `哨兵级 ${device.prediction.sentinel_level}` : '—'}</dd>
        </div>
        <div>
          <dt>推理时间</dt>
          <dd>{device.prediction ? fmtShort(device.prediction.ts) : '—'}</dd>
        </div>
        <div>
            <dt>{device.presentation ? '回放读数时间' : '读数时间'}</dt>
            <dd>{device.latest_ts ? device.presentation ? fmtShort(device.latest_ts) : `${fmtShort(device.latest_ts)}（${fmtAgo(new Date(device.latest_ts).getTime())}）` : '—'}</dd>
        </div>
        {device.level_m !== null ? (
          <div>
            <dt>库水位（外部数据）</dt>
            <dd>
              {fmtNum(device.level_m, 2)} m
              {device.level_lag_days !== null && device.level_lag_days > 0
                ? `（滞后 ${device.level_lag_days} 天）`
                : ''}
              {' · '}
              {fmtNum(device.level_days, 0)} 天历史
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="prob-block">
        <div className="prob-title">未来位移阶跃评分</div>
        {p7 === null && p30 === null ? (
          <div className="prob-na">
            {device.mode === 'full'
              ? '位移或库水位窗口未就绪，暂不输出预测评分'
              : '本设备未接入库水位，不输出外推概率'}
          </div>
        ) : (
          <>
            <ProbBar label="未来 7 天" value={p7} />
            <ProbBar label="未来 30 天" value={p30} />
          </>
        )}
      </div>

      <p className="mode-note">{MODE_NOTE[device.mode] ?? ''}</p>
      <p className="demo-note">
        <SourceNote device={device} />
        {' · '}位移 {fmtNum(device.reading?.D, 2)} mm
      </p>
    </div>
  )
}

function ProbBar({ label, value }: { label: string; value: number | null }) {
  const pct = value === null ? 0 : Math.min(1, Math.max(0, value)) * 100
  const color = pct >= 60 ? '#f87171' : pct >= 30 ? '#fbbf24' : '#38bdf8'
  return (
    <div className="prob-row">
      <span className="prob-label">{label}</span>
      <span className="prob-track">
        <span className="prob-fill" style={{ width: `${pct}%`, background: color }} />
      </span>
      <span className="prob-value" style={{ color }}>{fmtPercent(value)}</span>
    </div>
  )
}
