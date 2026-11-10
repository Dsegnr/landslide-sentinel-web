import { useState, type FormEvent } from 'react'

import { api } from '../lib/api'
import { LEVEL_META } from '../lib/levels'
import type { MapNode } from '../lib/types'

interface PointFormProps {
  lonLat: [number, number]
  onDone: (message: string) => void
  onCancel: () => void
}

/** 人工新增警告点位（管理人员）：位置来自地图点击，等级/权重/关注可调 */
export default function PointForm({ lonLat, onDone, onCancel }: PointFormProps) {
  const [name, setName] = useState('')
  const [level, setLevel] = useState(2)
  const [weight, setWeight] = useState(1.0)
  const [watch, setWatch] = useState(true)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('请填写点位名称')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api.createPoint({
        name: name.trim(), lon: lonLat[0], lat: lonLat[1],
        level, weight, watch, note: note.trim(),
      })
      onDone(`已新增警告点位：${name.trim()}（${LEVEL_META[level].name} · 权重 ${weight.toFixed(1)}）`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="record-form" onSubmit={submit}>
      <div className="point-coord">
        位置：{lonLat[1].toFixed(4)}, {lonLat[0].toFixed(4)}（经纬度，来自地图点击）
      </div>
      <label>
        点位名称
        <input value={name} onChange={(e) => setName(e.target.value)}
               placeholder="例如：巡检发现裂缝点" />
      </label>
      <label>
        等级
        <select value={level} onChange={(e) => setLevel(Number(e.target.value))}>
          {LEVEL_META.map((m, i) => <option key={m.name} value={i}>{m.name}（{i} 级）</option>)}
        </select>
      </label>
      <label>
        权重（{weight.toFixed(1)}，参与区域加权风险）
        <input type="range" min={0.2} max={3} step={0.1} value={weight}
               onChange={(e) => setWeight(Number(e.target.value))} />
      </label>
      <label className="watch-row">
        <input type="checkbox" checked={watch} onChange={(e) => setWatch(e.target.checked)} />
        加入关注（地图上白边高亮，列表置顶）
      </label>
      <label>
        说明（可选）
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder="例如：人工巡检发现的裂缝隐患" />
      </label>
      {error ? <div className="login-error" role="alert">{error}</div> : null}
      <div className="record-actions">
        <button type="submit" className="login-submit" disabled={busy}>
          {busy ? '提交中…' : '确认新增'}
        </button>
        <button type="button" className="ghost-btn" onClick={onCancel}>取消</button>
      </div>
    </form>
  )
}

export type { MapNode }
