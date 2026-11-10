/** WGS-84 → GCJ-02 坐标转换。
 *
 *  我们的点位坐标来自 GPS/数据集（WGS-84），而高德底图是 GCJ-02（火星坐标），
 *  两者在国内相差 100–600 m。不做转换，放大后点位会明显偏到路对面。
 *  算法是公开的通用实现（国内地图 SDK 普遍采用）。
 */

const PI = Math.PI
const A = 6378245.0            // 克拉索夫斯基椭球长半轴
const EE = 0.00669342162296594323

function outOfChina(lon: number, lat: number): boolean {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y
    + 0.2 * Math.sqrt(Math.abs(x))
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0
  ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0
  ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0
  return ret
}

function transformLon(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0
  ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0
  ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0
  return ret
}

export function wgs84ToGcj02(lon: number, lat: number): [number, number] {
  if (outOfChina(lon, lat)) return [lon, lat]
  const dLat0 = transformLat(lon - 105.0, lat - 35.0)
  const dLon0 = transformLon(lon - 105.0, lat - 35.0)
  const radLat = lat / 180.0 * PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  const dLat = (dLat0 * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI)
  const dLon = (dLon0 * 180.0) / (A / sqrtMagic * Math.cos(radLat) * PI)
  return [lon + dLon, lat + dLat]
}

/** GCJ-02 → WGS-84（正变换的迭代反解）。
 *
 *  用途：专业底图（高德）上点选的坐标是 GCJ-02，而系统里所有点位/接口都存 WGS-84
 *  （离线图点选、数据集站点、设备坐标全是 WGS）——不转回来，人工新增的点位
 *  在离线图上会偏移几百米。迭代两次后误差 <1 m（差分在国内变化平缓）。
 */
export function gcj02ToWgs84(lon: number, lat: number): [number, number] {
  if (outOfChina(lon, lat)) return [lon, lat]
  let wLon = lon
  let wLat = lat
  for (let i = 0; i < 2; i += 1) {
    const [gLon, gLat] = wgs84ToGcj02(wLon, wLat)
    wLon -= gLon - lon
    wLat -= gLat - lat
  }
  return [wLon, wLat]
}
