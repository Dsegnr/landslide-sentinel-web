/** 手机端的栏目切换条。
 *
 *  我们是三栏密集信息面板，手机上塞不下——与其把字缩到看不清，
 *  不如一屏看一栏、点标签切换。只在 <768px 显示（CSS 控制），
 *  平板/桌面完全不受影响。
 */
export interface MobileTab {
  key: string
  label: string
}

export default function MobileTabs({ tabs, value, onChange }: {
  tabs: MobileTab[]
  value: string
  onChange: (key: string) => void
}) {
  return (
    <nav className="mobile-tabs" role="tablist" aria-label="栏目切换">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={value === t.key}
          className={`mobile-tab ${value === t.key ? 'active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  )
}
