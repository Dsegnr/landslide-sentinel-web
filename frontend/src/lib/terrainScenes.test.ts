import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ARCHIVE_URL, type PresentationArchive } from './presentation'
import { TERRAIN_SCENES, terrainScenario } from './terrainScenes'
const archive = JSON.parse(readFileSync(new URL('../../public' + ARCHIVE_URL, import.meta.url), 'utf8')) as PresentationArchive
describe('fixed terrain monitor bindings', () => {
  it('has exactly one distinct display monitor per slope, covering all five archived grades', () => {
    expect(new Set(TERRAIN_SCENES.map(s=>s.siteId)).size).toBe(7)
    expect(new Set(TERRAIN_SCENES.map(s=>s.monitorId)).size).toBe(7)
    const grades=TERRAIN_SCENES.map(s=>terrainScenario(archive,s.siteId)?.source?.prediction?.combined_level)
    expect(grades).toEqual([0,4,1,2,3,0,2]);expect([...new Set(grades)].sort()).toEqual([0,1,2,3,4])
  })
  it('does not fall back to node 01 or calm when a bound source is missing', () => {
    const without02={...archive,scenes:archive.scenes.filter(s=>s.device.device_id!=='slope-node-02')}
    expect(terrainScenario(without02,'gaolan')?.source).toBeNull()
    expect(terrainScenario(null,'gaolan')?.source).toBeNull();expect(terrainScenario(archive,'unknown')).toBeNull()
  })
  it('references source observations without relabelling coordinates or modifying the archive', () => {
    const before=JSON.stringify(archive)
    for(const binding of TERRAIN_SCENES)expect(terrainScenario(archive,binding.siteId)?.source).toBe(archive.scenes.find(s=>s.device.device_id===binding.sourceDeviceId)?.device)
    expect(JSON.stringify(archive)).toBe(before)
  })
})
