import { useEffect, useRef, type ReactNode } from 'react'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}

export default function Modal({ title, onClose, children, wide = false }: ModalProps) {
  const card = useRef<HTMLDivElement>(null), close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const focusable = () => [...(card.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])]
      .filter(e => !e.closest('[hidden], [inert]') && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden')
    ;(focusable()[0] ?? card.current)?.focus({ preventScroll: true })
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current(); return }
      if (e.key !== 'Tab') return
      const items = focusable(), first = items[0], last = items.at(-1)
      if (!first) { e.preventDefault(); card.current?.focus(); return }
      if (!card.current?.contains(document.activeElement) || (e.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        e.preventDefault(); (e.shiftKey ? last : first)?.focus()
      }
    }
    document.addEventListener('keydown', keydown, true)
    return () => { document.removeEventListener('keydown', keydown, true); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  return (
    <div className="modal-mask" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div ref={card} tabIndex={-1} className={`modal-card ${wide ? 'wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h4>{title}</h4>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}
