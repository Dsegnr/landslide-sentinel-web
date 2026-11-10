import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { surfaceRangeGeometry, surfaceRangeMaterial } from './terrainRange'
describe('terrain-conforming range',()=>{
 it('uses exact original terrain triangles even across a sharp ridge',()=>{
  const n=32,plane=new THREE.PlaneGeometry(2000,2000,n-1,n-1),positions=plane.getAttribute('position')
  for(let k=0;k<positions.count;k++)positions.setZ(k,k%n===15?800:30)
  const before=Array.from(positions.array),range=surfaceRangeGeometry(plane,2000,2000,n,0,0,320)
  expect(range.getAttribute('position')).toBe(positions)
  const original=new Set<string>(),indices=plane.getIndex()!
  for(let i=0;i<indices.count;i+=3)original.add([indices.getX(i),indices.getX(i+1),indices.getX(i+2)].join(','))
  const subset=range.getIndex()!
  expect(subset.count).toBeGreaterThan(0);expect(subset.count).toBeLessThan(indices.count)
  for(let i=0;i<subset.count;i+=3)expect(original.has([subset.getX(i),subset.getX(i+1),subset.getX(i+2)].join(','))).toBe(true)
  expect(Array.from(positions.array)).toEqual(before)
  plane.dispose();range.dispose()
 })
 it('keeps exact radius, depth occlusion and a thin boundary',()=>{
  const material=surfaceRangeMaterial(40,-80,320,0x7fe3ff)
  expect(material.uniforms.uRadius.value).toBe(320)
  expect(material.uniforms.uCenter.value.toArray()).toEqual([40,-80])
  expect(material.uniforms.uWidth.value).toBeCloseTo(5.76)
  expect(material.depthTest).toBe(true);expect(material.depthWrite).toBe(false)
  material.dispose()
 })
})
