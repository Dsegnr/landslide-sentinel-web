import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import LoginView from './LoginView'

describe('登录页', () => {
  it('切换角色后隐藏并清空已输入的秘密', async () => {
    render(<LoginView onUser={vi.fn()} onAdmin={vi.fn()} />)
    await userEvent.type(screen.getByPlaceholderText('请输入密码'),'private-user-input')
    await userEvent.click(screen.getByRole('button',{name:'显示密码'}))
    await userEvent.click(screen.getByRole('button',{name:'管理人员入口'}))
    expect(screen.getByPlaceholderText(/由部署方在服务器/)).toHaveAttribute('type','password')
    await userEvent.type(screen.getByPlaceholderText(/由部署方在服务器/),'private-admin-input')
    await userEvent.click(screen.getByRole('button',{name:'显示密钥'}))
    await userEvent.click(screen.getByRole('button',{name:'普通用户'}))
    expect(screen.getByPlaceholderText('请输入密码')).toHaveAttribute('type','password')
    expect(screen.getByPlaceholderText('请输入密码')).toHaveValue('')
  })
  it('默认是普通用户入口，填写后提交账号密码', async () => {
    const onUser = vi.fn().mockResolvedValue({})
    render(<LoginView onUser={onUser} onAdmin={vi.fn()} />)
    await userEvent.type(screen.getByPlaceholderText('请输入用户名'), 'monitor')
    await userEvent.type(screen.getByPlaceholderText('请输入密码'), 'sentinel2026')
    await userEvent.click(screen.getByRole('button', { name: '登录查看大屏' }))
    expect(onUser).toHaveBeenCalledWith('monitor', 'sentinel2026')
  })

  it('切到管理人员入口只要求密钥', async () => {
    const onAdmin = vi.fn().mockResolvedValue({})
    render(<LoginView onUser={vi.fn()} onAdmin={onAdmin} />)
    await userEvent.click(screen.getByRole('button', { name: '管理人员入口' }))
    expect(screen.queryByPlaceholderText('请输入用户名')).not.toBeInTheDocument()
    await userEvent.type(screen.getByPlaceholderText(/由部署方在服务器/), 'my-admin-key')
    await userEvent.click(screen.getByRole('button', { name: '进入管理后台' }))
    expect(onAdmin).toHaveBeenCalledWith('my-admin-key')
  })

  it('登录失败时把后端的错误原因显示出来', async () => {
    const onUser = vi.fn().mockRejectedValue(new Error('用户名或密码不正确'))
    render(<LoginView onUser={onUser} onAdmin={vi.fn()} />)
    await userEvent.type(screen.getByPlaceholderText('请输入用户名'), 'monitor')
    await userEvent.type(screen.getByPlaceholderText('请输入密码'), 'bad')
    await userEvent.click(screen.getByRole('button', { name: '登录查看大屏' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('用户名或密码不正确')
  })

  it('密码框有"小眼睛"：点一下明文显示，再点回到隐藏', async () => {
    render(<LoginView onUser={vi.fn()} onAdmin={vi.fn()} />)
    const pw = screen.getByPlaceholderText('请输入密码')
    expect(pw).toHaveAttribute('type', 'password')
    const toggle = screen.getByRole('button', { name: '显示密码' })

    await userEvent.type(pw, 'Abc123')
    expect(pw).toHaveAttribute('value', 'Abc123')

    await userEvent.click(toggle)
    expect(pw).toHaveAttribute('type', 'text')          // 明文，能核对
    expect(screen.getByRole('button', { name: '隐藏密码' })).toHaveAttribute('aria-pressed', 'true')

    await userEvent.click(screen.getByRole('button', { name: '隐藏密码' }))
    expect(pw).toHaveAttribute('type', 'password')      // 默认回到隐藏
  })

  it('管理人员密钥输入框也能切换明文', async () => {
    render(<LoginView onUser={vi.fn()} onAdmin={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: '管理人员入口' }))
    const keyInput = screen.getByPlaceholderText(/由部署方在服务器/)
    expect(keyInput).toHaveAttribute('type', 'password')
    await userEvent.click(screen.getByRole('button', { name: '显示密钥' }))
    expect(keyInput).toHaveAttribute('type', 'text')
  })

  it('可以打开「扫码查看」弹窗，且走公开的自助二维码端点', async () => {
    // 展台场景：评委还没登录就能扫码在手机上打开。
    // 登录页**没有登录态**，所以必须走公开的零输入端点 /api/qr/self.svg
    //（它只编码服务器自己的地址）；带 text 的那个端点要登录，在这里会 401。
    render(<LoginView onUser={vi.fn()} onAdmin={vi.fn()} />)
    expect(screen.queryByTestId('share-qr')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /扫码在手机上查看/ }))

    const img = screen.getByTestId('share-qr') as HTMLImageElement
    const src = decodeURIComponent(img.getAttribute('src') ?? '')
    expect(src).toContain('/api/qr/self.svg')
    expect(src).not.toContain('text=')       // 零输入：不带任何文本参数
    // 说明里要如实写明"这是当前访问地址、隧道重启会变化"
    expect(screen.getByText(/隧道重启会变化/)).toBeInTheDocument()
  })
})
