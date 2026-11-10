import { useState, type FormEvent } from 'react'

import { api } from '../lib/api'

interface RecordFormProps {
  points: string[]
  onDone: (message: string) => void
  onCancel: () => void
}

const LEVELS = ['轻度', '中度', '重度', '预警']

/** 新增现场滑坡记录：点位 / 危险等级 / 说明 / 现场照片。
 *
 *  与队长原版的关键区别：照片**上传到后端落盘**、记录**落库**，
 *  刷新页面、换台电脑再看都还在（原版只存在浏览器内存里，刷新就没）。
 */
export default function RecordForm({ points, onDone, onCancel }: RecordFormProps) {
  const [pointName, setPointName] = useState(points[0] ?? '')
  const [level, setLevel] = useState('中度')
  const [note, setNote] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!pointName.trim()) {
      setError('请填写点位名称')
      return
    }
    setBusy(true)
    setError('')
    const form = new FormData()
    form.append('point_name', pointName.trim())
    form.append('level', level)
    form.append('note', note)
    if (file) form.append('photo', file)
    try {
      const res = await api.createRecord(form)
      onDone(`已新增记录：${res.record.point_name}（${res.record.level}）`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="record-form" onSubmit={submit}>
      <label>
        点位名称
        <input
          list="point-options"
          value={pointName}
          onChange={(e) => setPointName(e.target.value)}
          placeholder="例如：白家包 ZD1"
        />
        <datalist id="point-options">
          {points.map((p) => <option key={p} value={p} />)}
        </datalist>
      </label>
      <label>
        危险等级
        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </label>
      <label>
        现场说明（可选）
        <textarea value={note} rows={3} onChange={(e) => setNote(e.target.value)}
                  placeholder="例如：坡面出现新裂缝，长度约 3 米" />
      </label>
      <label>
        现场照片（可选，≤8 MB）
        <input type="file" accept="image/*"
               onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
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
