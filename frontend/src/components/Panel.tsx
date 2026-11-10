import type { ReactNode } from 'react'

interface PanelProps {
  title: string
  extra?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}

export default function Panel({
  title,
  extra,
  children,
  className = '',
  bodyClassName = '',
}: PanelProps) {
  return (
    <section className={`panel ${className}`}>
      <header className="panel-head">
        <h3 className="panel-title">{title}</h3>
        {extra ? <div className="panel-extra">{extra}</div> : null}
      </header>
      <div className={`panel-body ${bodyClassName}`}>{children}</div>
      <span className="corner tl" aria-hidden="true" />
      <span className="corner tr" aria-hidden="true" />
      <span className="corner bl" aria-hidden="true" />
      <span className="corner br" aria-hidden="true" />
    </section>
  )
}
