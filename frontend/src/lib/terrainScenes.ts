import type { PresentationArchive } from './presentation'

/** Display scenarios, not evidence of sensors installed at these public-data sites. */
export const TERRAIN_SCENES = [
  { siteId: 'baijiabao', monitorId: 'terrain-demo-baijiabao', sourceDeviceId: 'slope-node-01' },
  { siteId: 'gaolan', monitorId: 'terrain-demo-gaolan', sourceDeviceId: 'slope-node-02' },
  { siteId: 'shuiping', monitorId: 'terrain-demo-shuiping', sourceDeviceId: 'demo-node-02' },
  { siteId: 'baishuihe', monitorId: 'terrain-demo-baishuihe', sourceDeviceId: 'demo-node-03' },
  { siteId: 'bazimen', monitorId: 'terrain-demo-bazimen', sourceDeviceId: 'demo-node-04' },
  { siteId: 'xintan', monitorId: 'terrain-demo-xintan', sourceDeviceId: 'demo-node-01' },
  { siteId: 'lianziya', monitorId: 'terrain-demo-lianziya', sourceDeviceId: 'demo-node-03' },
] as const
export function terrainScenario(archive: PresentationArchive | null, siteId: string) {
  const binding = TERRAIN_SCENES.find(s => s.siteId === siteId)
  if (!binding) return null
  const source = archive?.scenes.find(s => s.device.device_id === binding.sourceDeviceId)?.device ?? null
  return { ...binding, source }
}
