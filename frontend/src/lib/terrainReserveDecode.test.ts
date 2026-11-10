import { describe, expect, it } from 'vitest'
import { TERRAIN_RESERVE } from './terrainReserve'
import { unpackTerrainReserve } from './terrainReserveDecode'
describe('terrain reserve integrity',()=>{
 it('rejects a modified gzip checksum before using a terrain',()=>{
  const original=TERRAIN_RESERVE.baijiabao,bytes=Uint8Array.from(atob(original.packed),c=>c.charCodeAt(0))
  bytes[bytes.length-8]^=1
  const packed=Buffer.from(bytes).toString('base64')
  expect(()=>unpackTerrainReserve({...original,packed})).toThrow('内容校验')
 })
 it('rejects truncated content rather than returning an empty terrain',()=>{
  expect(()=>unpackTerrainReserve({...TERRAIN_RESERVE.baijiabao,packed:'AA=='})).toThrow('不完整')
 })
})
