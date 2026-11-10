import { findSite, SITES } from '../lib/sites'

export default function DatasetSelector({ value, onSelect, label = '选择数据集站点' }: {
  value: string; onSelect: (id: string) => void; label?: string
}) {
  const selected = findSite(value)
  return <div className="dataset-selector">
    <label className="selection-picker">数据集站点
      <select aria-label={label} value={selected?.id ?? ''} onChange={e => { if (e.target.value) onSelect(e.target.value) }}>
        <option value="">选择站点定位…</option>
        {SITES.map(site => <option key={site.id} value={site.id}>{site.short} · {site.status}</option>)}
      </select>
    </label>
    {selected ? <div className="selection-summary" data-testid={`site-item-${selected.id}`}>
      <span className={`site-status tone-${selected.tone}`}>{selected.status}</span>
      <span>{selected.location}</span><small>{selected.scale}</small>
    </div> : <div className="selection-caption">{SITES.length} 个资料站点 · 选择后定位地图</div>}
  </div>
}
