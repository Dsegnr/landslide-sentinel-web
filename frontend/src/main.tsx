import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import './styles.css'

// 诊断用：标记模块是否执行、渲染是否抛错（白屏时能一眼看出卡在哪一步）
;(window as unknown as { __boot?: string }).__boot = 'module-ok'
try {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
  ;(window as unknown as { __boot?: string }).__boot = 'render-called'
} catch (err) {
  (window as unknown as { __boot?: string }).__boot =
    `render-threw: ${(err as Error)?.message ?? String(err)}`
  throw err
}
