import { gunzipSync } from 'three/examples/jsm/libs/fflate.module.js'
import type { TerrainReserve } from './terrainReserveTypes'
import { GRID_N } from './terrain'

const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
export function unpackTerrainReserve(reserve: TerrainReserve) {
  const binary = atob(reserve.packed), packed = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) packed[i] = binary.charCodeAt(i)
  if (packed.length < 18 || reserve.bytes !== GRID_N * GRID_N * 4) throw new Error('高程网格不完整')
  const trailer = new DataView(packed.buffer)
  if (trailer.getUint32(packed.length - 4, true) !== reserve.bytes) throw new Error('高程网格长度校验失败')
  const shuffled = gunzipSync(packed)
  if (shuffled.length !== reserve.bytes) throw new Error('高程网格不完整')
  let crc = 0xffffffff
  for (const byte of shuffled) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  if (((crc ^ 0xffffffff) >>> 0) !== trailer.getUint32(packed.length - 8, true)) throw new Error('高程网格内容校验失败')
  const bytes = new Uint8Array(shuffled.length), n = shuffled.length / 4
  for (let lane = 0; lane < 4; lane++) for (let i = 0; i < n; i++) bytes[i * 4 + lane] = shuffled[lane * n + i]
  const heights = new Float32Array(bytes.buffer)
  if (heights.some(h => !Number.isFinite(h) || h < -100 || h > 9000)) throw new Error('高程网格无效')
  return heights
}
