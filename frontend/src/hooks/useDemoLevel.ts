import { useSyncExternalStore } from 'react'
// Presentation-only state: never sent to an API or persisted in device records.
let level: number | null = null
const listeners = new Set<() => void>()
export function setDemoLevel(next: number | null) {
 level = next !== null && Number.isInteger(next) && next >= 0 && next <= 4 ? next : null
 listeners.forEach(fn => fn())
}
export function useDemoLevel() {
 return useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn) } }, () => level, () => null)
}
