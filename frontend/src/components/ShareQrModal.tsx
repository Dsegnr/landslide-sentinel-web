import { useState } from 'react'

import Modal from './Modal'
import { qrSvgSelfUrl } from '../lib/api'
import { copyText } from '../lib/clipboard'

/** 扫码查看：把**当前访问地址**做成二维码，手机上扫一下就打开。
 *
 * 几个刻意的选择：
 *  * 二维码由**后端**渲染，前端只挂一个 `<img>` —— 不往包里塞二维码库
 *    （演示环境可能离线，包越小、依赖越少越好）；
 *  * 走的是**公开且零输入**的 `/api/qr/self.svg`（它只编码服务器自己的地址）。
 *    为什么不用带 `text=` 的那个端点：**`<img src>` 带不了 Authorization 头**，
 *    需要登录的端点在这里必然 401、图片渲染不出来（实测踩过，`naturalWidth=0`）。
 *    本部署里前端与后端同源，服务器自己的地址就是页面的地址，两者一致。
 *  * 二维码本身只放**纯网址**：手机相机扫到网址会直接给"打开"，
 *    塞进标题之类的文字反而会让相机认不出网址；信息放到旁边的说明里。
 */
export default function ShareQrModal({ open, onClose }: {
  open: boolean
  onClose: () => void
}) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'fail'>('idle')
  if (!open) return null

  const url = typeof location === 'undefined' ? '' : `${location.origin}/`
  const src = qrSvgSelfUrl()

  const copy = async () => {
    // 局域网入口是 http，那里 navigator.clipboard 不存在 —— 走 copyText 的兜底，
    // 并且只在**真的复制成功**时才显示"已复制"（否则等于骗人）
    const ok = await copyText(url)
    setCopied(ok ? 'done' : 'fail')
    window.setTimeout(() => setCopied('idle'), 1600)
  }

  return (
    <Modal title="扫码在手机上查看" onClose={onClose}>
      <div className="qr-modal">
        <img className="qr-img" src={src} width={196} height={196}
             alt={`打开 ${url} 的二维码`} data-testid="share-qr" />
        <div className="qr-url">
          <code>{url}</code>
          <button type="button" className="ack-btn" onClick={copy}>
            {copied === 'done' ? '已复制' : copied === 'fail' ? '复制失败' : '复制'}
          </button>
        </div>
        <div className="notice">
          <div>· 手机扫上面的码即打开「边坡哨兵 · 滑坡灾害协同感知与预警系统」。</div>
          <div>· 用<b>普通用户</b>账号登录后可只读查看：算法大屏 / 现场监测 / 三维坡体 / 设备与通信。</div>
          <div>· 这是<b>当前访问地址</b>。若通过公网隧道访问，地址由免费隧道分配，
            隧道重启会变化 —— 变了就用新地址重新生成这个二维码。</div>
        </div>
      </div>
    </Modal>
  )
}
