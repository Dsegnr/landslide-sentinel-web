import type { Route } from '../hooks/useHashRoute'
import { loadTerrain, loadTerrainOsm } from './terrainAssets'
import { prepareOps } from './opsPreparation'
import { prepareMapViewport } from './mapTilePool'
import { TERRAIN_SCENES } from './terrainScenes'

/** Decode the finite catalog in small background batches after the first scene.
 * No extra WebGL contexts are created. Cancel stops scheduling; a shared in-flight
 * asset can still finish for a user who selected it in the meantime. */
export function scheduleTerrainCatalogPreparation(currentSite: string) {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  if (connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType ?? '')) return () => {}
  const sites = TERRAIN_SCENES.map(s => s.siteId).filter(id => id !== currentSite)
  let cancelled = false, timer: number | undefined, idle: number | undefined
  const queue = () => {
    if (cancelled || !sites.length) return
    timer = window.setTimeout(() => {
      if (cancelled) return
      if (document.hidden) { queue(); return }
      const prepare = () => {
        if (cancelled) return
        if (document.hidden) { queue(); return }
        const site = sites.shift()!
        void Promise.allSettled([loadTerrain(site), loadTerrainOsm(site)]).then(queue)
      }
      if ('requestIdleCallback' in window) idle = window.requestIdleCallback(prepare, { timeout: 1500 })
      else prepare()
    }, 350)
  }
  // Give the displayed first scene and primary-page work priority.
  timer = window.setTimeout(queue, 1200)
  return () => { cancelled = true; clearTimeout(timer); if (idle !== undefined) window.cancelIdleCallback(idle) }
}

let terrainPage: Promise<typeof import('../pages/TerrainPage')> | undefined
export function loadTerrainPage() {
  return terrainPage ??= import('../pages/TerrainPage').catch(error => {
    terrainPage = undefined
    throw error
  })
}
export function prepareRoute(route: Route) {
  if (route === 'field') { void prepareMapViewport(); return }
  if (route === 'ops') { void prepareOps(); return }
  if (route !== 'terrain') return
  // Reuse the same promises on hover, idle preparation and actual navigation.
  void prepareTerrainResources()
}
function prepareTerrainResources() {
  return Promise.allSettled([loadTerrainPage(), loadTerrain('baijiabao'), loadTerrainOsm('baijiabao')])
}
export function scheduleTerrainPreparation(onReady?: () => void) {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  if (document.visibilityState !== 'visible' || connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType ?? '')) return () => {}
  let idle: number | undefined
  let cancelled = false
  const prepare = () => {
    void prepareTerrainResources().then(() => {
      if (!cancelled && document.visibilityState === 'visible') onReady?.()
    })
  }
  const timer = window.setTimeout(() => {
    if (document.visibilityState !== 'visible') return
    if ('requestIdleCallback' in window) idle = window.requestIdleCallback(prepare)
    else prepare()
  }, 1200)
  return () => { cancelled = true; clearTimeout(timer); if (idle !== undefined) window.cancelIdleCallback(idle) }
}
