import type { TerrainReserve } from '../terrainReserveTypes'
import { reserve as baijiabao } from './baijiabao'
import { reserve as gaolan } from './gaolan'
import { reserve as shuiping } from './shuiping'
import { reserve as baishuihe } from './baishuihe'
import { reserve as bazimen } from './bazimen'
import { reserve as xintan } from './xintan'
import { reserve as lianziya } from './lianziya'
export const TERRAIN_RESERVE: Record<string, TerrainReserve> = { baijiabao, gaolan, shuiping, baishuihe, bazimen, xintan, lianziya }
