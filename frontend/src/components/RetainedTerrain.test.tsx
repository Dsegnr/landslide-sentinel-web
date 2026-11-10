import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const state=vi.hoisted(()=>({mounts:0,disposals:0,fail:false,warm:null as null|(()=>void)}))
vi.mock('../lib/routeResources',async()=>{
  const React=await import('react')
  function Scene({active,onPrepared}:{active:boolean;onPrepared:()=>void}){
    if(state.fail)throw new Error('controlled scene failure')
    const [camera]=React.useState(()=>Math.random())
    React.useEffect(()=>{state.mounts++;onPrepared();return()=>{state.disposals++}},[])
    return <div data-testid="scene" data-active={String(active)} data-camera={camera} />
  }
  return{loadTerrainPage:async()=>({default:Scene}),scheduleTerrainPreparation:(ready:()=>void)=>{state.warm=ready;return()=>{state.warm=null}}}
})
import RetainedTerrain from './RetainedTerrain'
const props={session:{token:'test',role:'user' as const,name:'monitor'},onNavigate:()=>{},onLogout:()=>{}}
beforeEach(()=>{state.mounts=0;state.disposals=0;state.fail=false;state.warm=null})
describe('retained terrain host',()=>{
  it('warms one inaccessible scene and preserves its camera through navigation',async()=>{
    const host=render(<RetainedTerrain {...props} active={false} prepareEnabled />)
    expect(screen.queryByTestId('scene')).toBeNull()
    await act(async()=>{state.warm?.()})
    const scene=await screen.findByTestId('scene'),camera=scene.dataset.camera
    expect(host.container.firstElementChild).toHaveAttribute('inert')
    expect(host.container.firstElementChild).toHaveAttribute('aria-hidden','true')
    host.rerender(<RetainedTerrain {...props} active prepareEnabled />)
    expect(screen.getByTestId('scene')).toBe(scene)
    expect(scene.dataset.camera).toBe(camera)
    expect(host.container.firstElementChild).not.toHaveAttribute('inert')
    host.rerender(<RetainedTerrain {...props} active={false} prepareEnabled />)
    expect(state.mounts).toBe(1)
    expect(scene.dataset.active).toBe('false')
    host.unmount();expect(state.disposals).toBe(1)
  })
  it('can enter immediately without waiting for background preparation',async()=>{
    render(<RetainedTerrain {...props} active prepareEnabled={false} />)
    expect(await screen.findByTestId('scene')).toBeInTheDocument()
  })
  it('contains a failed background scene and permits a fresh retry',async()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{})
    state.fail=true
    try{
      const host=render(<RetainedTerrain {...props} active={false} prepareEnabled />)
      await act(async()=>{state.warm?.()})
      expect(screen.queryByText('三维加载暂未完成。')).toBeNull()
      host.rerender(<RetainedTerrain {...props} active prepareEnabled />)
      await waitFor(()=>expect(screen.getByRole('button',{name:'重新加载三维'})).toBeInTheDocument())
      state.fail=false
      await userEvent.click(screen.getByRole('button',{name:'重新加载三维'}))
      expect(await screen.findByTestId('scene')).toBeInTheDocument()
    }finally{log.mockRestore()}
  })
})
