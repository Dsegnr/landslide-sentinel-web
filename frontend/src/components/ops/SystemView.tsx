import { api } from '../../lib/api'
import { useOpsResource } from '../../hooks/useOpsResource'
import { OpsCard, OpsError, OpsHead, OpsMetrics, opsNumber, opsTime } from './OpsUi'

export default function SystemView() {
  const { data, error, loading, refresh, updated } = useOpsResource('system', s => api.opsSystem(s))
  const disk = data?.disk, storage = data?.storage
  return <>
    <OpsHead title="系统运行态" description="查看服务存活、资源余量与最近保留记录" loading={loading} refresh={refresh} updated={updated} />
    <OpsError error={error} retained={!!data} />
    <OpsMetrics items={[
      { title: '后端进程', value: data ? data.processes.app.alive ? '运行中' : '未运行' : '—', tone: data?.processes.app.alive ? 'ow-good' : '' },
      { title: '隧道进程', value: data ? data.processes.tunnel.alive ? '运行中' : '未检测到' : '—', tone: data?.processes.tunnel.alive ? 'ow-good' : '' },
      { title: '磁盘可用空间', value: opsNumber(disk?.free_gb), unit: 'GB', tone: disk && disk.free_gb < 5 ? 'ow-bad' : '' },
      { title: '数据库体积', value: opsNumber(storage?.db_size_mb, 2), unit: 'MB' },
    ]} />
    <div className="ow-two">
      <OpsCard title="服务与资源" extra="当前快照 · 30秒核对">
        <div className="ow-disk-label"><strong>{opsNumber(disk?.used_pct)}<small>% 已用</small></strong><span>{opsNumber(disk?.used_gb)} / {opsNumber(disk?.total_gb)} GB</span></div>
        <div className="ow-track ow-disk"><i className={disk && disk.used_pct >= 90 ? 'warning' : ''} style={{ width: `${Math.max(0, Math.min(100, disk?.used_pct ?? 0))}%` }} /></div>
        <div className="ow-policy">{(['app', 'tunnel'] as const).map(key => <div key={key}><span>{key === 'app' ? '后端服务' : '公网隧道'}运行时长</span><b>{opsNumber(data?.processes[key].uptime_hours, 2)} 小时</b></div>)}<div><span>环境</span><b>Python {data?.runtime.python ?? '—'}</b></div></div>
        <p className="ow-caption">服务状态按进程存活统计；磁盘为所在卷整体用量。</p>
      </OpsCard>
      <OpsCard title="数据库概况" extra="统计全部来源读数">
        <div className="ow-db-count">{storage ? storage.readings_total.toLocaleString() : '—'}<small>条读数</small></div>
        <div className="ow-policy"><div><span>覆盖时间跨度</span><b>{opsNumber(storage?.span_days)} 天</b></div><div><span>跨度内日均记录</span><b>{opsNumber(storage?.readings_per_day)} 条</b></div><div><span>最早采样</span><b>{opsTime(storage?.first_ts)}</b></div><div><span>最新采样</span><b>{opsTime(storage?.last_ts)}</b></div></div>
        <p className="ow-caption">日均为读数总量除以采样时间跨度，包含模拟与补齐，不代表当前硬件上报速率。</p>
      </OpsCard>
    </div>
    <OpsCard title="最近数据备份" extra={`${data?.backups.length ?? 0} 份已记录文件`}>
      <div className="ow-table-scroll"><table className="ow-table"><thead><tr><th>备份文件</th><th>体积</th><th>文件时间（北京）</th></tr></thead><tbody>{data?.backups.map(b => <tr key={b.file}><td>{b.file}</td><td>{opsNumber(b.mb, 2)} MB</td><td>{opsTime(b.ts)}</td></tr>)}</tbody></table></div>
      {!data?.backups.length ? <div className="ow-empty">{loading ? '正在读取…' : '未检索到约定命名的数据备份文件'}</div> : null}
      <p className="ow-caption">按备份文件日期排列，显示最近7份。</p>
    </OpsCard>
    <details className="ow-details"><summary>模型文件、日志与维护说明</summary><div className="ow-two ow-equal">
      <div><h4>模型文件清单</h4>{data?.models.map(m => <div className="ow-line" key={m.file}><span>{m.file}</span><b>{opsNumber(m.kb)} KB</b></div>)}{!data?.models.length ? <p className="ow-caption">暂无文件记录</p> : null}</div>
      <div><h4>运行日志文件</h4>{data?.logs.map(l => <div className="ow-line" key={l.file}><span>{l.file}<small>{opsTime(l.ts)}</small></span><b>{opsNumber(l.mb, 2)} MB</b></div>)}</div>
    </div><p className="ow-caption">维护操作由部署管理员执行，页面仅提供文件查询。</p></details>
  </>
}
