import { useMemo, useState } from 'react'
import { api, type OpsDevice } from '../../lib/api'
import { useOpsResource } from '../../hooks/useOpsResource'
import { CopyBlock, OpsCard, OpsError, OpsHead } from './OpsUi'

const fields = [
  ['R / P', '双轴倾角', '°', '保留正负方向，角度与轴向约定保持一致'],
  ['T / H', '环境温度 / 湿度', '°C / %', '用于环境监测与展示，不属于现有12维预警输入'],
  ['RN', '雨滴响应', '%', '板面湿润响应；毫米降雨量应另走RNM'],
  ['RNM', '周期降雨量', 'mm', '本采样周期累计毫米雨量；没有雨量计则省略'],
  ['S', '土壤湿度响应', '%', '模拟响应换算值；解释为含水率前需按介质标定'],
  ['D', '相对位移', 'mm', '终端已换算的位移，服务端不再扣安装基线'],
  ['DIST', '原始测距', 'mm', '兼容输入；服务端按安装基线−DIST换算D，与D择一'],
  ['ts', '采样时间', '—', '无时区按北京时间；显式时区按实际采样时刻填写'],
]
export default function GuideView({ devices, current, onSelect }: { devices: OpsDevice[]; current: OpsDevice | null; onSelect: (id: string) => void }) {
  const [step, setStep] = useState(0), [mode, setMode] = useState('D'), [search, setSearch] = useState('')
  const id = current?.device_id ?? ''
  const { data: sc, error, loading, refresh, updated } = useOpsResource(`guide/${id}`, s => id ? api.opsSelfcheck(id, s) : Promise.resolve(null), 300000, !!id)
  const ready = sc?.device_id === id
  const sample = useMemo(() => {
    if (!ready) return ''
    const examples: Record<string, number> = { R: 1.2, P: -1.1, T: 25, H: 65, RN: 0, S: 40, D: 10, DIST: 890 }
    const ch = current?.measured_channels.length ? current.measured_channels : ['R', 'P', 'T', 'H', 'RN', 'S', 'D']
    const channels = Object.fromEntries(ch.filter(c => c !== 'D' && c !== 'DIST' && c !== 'RNM' && c in examples).map(c => [c, examples[c]]))
    channels[mode] = examples[mode]
    return JSON.stringify({ device_id: id, ts: '<YYYY-MM-DD HH:MM:SS，北京时间>', channels }, null, 2)
  }, [id, mode, ready, current?.measured_channels])
  const check = ready ? `curl -H "X-Device-Token: <你的设备令牌>" "${sc.endpoints.check}"` : ''
  return <>
    <OpsHead title="对接指南" description="设备令牌、自检与上报分步查看，示例中不含真实密钥" loading={loading} refresh={refresh} updated={updated} />
    <OpsError error={error} retained={!!sc} />
    <div className="ow-toolbar"><label>对接设备<select aria-label="对接设备" value={id} onChange={e => onSelect(e.target.value)}>{devices.map(d => <option key={d.device_id} value={d.device_id}>{d.name}</option>)}</select></label><span className="ow-context">{current?.token_registered ? '令牌已登记' : '该设备尚未登记令牌'}</span></div>
    <nav className="ow-steps" aria-label="接入步骤">{['获取设备令牌', '检查接入连通', '发送采样数据'].map((t, i) => <button key={t} className={step === i ? 'active' : ''} onClick={() => setStep(i)} aria-pressed={step === i}><span>{i + 1}</span>{t}</button>)}</nav>
    <div className="ow-two">
      <OpsCard title={['获取设备令牌', '检查接入连通', '发送采样数据'][step]} extra={`步骤 ${step + 1} / 3`}>
        {step === 0 ? <div className="ow-guide-copy"><h4>向部署管理员领取设备专用令牌</h4><p>在请求头携带 <code>X-Device-Token</code>。设备号与令牌对应，网页只显示登记状态。</p><p>拿到令牌后，先检查连通性，再发送实测数据。</p><button onClick={() => setStep(1)}>下一步：检查连通</button></div> : null}
        {step === 1 ? <><p className="ow-caption">以下命令只检查设备鉴权与地址，不写入采样。</p><CopyBlock title="接入检查命令" text={check} /><p className="ow-caption">替换令牌占位符后在终端执行；网页不会代为发送。</p><button onClick={() => setStep(2)}>下一步：查看上报示例</button></> : null}
        {step === 2 ? <><div className="ow-segment"><button className={mode === 'D' ? 'active' : ''} onClick={() => setMode('D')}>终端已换算 D</button><button className={mode === 'DIST' ? 'active' : ''} onClick={() => setMode('DIST')}>兼容原始 DIST</button></div><p className="ow-caption">{mode === 'D' ? '当前终端使用D，服务端不重复扣基线。' : '仅原始测距接入时使用此方式，D与DIST择一。'} 以下数字仅为协议示例，请替换为真实采样，未接通道省略。</p><CopyBlock title={`POST ${ready ? sc.endpoints.push : '/api/ingest/readings'}`} text={sample} /><p className="ow-caption">Content-Type: application/json；X-Device-Token: &lt;你的设备令牌&gt;</p></> : null}
      </OpsCard>
      <OpsCard title="接入核对要点">
        <ul className="ow-checklist"><li><b>时间准确</b><span>填写采样时刻，不用补传时刻替代；页面统一按北京时间显示。</span></li><li><b>单位一致</b><span>倾角用度，位移用mm，响应百分比与毫米雨量分开。</span></li><li><b>缺测省略</b><span>未接通道不填0，保留真实缺测状态。</span></li><li><b>重复不写重</b><span>同一设备与采样时刻会去重；批量补传使用items数组。</span></li></ul>
      </OpsCard>
    </div>
    <details className="ow-details"><summary>字段字典与单位约定</summary><label className="ow-search">查找字段<input aria-label="查找字段" placeholder="字段、名称或单位" value={search} onChange={e => setSearch(e.target.value)} /></label><div className="ow-table-scroll"><table className="ow-table"><thead><tr><th>字段</th><th>含义</th><th>单位</th><th>说明</th></tr></thead><tbody>{fields.filter(r => r.join(' ').toLowerCase().includes(search.toLowerCase())).map(r => <tr key={r[0]}>{r.map((c, i) => <td key={i}>{c}</td>)}</tr>)}</tbody></table></div></details>
    <details className="ow-details"><summary>常见响应与排查</summary><div className="ow-policy"><div><span>401 / 鉴权失败</span><b>检查设备号、请求头和管理员登记状态</b></div><div><span>accepted = 0 且 duplicated &gt; 0</span><b>同一采样时刻已入库，检查是否重复推送</b></div><div><span>页面没有新硬件值</span><b>检查上报链路与采样时间，勿用模拟读数代替核验</b></div></div></details>
  </>
}
