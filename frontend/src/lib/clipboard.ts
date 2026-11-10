/** 复制文本。返回是否真的复制成功。
 *
 * 为什么要这个封装：`navigator.clipboard` 只在**安全上下文**（https 或 localhost）里存在。
 * 演示时常用的**局域网入口是 http**（例如 http://172.18.67.139:39000），
 * 那里 `navigator.clipboard` 是 undefined —— 原来的 `navigator.clipboard?.writeText(...)`
 * 会静默什么都不做，而按钮仍然显示"已复制"。硬件组要复制自检命令、报文样例时就会卡住。
 *
 * 兜底用临时 <textarea> + `document.execCommand('copy')`：这是老办法，
 * 但在 http 下仍然有效，且不改变任何界面。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 用户拒绝授权或浏览器策略限制 —— 落到下面的兜底
  }

  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    // 不能用 display:none（那样选不中、复制不到），要"看不见但在页面上"
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    const selection = document.getSelection()
    const ranges: Range[] = []
    if (selection) {
      for (let i = 0; i < selection.rangeCount; i += 1) ranges.push(selection.getRangeAt(i))
    }
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    // 复制走的是临时元素，别把用户原来的选中状态弄丢
    if (selection) {
      selection.removeAllRanges()
      ranges.forEach((r) => selection.addRange(r))
    }
    return ok
  } catch {
    return false
  }
}
