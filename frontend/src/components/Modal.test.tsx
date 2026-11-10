import { render,screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect,it,vi } from 'vitest'
import Modal from './Modal'
it('traps keyboard focus, closes on Escape and restores the launching control',async()=>{
 const launch=document.createElement('button');document.body.appendChild(launch);launch.focus()
 const close=vi.fn(),{unmount}=render(<Modal title="查看" onClose={close}><button>复制</button></Modal>)
 const dismiss=screen.getByRole('button',{name:'关闭'}),copy=screen.getByRole('button',{name:'复制'})
 expect(dismiss).toHaveFocus();await userEvent.tab({shift:true});expect(copy).toHaveFocus()
 await userEvent.tab();expect(dismiss).toHaveFocus()
 await userEvent.keyboard('{Escape}');expect(close).toHaveBeenCalledTimes(1)
 unmount();expect(launch).toHaveFocus();launch.remove()
})
