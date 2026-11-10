import { useSyncExternalStore } from 'react'
let selected = ''
const listeners = new Set<() => void>()
export function selectDevice(id: string) {
  selected = id
  listeners.forEach(fn => fn())
}
export function useSelectedDevice() {
  const id = useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn) } }, () => selected, () => '')
  return [id, selectDevice] as const
}
