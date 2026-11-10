/** 三维坡体：用真实高程（DEM）把滑坡所在的坡体立起来看。
 *
 *  数据来源：AWS Terrain Tiles（公开瓦片、离线打包进 public/terrain/），
 *  页面解码 → three.js 渲染；没有任何在线地图/接口依赖，断网也能演示。
 *
 *  这一页只做"看得清"：地形、站点、位移方向、影响范围。
 *  影响范围是**示意半径**（真实影响区要等坡度/岩土参数标定），界面上如实标注。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

import NavBar from '../components/NavBar'
import MobileTabs from '../components/MobileTabs'
import Panel from '../components/Panel'
import { usePolling } from '../hooks/usePolling'
import type { Route } from '../hooks/useHashRoute'
import { presentationApi as api } from '../lib/presentationApi'
import { loadPresentation } from '../lib/presentation'
import { TERRAIN_SCENES, terrainScenario } from '../lib/terrainScenes'
import { scheduleTerrainCatalogPreparation } from '../lib/routeResources'
import { loadTerrain, loadTerrainOsm, type TerrainData } from '../lib/terrainAssets'
import { surfaceRangeGeometry, surfaceRangeMaterial } from '../lib/terrainRange'
import type { Session } from '../lib/auth'
import { fmtAgo, fmtNum, fmtShort } from '../lib/format'
import {
  classifyPlaces, classifyRoads, placeKindCn, roadKindCn, type OsmData,
} from '../lib/impact'
import { levelColor, levelMeta } from '../lib/levels'
import { SITES, findSite } from '../lib/sites'
import {
  GRID_N, applyEnergyLine, cellSizeMeters, computeRunout, lonLatToCell,
  lonLatToPlane, planeToLonLat, sampleHeight, slopeAt, terrainColor,
} from '../lib/terrain'

// 推演参数的可调范围（滑块边界）。默认值**不写死**：
// 按各站点 DEM 的"地形预算"自动给（起点到最低点的高差 / DEM 的水平尺度），
// 见下面的 terrainBudget + 默认值 effect。固定 150 m 曾把皋兰山截在半山腰（P22）。
const DROP_MIN = 50
const DROP_MAX = 600
const DIST_MIN = 300
const DIST_MAX = 8000

// "惯性"参数：允许 ≤12% 的缓坡通行（≈6.8°），全程总上坡不超过落差预算的 10%（下限 15 m）。
// 取值依据是离线扫描（_tools/_qa_runout_check.py）：皋兰山 8% 就能铺到坡脚平地，
// 白家包要 12%；再往上（15%/20%）就开始爬真正的山坡了，不符合"滑坡体靠惯性翻小坎"的物理。
const CLIMB_GRADE = 0.12
const CLIMB_BUDGET_FRAC = 0.10
const CLIMB_BUDGET_MIN_M = 15

// 推演范围圈的**固定色**：刻意不是等级色。
// 用与"自选源区"标记同色系的青蓝，与坡面可达区的琥珀/橙/红三档拉开区分。
const RING_COLOR = 0x7fe3ff

// 移动角下限（Fahrböschung）：默认 10°。黄土滑坡/泥流常见的移动角大约 10–25°，
// 取偏流动的一端当默认值；调大 = 只保留"常规滑坡就够得着"的范围。
const MIN_ANGLE_DEFAULT = 10
const MIN_ANGLE_MIN = 5
const MIN_ANGLE_MAX = 25

interface Props {
  active?: boolean
  onPrepared?: () => void
  session: Session
  route: Route
  onNavigate: (r: Route) => void
  onLogout: () => void
}

/** 给地形块加"侧壁"：把边界一圈从地面高度垂到基座顶面。
 *
 *  不加这一段，从侧面看会看到地形平面与基座之间的缝隙（渲染出来像一圈栅栏）。
 */
function buildSkirt(
  heights: Float32Array, n: number, width: number, depth: number,
  yScale: number, elevMin: number, baseY: number,
): THREE.BufferGeometry {
  const pos: number[] = []
  const at = (i: number, j: number) => heights[j * n + i]
  const px = (i: number) => (i / (n - 1) - 0.5) * width
  const pz = (j: number) => (j / (n - 1) - 0.5) * depth
  const py = (h: number) => (h - elevMin) * yScale
  const quad = (
    x1: number, z1: number, y1: number, x2: number, z2: number, y2: number,
  ) => {
    pos.push(x1, y1, z1, x2, y2, z2, x2, baseY, z2)
    pos.push(x1, y1, z1, x2, baseY, z2, x1, baseY, z1)
  }
  for (let i = 0; i < n - 1; i++) {
    // 北边（j=0）与南边（j=n-1）
    quad(px(i), pz(0), py(at(i, 0)), px(i + 1), pz(0), py(at(i + 1, 0)))
    quad(px(i + 1), pz(n - 1), py(at(i + 1, n - 1)),
      px(i), pz(n - 1), py(at(i, n - 1)))
  }
  for (let j = 0; j < n - 1; j++) {
    // 西边（i=0）与东边（i=n-1）
    quad(px(0), pz(j + 1), py(at(0, j + 1)), px(0), pz(j), py(at(0, j)))
    quad(px(n - 1), pz(j), py(at(n - 1, j)),
      px(n - 1), pz(j + 1), py(at(n - 1, j + 1)))
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.computeVertexNormals()
  return geo
}

const TERRAIN_SITES: string[] = TERRAIN_SCENES.map(scene => scene.siteId)

export default function TerrainPage({ session, route, onNavigate, onLogout, active = true, onPrepared }: Props) {
  const [siteId, setSiteId] = useState(TERRAIN_SITES[0])
  const [data, setData] = useState<TerrainData | null>(null)
  const [osm, setOsm] = useState<OsmData | null>(null)
  const [error, setError] = useState('')
  const [prepared, setPrepared] = useState(false)
  const [osmReady, setOsmReady] = useState(false)
  const [configuredData, setConfiguredData] = useState<TerrainData | null>(null)
  const [webglError, setWebglError] = useState('')
  const [exaggeration, setExaggeration] = useState(1.8)
  const [radiusRatio, setRadiusRatio] = useState(0.16)
  const [showRing, setShowRing] = useState(true)
  const [showArrow, setShowArrow] = useState(true)
  const [wireframe, setWireframe] = useState(false)
  const [spin, setSpin] = useState(false)
  const [showRunout, setShowRunout] = useState(true)
  const [showRoads, setShowRoads] = useState(true)
  const [showWater, setShowWater] = useState(true)
  // 滑坡源区：null = 用监测站坐标（默认，站通常在滑体前缘）；用户可在三维图上点选源区。
  // 为什么需要：从"站"出发做下坡推演，绝大部分路径只能往江里走，范围会明显偏小（P26）。
  const [sourceLonLat, setSourceLonLat] = useState<[number, number] | null>(null)
  const [pickMode, setPickMode] = useState(false)
  // 推演参数：滑块实时显示、真正重算做 250ms 去抖（重算是分辨率级的循环，别让拖拽卡住）
  const [maxDrop, setMaxDrop] = useState(150)
  // 移动角下限（Fahrböschung）：α 小于它的像元只有高流动性/大规模事件才够得着，
  // 默认不计入可达区 —— 这是"范围别画得太大"的关键参数。
  const [minAngle, setMinAngle] = useState(MIN_ANGLE_DEFAULT)
  const [applied, setApplied] = useState({ drop: 150, angle: MIN_ANGLE_DEFAULT })
  // 手机端栏目（<768px 生效）：坡体选择 / 三维地形 / 坡体信息
  const [pane, setPane] = useState<'setup' | 'terrain' | 'info'>('terrain')

  const mountRef = useRef<HTMLDivElement | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const materialPoolRef = useRef(new Map<string, THREE.Material>())
  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const groupRef = useRef<THREE.Group | null>(null)
  const ringRef = useRef<THREE.Mesh | null>(null)
  const waterRef = useRef<THREE.Mesh | null>(null)
  const markerRef = useRef<THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial> | null>(null)
  const poseArrowRef = useRef<THREE.ArrowHelper | null>(null)
  const resumeRef = useRef<(() => void) | null>(null)
  const activeRef = useRef(active)
  const preparedRef = useRef(onPrepared)
  activeRef.current = active
  preparedRef.current = onPrepared
  // 给场景里的事件回调读最新状态用（避免因为 pickMode 变化重建整个场景）
  const pickModeRef = useRef(false)
  const pickHandlerRef = useRef<(lon: number, lat: number) => void>(() => {})
  const arrowRef = useRef<THREE.Group | null>(null)
  const frameRef = useRef<number>(0)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    if (prepared) return scheduleTerrainCatalogPreparation(TERRAIN_SITES[0])
  }, [prepared])

  const { data: archive, loading: devicesLoading, error: sceneError, refresh: retryScene } = usePolling(loadPresentation, 30000, [], active || !prepared)
  const site = findSite(siteId) ?? SITES[0]
  const devices = useMemo(() => archive?.scenes.map(scene => scene.device) ?? [], [archive])
  const scenario = useMemo(() => terrainScenario(archive, siteId), [archive, siteId])
  const device = scenario?.source ?? null
  const monitorName = `${site.short}演示监测点`
  const level = device?.prediction?.combined_level ?? 0
  const noData = !device?.prediction || device.prediction.data_available === false
  const accent = noData ? '#94a3b8' : levelColor(level)
  // 库水面标高：优先用后端下发的库水位（外部水文数据），没有就按三峡正常蓄水位 175 m
  const waterLevelM = useMemo(() => {
    const withLevel = device?.has_level && device.level_m != null ? device : devices.find((d) => d.has_level && d.level_m != null)
    return withLevel?.level_m ?? 175
  }, [devices, device])
  // 推演起点：默认监测站（DEM 中心 = 站点坐标），可被点选覆盖
  const sourceLon = sourceLonLat?.[0] ?? data?.meta.center[0] ?? site.lon
  const sourceLat = sourceLonLat?.[1] ?? data?.meta.center[1] ?? site.lat
  useEffect(() => { pickModeRef.current = pickMode }, [pickMode])
  useEffect(() => {
    pickHandlerRef.current = (lon: number, lat: number) => {
      setSourceLonLat([lon, lat])
      setPickMode(false)
    }
  }, [])
  // 换坡体时清掉自选源区
  useEffect(() => { setSourceLonLat(null) }, [siteId])

  // 读高程
  useEffect(() => {
    if (data?.meta.site === siteId && osmReady) return
    let alive = true
    setError('')
    setData(null)
    setOsm(null)
    setOsmReady(false)
    Promise.all([loadTerrain(siteId), loadTerrainOsm(siteId).catch(() => null)])
      .then(([d, roads]) => { if (alive) { setData(d); setOsm(roads); setOsmReady(true) } })
      .catch((e: Error) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [siteId, active])

  useEffect(() => {
    const t = setTimeout(() => setApplied(previous => previous.drop === maxDrop && previous.angle === minAngle ? previous : { drop: maxDrop, angle: minAngle }), 250)
    return () => clearTimeout(t)
  }, [maxDrop, minAngle])

  const siteLon = site.lon
  const siteLat = site.lat

  // 天气：只作"关注权重"参比，30 分钟刷一次（后端还有一层缓存）
  const { data: weather } = usePolling(
    () => api.weather(siteLon, siteLat), 30 * 60 * 1000, [siteLon, siteLat], active)

  // 这份 DEM 的"地形预算"：起点高程、最低点、以及水平尺度。
  // 必须在 runout 之前算：推演要拿"高差 / tan(移动角)"反推洪泛的距离上界。
  const terrainBudget = useMemo(() => {
    if (!data) return null
    const { meta, heights } = data
    const [ci, cj] = lonLatToCell(sourceLon, sourceLat, meta.bbox, GRID_N)
    const startH = heights[Math.round(cj) * GRID_N + Math.round(ci)]
    let minH = Infinity
    for (let k = 0; k < heights.length; k++) if (heights[k] < minH) minH = heights[k]
    const cellM = cellSizeMeters(meta.bbox, GRID_N)
    // 这片坡面"能提供的最大移动角"：max (起点高程差 / 到起点水平距离)。
    // 用它来自适应默认的移动角下限——陡的坡体（皋兰山 36.7°）用 10°，
    // 缓的坡体（白家包只有 8.3°）自动放到 5°，避免"默认阈值一刀切 → 整片被筛空"。
    let maxTan = 0
    for (let j = 0; j < GRID_N; j++) {
      for (let i = 0; i < GRID_N; i++) {
        const d = Math.hypot(i - ci, j - cj)
        if (d < 1) continue
        const t = (startH - heights[j * GRID_N + i]) / (d * cellM)
        if (t > maxTan) maxTan = t
      }
    }
    return {
      startH,
      minH,
      relief: Math.max(0, startH - minH),
      spanM: cellM * (GRID_N - 1),
      maxAngleDeg: (Math.atan(maxTan) * 180) / Math.PI,
    }
  }, [data, sourceLon, sourceLat])

  // 下坡可达区推演 + 移动角分级（只用地形，参数变了才重算）
  const runout = useMemo(() => {
    if (!data || !terrainBudget || configuredData !== data) return null
    const { meta, heights } = data
    const [ci, cj] = lonLatToCell(sourceLon, sourceLat, meta.bbox, GRID_N)
    const cellsM = cellSizeMeters(meta.bbox, GRID_N)
    // 距离上界由移动角反推：tanα = 落差 / 距离 ⇒ 距离 = 落差 / tanα。
    // 超过这个距离的像元不可能满足移动角，洪泛直接不用往外铺（省算力）。
    const tanMin = Math.tan((applied.angle * Math.PI) / 180)
    const distCap = Math.min(DIST_MAX, Math.max(DIST_MIN, terrainBudget.relief / tanMin))
    const raw = computeRunout(heights, GRID_N, cellsM, ci, cj, applied.drop, distCap, {
      maxClimbPerCell: CLIMB_GRADE * cellsM,
      maxClimbTotal: Math.max(CLIMB_BUDGET_MIN_M, applied.drop * CLIMB_BUDGET_FRAC),
    })
    return applyEnergyLine(raw, GRID_N, cellsM, ci, cj, applied.angle)
  }, [data, terrainBudget, applied, sourceLon, sourceLat, configuredData])

  // 换站点（新 DEM 到位）时按地形预算重置默认参数；用户之后手动拖动不受影响。
  useEffect(() => {
    if (!terrainBudget) return
    const drop = Math.min(DROP_MAX, Math.max(DROP_MIN, Math.ceil(terrainBudget.relief / 10) * 10))
    // 移动角下限自适应：取坡面最大移动角的 60%，夹在 5–10°。
    // 陡坡（皋兰山）→ 10°，缓坡（白家包）→ 5°，都不会被默认值筛空。
    const angle = Math.min(MIN_ANGLE_DEFAULT, Math.max(
      MIN_ANGLE_MIN, Math.round(terrainBudget.maxAngleDeg * 0.6),
    ))
    setMaxDrop(drop)
    setMinAngle(angle)
    setApplied(previous => previous.drop === drop && previous.angle === angle ? previous : { drop, angle })
    setConfiguredData(data)
  }, [terrainBudget])

  // 推演实际到达的最低高程：用来回答"它是被参数截断，还是地形到头了"
  const reachedMinH = useMemo(() => {
    if (!data || !runout || runout.cells === 0) return null
    let minH = Infinity
    for (let k = 0; k < runout.mask.length; k++) {
      if (runout.mask[k] && data.heights[k] < minH) minH = data.heights[k]
    }
    return Number.isFinite(minH) ? minH : null
  }, [data, runout])

  // 是否被参数截断：容差取 1 个像元，避免"3198 / 3200"这种差一点就判不出来
  // （曾经用 1 m 容差，结果距离已经触顶但提示不显示）
  const cellM = data ? cellSizeMeters(data.meta.bbox, GRID_N) : 0
  const dropCapped = !!runout && runout.cells > 0 && runout.maxDrop >= applied.drop - cellM
  // 已经走到本图最低点就不算"被落差截断"——那时提示会误导
  const reachedFloor = reachedMinH !== null && !!terrainBudget
    && reachedMinH - terrainBudget.minH <= 5
  const showTruncHint = !!runout && runout.cells > 0 && dropCapped && !reachedFloor
  const km2 = (v?: number) => (v !== undefined && v > 0.005 ? `${v.toFixed(2)} km²` : '—')

  const inZone = useCallback((lon: number, lat: number): boolean => {
    if (!data || !runout) return false
    const [i, j] = lonLatToCell(lon, lat, data.meta.bbox, GRID_N)
    const ii = Math.round(i)
    const jj = Math.round(j)
    if (ii < 0 || jj < 0 || ii >= GRID_N || jj >= GRID_N) return false
    return runout.mask[jj * GRID_N + ii] === 1
  }, [data, runout])

  const roadImpacts = useMemo(
    () => (osm && runout ? classifyRoads(osm.roads, inZone, siteLon, siteLat) : []),
    [osm, runout, inZone, siteLon, siteLat],
  )
  const placeImpacts = useMemo(
    () => (osm && runout ? classifyPlaces(osm.places, inZone, siteLon, siteLat) : []),
    [osm, runout, inZone, siteLon, siteLat],
  )
  const inZoneRoads = roadImpacts.filter((r) => r.inZone).length
  const nearestRoadM = roadImpacts.length
    ? Math.min(...roadImpacts.map((r) => r.nearestM))
    : null
  const nearestPlaceM = placeImpacts.length
    ? Math.min(...placeImpacts.map((p) => p.distanceM))
    : null
  const affectedPlaces = placeImpacts.filter((p) => p.inZone)
  const runoutAreaKm2 = runout
    ? (runout.cells * Math.pow(cellSizeMeters(data?.meta.bbox ?? {
      west: 0, east: 0, north: 0, south: 0 }, GRID_N), 2)) / 1e6
    : 0

  // 建场景（站点/夸张系数/线框变化时重建）
  useEffect(() => {
    const mount = mountRef.current
    if (!mount || !data || devicesLoading || configuredData !== data || !osmReady) return

    let renderer: THREE.WebGLRenderer
    try {
      renderer = rendererRef.current ?? new THREE.WebGLRenderer({ antialias: true, alpha: true })
    } catch (e) {
      setWebglError(`当前浏览器/环境无法创建 WebGL 画布：${(e as Error).message}`)
      return
    }
    rendererRef.current = renderer
    // Keep the few shared shader programs resident between slopes. Disposing the
    // last material of each type forces expensive recompilation on every switch.
    const resident = <T extends THREE.Material,>(key: string, create: () => T): T => {
      const pool = materialPoolRef.current
      if (!pool.has(key)) pool.set(key, create())
      return pool.get(key) as T
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    if (renderer.domElement.parentElement !== mount) mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    // 远处渐隐：地形边缘在掠射角下会呈现逐三角形的明暗梳齿，
    // 用与背景同色的雾把它融掉，观感干净，也不丢近处细节。
    scene.fog = new THREE.Fog(0x050c18, 1500, 4200)
    sceneRef.current = scene
    const camera = new THREE.PerspectiveCamera(
      45, mount.clientWidth / Math.max(1, mount.clientHeight), 1, 40000)
    cameraRef.current = camera

    const { meta, heights } = data
    const width = 2000                                  // 场景单位（约等于 6.3 km 的示意）
    const depth = width

    const group = new THREE.Group()
    groupRef.current = group
    scene.add(group)

    // 地形网格
    const n = GRID_N
    const geo = new THREE.PlaneGeometry(width, depth, n - 1, n - 1)
    const relief = Math.max(1, meta.elev_max - meta.elev_min)
    const yScale = (width * 0.22 / relief) * exaggeration
    const pos = geo.attributes.position as THREE.BufferAttribute
    const colors = new Float32Array(n * n * 3)
    const cellMeters = Math.abs(meta.bbox.east - meta.bbox.west) * 111_000
      * Math.cos((meta.center[1] * Math.PI) / 180) / (n - 1)
    let steep = 0
    let steepMax = 0
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i
        const h = heights[idx]
        pos.setZ(idx, (h - meta.elev_min) * yScale)
        const t = (h - meta.elev_min) / relief
        const slope = slopeAt(heights, n, i, j, cellMeters)
        if (slope > 0.45) steep++
        steepMax = Math.max(steepMax, slope)
        // 高程色带 × 坡度提亮：陡坡更亮，缓坡更暗，视觉上能一眼看出陡坎
        const [r, g, b] = terrainColor(t)
        const k = 1 + Math.min(0.55, slope * 0.8)
        colors[idx * 3] = Math.min(1, r * k)
        colors[idx * 3 + 1] = Math.min(1, g * k)
        colors[idx * 3 + 2] = Math.min(1, b * k)
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.computeVertexNormals()
    const mat = resident('terrain', () => new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.92, metalness: 0.05,
      wireframe, flatShading: false, side: THREE.DoubleSide,
    }))
    mat.wireframe = wireframe
    const mesh = new THREE.Mesh(geo, mat)
    mesh.rotation.x = -Math.PI / 2
    group.add(mesh)

    // 基座 + 侧壁：把地形做成"一块地"，而不是一张悬空的薄板
    const baseY = -width * 0.002
    const baseDepth = Math.max(width * 0.06, relief * yScale * 1.4)
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(width, baseDepth, depth),
      resident('base', () => new THREE.MeshStandardMaterial({ color: 0x081524, roughness: 1, metalness: 0 })),
    )
    base.position.set(0, baseY - baseDepth / 2, 0)
    group.add(base)

    const skirt = new THREE.Mesh(
      buildSkirt(heights, n, width, depth, yScale, meta.elev_min, baseY),
      // 侧壁用**不受光**的暗色：边界会穿过许多冲沟，受光的话每一片明暗不同，
      // 远看像一圈栅栏；统一暗色就只剩"一块地的侧面"这个信息。
      resident('skirt', () => new THREE.MeshBasicMaterial({ color: 0x0b1f33, side: THREE.DoubleSide })),
    )
    group.add(skirt)

    // 库水面（只给三峡库区的坡体画）：水位取后端库水位，取不到就用正常蓄水位 175 m。
    // 没有水面时，库区滑坡看上去就是"一片山"，有了它才一眼看出哪一段是没入库的坡体。
    let water: THREE.Mesh | null = null
    if (site.reservoir) {
      const levelM = waterLevelM
      const waterGeo = new THREE.PlaneGeometry(width * 1.6, depth * 1.6)
      water = new THREE.Mesh(waterGeo, resident('water', () => new THREE.MeshPhongMaterial({
        color: 0x2f86d0, transparent: true, opacity: 0.55, shininess: 120,
        specular: 0x9fd8ff, side: THREE.DoubleSide, depthWrite: false,
      })))
      water.rotation.x = -Math.PI / 2
      water.position.set(0, (levelM - meta.elev_min) * yScale, 0)
      water.visible = showWater
      group.add(water)
    }
    waterRef.current = water

    // 影响区叠加：把"下坡可达像元"画在地形上（随坡起伏，不是一块平板）
    if (runout && showRunout && runout.cells > 0) {
      const cv = document.createElement('canvas')
      cv.width = n
      cv.height = n
      const ctx = cv.getContext('2d')
      if (ctx) {
        const img = ctx.createImageData(n, n)
        // 三级强度着色（相对强度，不是概率）：
        //   高 α≥20°：常规滑坡就够得着 → 实、偏红
        //   中 15–20°：需要较高流动性 → 橙
        //   低 <15°：只有大规模/高含水泥石流才可能到 → 浅、淡
        const TIERS = [
          { r: 255, g: 186, b: 74, a: 108 },     // 低（比原来更饱和/更实，避免被当成地形本色）
          { r: 255, g: 132, b: 48, a: 162 },     // 中
          { r: 255, g: 74, b: 44, a: 208 },      // 高
        ]
        for (let idx = 0; idx < n * n; idx++) {
          if (!runout.mask[idx]) continue
          const c = TIERS[runout.tier[idx]] ?? TIERS[0]
          img.data[idx * 4] = c.r
          img.data[idx * 4 + 1] = c.g
          img.data[idx * 4 + 2] = c.b
          img.data[idx * 4 + 3] = c.a
        }
        ctx.putImageData(img, 0, 0)
        // 边缘柔化：像元级二值 mask 直接贴上去，边界会很"硬"（像贴纸切一刀）。
        // 对 alpha 做一次 1 px 模糊再贴，边界就有过渡；颜色与透明度的关系不变。
        const soft = document.createElement('canvas')
        soft.width = n
        soft.height = n
        const sctx = soft.getContext('2d')
        if (sctx) {
          sctx.filter = 'blur(1px)'          // 浏览器不支持 filter 时会画出原图，不会更糟
          sctx.drawImage(cv, 0, 0)
          ctx.clearRect(0, 0, n, n)
          ctx.drawImage(soft, 0, 0)
        }
        const tex = new THREE.CanvasTexture(cv)
        const overlay = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({
          map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        }))
        overlay.rotation.x = -Math.PI / 2
        overlay.position.y = 1.5
        group.add(overlay)
      }
    }

    // 路网：按真实经纬度贴到地形上，落在影响区内的路段高亮
    if (osm && showRoads) {
      const posArr: number[] = []
      const colArr: number[] = []
      const colorIn = new THREE.Color(0xffb066)
      // 域外路网：原来用深蓝 0x27506f，和深色地形糊在一起，换了峡谷点位后几乎看不见
      // （队长实测反馈"路呢？"）。提亮成浅钢蓝，保证在灰蓝地形上看得出来。
      const colorOut = new THREE.Color(0x8fc0e8)
      const toWorld = (lon: number, lat: number): [number, number, number] => {
        const [x, z] = lonLatToPlane(lon, lat, meta.bbox, width, depth)
        const [ci, cj] = lonLatToCell(lon, lat, meta.bbox, GRID_N)
        const h = sampleHeight(heights, GRID_N, ci, cj)
        const y = h === null ? 0 : (h - meta.elev_min) * yScale
        return [x, y + 4, z]
      }
      // 越出 DEM 图幅的顶点贴不到地面：以前会掉到 y=0（地块底面），画出来就是几根
      // 悬在场景里的杂线。跨出图幅的路段直接不画，只保留真正贴得住地面的部分。
      const inGrid = (lon: number, lat: number): boolean => {
        const [ci, cj] = lonLatToCell(lon, lat, meta.bbox, GRID_N)
        return ci >= 0 && cj >= 0 && ci <= GRID_N - 1 && cj <= GRID_N - 1
      }
      for (const road of osm.roads) {
        for (let k = 0; k + 1 < road.pts.length; k++) {
          const [lon0, lat0] = road.pts[k]
          const [lon1, lat1] = road.pts[k + 1]
          if (!inGrid(lon0, lat0) || !inGrid(lon1, lat1)) continue
          const a = toWorld(lon0, lat0)
          const b = toWorld(lon1, lat1)
          posArr.push(...a, ...b)
          const c = inZone(lon0, lat0) ? colorIn : colorOut
          colArr.push(c.r, c.g, c.b, c.r, c.g, c.b)
        }
      }
      if (posArr.length) {
        const roadGeo = new THREE.BufferGeometry()
        roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3))
        roadGeo.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3))
        group.add(new THREE.LineSegments(roadGeo, new THREE.LineBasicMaterial({
          vertexColors: true, transparent: true, opacity: 0.95,
        })))
      }
    }

    // 村镇点位：受影响的高亮放大
    if (osm) {
      for (const p of placeImpacts) {
        const [x, z] = lonLatToPlane(p.lon, p.lat, meta.bbox, width, depth)
        const [ci, cj] = lonLatToCell(p.lon, p.lat, meta.bbox, GRID_N)
        const h = sampleHeight(heights, GRID_N, ci, cj)
        if (h === null) continue                    // 图幅外的村镇：贴不到地面，别画成浮块
        const y = (h - meta.elev_min) * yScale
        const size = p.inZone ? width * 0.011 : width * 0.006
        const marker2 = new THREE.Mesh(
          new THREE.OctahedronGeometry(size),
          new THREE.MeshBasicMaterial({ color: p.inZone ? 0xff8a5c : 0x6fa8c8 }),
        )
        marker2.position.set(x, y + width * 0.012, z)
        group.add(marker2)
      }
    }

    // 光照（固定西北向，和制图习惯一致）
    const sun = new THREE.DirectionalLight(0xd8ecff, 1.25)
    sun.position.set(-width * 0.6, width * 0.55, -width * 0.4)
    scene.add(sun)
    scene.add(new THREE.AmbientLight(0x2a4a6a, 1.1))

    // 站点标记（监测站，固定在站点坐标）+ 影响圈（跟着推演起点走）
    const [cx, cz] = lonLatToPlane(meta.center[0], meta.center[1], meta.bbox, width, depth)
    const [sx, sz] = lonLatToPlane(sourceLon, sourceLat, meta.bbox, width, depth)
    const surface = (heights[Math.floor(n / 2) * n + Math.floor(n / 2)] - meta.elev_min) * yScale
    const srcCell = lonLatToCell(sourceLon, sourceLat, meta.bbox, GRID_N)
    const srcH = sampleHeight(heights, GRID_N, srcCell[0], srcCell[1])
    const srcY = ((srcH ?? meta.elev_min) - meta.elev_min) * yScale

    const marker = new THREE.Mesh(
      new THREE.ConeGeometry(width * 0.012, width * 0.05, 4),
      resident('monitor', () => new THREE.MeshBasicMaterial({ color: accent })),
    )
    marker.material.color.set(accent)
    marker.position.set(cx, surface + width * 0.03, cz)
    markerRef.current = marker
    group.add(marker)

    // 自选滑坡源区时，在源区再插一个醒目的标记（白蓝菱形 + 一根竖线），
    // 免得"圈移走了、站还在"，看不出起点换到哪儿了。
    if (sourceLonLat) {
      const pin = new THREE.Mesh(
        new THREE.OctahedronGeometry(width * 0.009, 0),
        new THREE.MeshBasicMaterial({ color: 0x7fe3ff }),
      )
      pin.position.set(sx, srcY + width * 0.022, sz)
      group.add(pin)
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(width * 0.0012, width * 0.0012, width * 0.03, 6),
        new THREE.MeshBasicMaterial({ color: 0x7fe3ff, transparent: true, opacity: 0.8 }),
      )
      stem.position.set(sx, srcY + width * 0.012, sz)
      group.add(stem)
    }

    // 推演范围圈：贴着地形起伏的环带 + 浅色填充（不再是悬空的水平圆盘）
    //
    // 颜色刻意**不用等级色**：这个圈表示"推演半径"这一几何量，与当前预警等级无关。
    // 之前用 accent（等级色）导致误读——圈变绿时被当成"没有影响区域了"，
    // 而真正的下坡可达区（坡面上那片橙红）另有 TIERS 三档色、**从不随等级变化**。
    // 等级色只保留在：右侧等级圆环、站点标记、位移方向箭头。
    const radius = width * radiusRatio
    const rangeMaterial = resident('range', () => surfaceRangeMaterial(sx, sz, radius, RING_COLOR))
    rangeMaterial.uniforms.uCenter.value.set(sx, sz)
    rangeMaterial.uniforms.uRadius.value = radius
    rangeMaterial.uniforms.uWidth.value = Math.max(2, radius * .018)
    const ring = new THREE.Mesh(surfaceRangeGeometry(geo, width, depth, n, sx, sz, radius), rangeMaterial)
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 1.5
    ring.visible = showRing
    group.add(ring)
    ringRef.current = ring


    // 位移方向箭头（R/P 两轴，轴向以传感器标定为准）
    const arrowGroup = new THREE.Group()
    arrowRef.current = arrowGroup
    const r = Number(device?.reading?.R ?? 0)
    const p = Number(device?.reading?.P ?? 0)
    const mag = Math.hypot(r, p)
    const len = width * (0.03 + Math.min(0.12, mag * 0.02))
    const dir = mag > 1e-6 ? new THREE.Vector3(p, 0, -r).normalize() : new THREE.Vector3(1, 0, 0)
    const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(cx, surface + width * 0.012, cz),
      len, accent, len * 0.28, len * 0.16)
    arrow.visible = mag > 1e-6
    arrowGroup.add(arrow)
    poseArrowRef.current = arrow
    arrowGroup.visible = showArrow
    group.add(arrowGroup)

    // 相机
    const dist = width * 1.15
    camera.position.set(cx + dist * 0.5, surface + dist * 0.55, cz + dist * 0.68)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(cx, surface, cz)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.minDistance = width * 0.12
    controls.maxDistance = width * 2.2
    controls.maxPolarAngle = Math.PI * 0.495
    controls.autoRotateSpeed = 0.7
    controls.autoRotate = spin
    controlsRef.current = controls

    const onResize = () => {
      const w = mount.clientWidth
      const h = Math.max(1, mount.clientHeight)
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(mount)
    onResize()

    // 点选滑坡源区：在坡面上点一下，把推演起点移过去（范围随地形重算）
    const raycaster = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    let downAt: { x: number; y: number; t: number } | null = null
    const onDown = (e: PointerEvent) => {
      downAt = { x: e.clientX, y: e.clientY, t: Date.now() }
    }
    const onUp = (e: PointerEvent) => {
      const d = downAt
      downAt = null
      if (!d || !pickModeRef.current) return
      // 拖拽超过 6 px 或按住超过 0.8 s 都当作"旋转/平移视角"，不当作点选
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || Date.now() - d.t > 800) return
      const rect = renderer.domElement.getBoundingClientRect()
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(ndc, camera)
      const hit = raycaster.intersectObject(mesh, false)[0]
      if (!hit) return
      const [lon, lat] = planeToLonLat(hit.point.x, hit.point.z, meta.bbox, width, depth)
      pickHandlerRef.current(lon, lat)
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)

    const stats = { steep, steepMax, cellMeters }
    mount.dataset.steep = String(stats.steep)
    mount.dataset.cell = stats.cellMeters.toFixed(1)

    const tick = () => {
      frameRef.current += 1
      controls.autoRotate = spin
      controls.update()
      // 影响圈轻微呼吸，提示"这是活的东西"
      if (ring.visible) {
        // 呼吸改成改透明度：环带是贴地几何（顶点已是世界坐标），
        // 再按整体缩放会把它从站点位置移开。
        rangeMaterial.uniforms.uRingOpacity.value = 0.72 + 0.08 * Math.sin(frameRef.current * 0.05)
      }
      renderer.render(scene, camera)
      mount.dataset.frames = String(frameRef.current)
      mount.dataset.renderedSite = meta.site
      const markerColor = marker.material.color.getHexString()
      if (mount.dataset.monitorColor !== markerColor) mount.dataset.monitorColor = markerColor
      if (activeRef.current && !document.hidden) rafRef.current = requestAnimationFrame(tick)
      else rafRef.current = 0
    }
    tick()
    setPrepared(true)
    preparedRef.current?.()
    resumeRef.current = () => { onResize(); if (!rafRef.current) tick() }
    const onContextLost = () => {
      cancelAnimationFrame(rafRef.current); rafRef.current = 0
      setWebglError('三维图形正在恢复…')
    }
    const onContextRestored = () => {
      setWebglError('')
      if (activeRef.current && !document.hidden) resumeRef.current?.()
      else renderer.render(scene, camera)
    }
    renderer.domElement.addEventListener('webglcontextlost', onContextLost)
    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored)

    return () => {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
      resumeRef.current = null
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored)
      ro.disconnect()
      controls.dispose()
      scene.traverse((o) => {
        const anyO = o as THREE.Mesh
        if (anyO.geometry) anyO.geometry.dispose()
        const m = anyO.material as THREE.Material | THREE.Material[] | undefined
        const disposeMaterial = (material: THREE.Material) => {
          const texture = (material as THREE.MeshBasicMaterial).map
          texture?.dispose()
          if (![...materialPoolRef.current.values()].includes(material)) material.dispose()
        }
        if (Array.isArray(m)) m.forEach(disposeMaterial)
        else if (m) disposeMaterial(m)
      })
      // Keep the one renderer/context for the next slope or parameter change.
      // Drop references held by Three's last render list while scene assets dispose.
      renderer.renderLists.dispose()
      sceneRef.current = null
      cameraRef.current = null
      controlsRef.current = null
      groupRef.current = null
      ringRef.current = null
      arrowRef.current = null
      markerRef.current = null
      poseArrowRef.current = null
      waterRef.current = null
    }
      }, [data, exaggeration, radiusRatio, showRing, wireframe, spin,
        osm, runout, showRunout, showRoads, inZone, placeImpacts, applied.drop,
        sourceLon, sourceLat, devicesLoading, configuredData, osmReady])

  useEffect(() => () => {
    const renderer = rendererRef.current
    materialPoolRef.current.forEach(material => material.dispose())
    materialPoolRef.current.clear()
    if (!renderer) return
    renderer.dispose()
    renderer.forceContextLoss()
    renderer.domElement.remove()
    rendererRef.current = null
  }, [])

  useLayoutEffect(() => {
    const update = () => {
      if (active && !document.hidden) resumeRef.current?.()
      else { cancelAnimationFrame(rafRef.current); rafRef.current = 0 }
    }
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [active])

  // Node grades and pose do not change terrain geometry. Update their small objects
  // without rebuilding the retained scene or disturbing its camera.
  useLayoutEffect(() => {
    markerRef.current?.material.color.set(accent)
    const r = Number(device?.reading?.R ?? 0), p = Number(device?.reading?.P ?? 0)
    const magnitude = Math.hypot(r, p), arrow = poseArrowRef.current
    if (arrow) {
      arrow.visible = magnitude > 1e-6
      if (magnitude > 1e-6) {
        const length = 2000 * (0.03 + Math.min(0.12, magnitude * 0.02))
        arrow.setDirection(new THREE.Vector3(p, 0, -r).normalize())
        arrow.setLength(length, length * 0.28, length * 0.16)
      }
      arrow.setColor(accent)
    }
    if (arrowRef.current) arrowRef.current.visible = showArrow
  }, [accent, device?.reading?.R, device?.reading?.P, showArrow, data])

  useLayoutEffect(() => {
    if (waterRef.current && data) {
      const scale = (2000 * 0.22 / Math.max(1, data.meta.elev_max - data.meta.elev_min)) * exaggeration
      waterRef.current.position.y = (waterLevelM - data.meta.elev_min) * scale
    }
  }, [waterLevelM, data, exaggeration])

  // 水面显隐只切可见性，不重建整个场景
  useEffect(() => {
    if (waterRef.current) waterRef.current.visible = showWater
  }, [showWater])

  const resetView = useCallback(() => {
    const cam = cameraRef.current
    const ctrl = controlsRef.current
    if (!cam || !ctrl) return
    const d = 1900
    cam.position.set(d * 0.55, d * 0.62, d * 0.72)
    ctrl.target.set(0, 0, 0)
    ctrl.update()
  }, [])


  return (
    <div className="app">
      <header className="topbar topbar-slim">
        <div className="brand">
          <div className="brand-mark">边坡哨兵</div>
          <div className="brand-text">
            <h1>三维坡体 · 真实高程与下坡可达区</h1>
            <p>把滑坡所在的坡体立起来看：高程来自公开 DEM，可旋转/缩放，联动点位分级</p>
          </div>
        </div>
        <NavBar route={route} onNavigate={onNavigate} />
        <div className="topbar-right">
          <div className="pill">{session.role === 'admin' ? '管理人员' : '普通用户'} · {session.name}</div>
          <button type="button" className="ghost-btn" onClick={onLogout}>退出</button>
        </div>
      </header>

      <MobileTabs
        tabs={[
          { key: 'terrain', label: '三维地形' },
          { key: 'setup', label: '坡体 / 图层' },
          { key: 'info', label: '坡体信息' },
        ]}
        value={pane}
        onChange={(k) => setPane(k as 'setup' | 'terrain' | 'info')}
      />

      <main className="board board-terrain">
        <div className={`col col-terrain-left ${pane === 'setup' ? 'pane-on' : ''}`}>
          <Panel title="坡体选择" bodyClassName="tight">
            <label className="terrain-site-picker">选择坡体
              <select aria-label="选择坡体" value={siteId} onChange={event => setSiteId(event.target.value)}>
                {TERRAIN_SITES.map(id => {
                  const candidate = terrainScenario(archive, id)?.source
                  const grade = candidate?.prediction
                  return <option key={id} value={id}>{findSite(id)?.short ?? id}{grade && grade.data_available !== false ? ` · ${levelMeta(grade.combined_level).name}` : ''}</option>
                })}
              </select>
            </label>
            <div className="terrain-site-summary" data-testid={`terrain-site-${siteId}`}>
              <span className={`site-status tone-${site.tone}`}>{site.status}</span>
              <span>{site.location}</span>
              <small>{site.scale}</small>
              <span className="terrain-scene-badge" style={{ color: accent }}>{devicesLoading ? '场景加载中…' : noData ? '场景暂不可用' : `固定演示 · ${level}级 ${levelMeta(level).name}`}</span>
            </div>
          </Panel>

          <Panel title="显示控制" bodyClassName="tight">
            <label className="terrain-field">
              <span>垂直夸张 ×{exaggeration.toFixed(1)}</span>
              <input
                type="range" min={1} max={3} step={0.1} value={exaggeration}
                onChange={(e) => setExaggeration(Number(e.target.value))}
              />
            </label>
            <label className="terrain-field">
              <span>推演半径 {(radiusRatio * 100).toFixed(0)}%（{(radiusRatio * 6.3).toFixed(2)} km 级）</span>
              <input
                type="range" min={0.05} max={0.32} step={0.01} value={radiusRatio}
                onChange={(e) => setRadiusRatio(Number(e.target.value))}
              />
            </label>
            <div className="terrain-toggles">
              <label><input type="checkbox" checked={showRing} onChange={(e) => setShowRing(e.target.checked)} />推演范围圈</label>
              <label><input type="checkbox" checked={showArrow} onChange={(e) => setShowArrow(e.target.checked)} />姿态示意</label>
              <label><input type="checkbox" checked={showRunout} onChange={(e) => setShowRunout(e.target.checked)} />下坡影响区</label>
              <label><input type="checkbox" checked={showRoads} onChange={(e) => setShowRoads(e.target.checked)} />路网</label>
              {site.reservoir ? (
                <label><input type="checkbox" checked={showWater} onChange={(e) => setShowWater(e.target.checked)} />库水面</label>
              ) : null}
              <label><input type="checkbox" checked={wireframe} onChange={(e) => setWireframe(e.target.checked)} />线框</label>
              <label><input type="checkbox" checked={spin} onChange={(e) => setSpin(e.target.checked)} />自动旋转</label>
            </div>
            <div className="terrain-actions">
              <button type="button" className="ack-btn" onClick={resetView}>复位视角</button>
              <button
                type="button"
                className={`ack-btn ${pickMode ? 'active' : ''}`}
                onClick={() => setPickMode((v) => !v)}
              >
                {pickMode ? '取消选择' : '点选滑坡源区'}
              </button>
              {sourceLonLat ? (
                <button type="button" className="ack-btn" onClick={() => setSourceLonLat(null)}>
                  复位到监测站
                </button>
              ) : null}
            </div>
            <details className="help-details"><summary>图层与操作说明</summary>
            <div className="notice">
              推演起点：
              {sourceLonLat
                ? `自选源区 ${sourceLon.toFixed(4)}°E / ${sourceLat.toFixed(4)}°N`
                : '监测站（GNSS 点位，通常在滑体前缘，不代表滑体全貌）'}
              {pickMode ? '。现在点一下坡面就能把起点移过去。' : '。要换起点就点「点选滑坡源区」。'}
            </div>
            {site.reservoir ? (
              <div className="notice">
                库水面按三峡库水位 {Math.round(waterLevelM)} m 画（外部水文数据；取不到时按正常蓄水位 175 m）。
              </div>
            ) : null}
            {/* 两套配色必须分清：圈是几何量、坡面是物理量，圈的颜色**不表示危险程度** */}
            <div className="notice">
              两种颜色各说各的：坡面上的<b>琥珀/橙/红</b>是下坡可达区（按移动角分档，
              与预警等级无关）；<b>青蓝色推演范围圈</b>只表示推演半径，同样是几何量。
              跟着预警等级变色的是右侧等级圆环、站点标记和位移箭头。
            </div>
            <div className="runout-legend">
              <span><i className="tier-hi" />移动角 ≥20°</span>
              <span><i className="tier-mid" />移动角 15–20°</span>
              <span><i className="tier-lo" />移动角 &lt;15°</span>
            </div>
            <div className="notice">
              左键旋转、滚轮缩放、右键平移。箭头为倾角姿态示意；未经轴向标定不表示地理滑动方向。
            </div>
            </details>
          </Panel>

          <Panel title="下坡可达区推演" className="grow" bodyClassName="tight">
            <details className="help-details"><summary>推演方法与适用范围</summary>            <div className="notice">
              只用高程推演：以落差当能量预算（允许 ≤{Math.round(CLIMB_GRADE * 100)}% 缓坡通行，模拟惯性），
              再用移动角筛范围——tanα = 起点高程差 / 到起点水平距离，α 小于下限的位置
              只有大规模 / 高含水泥石流才够得着，默认不计入。颜色为几何分档，不代表概率或冲击强度。
            </div></details>
            <label className="terrain-field">
              <span>落差上限 {maxDrop} m</span>
              <input type="range" min={DROP_MIN} max={DROP_MAX} step={10} value={maxDrop}
                onChange={(e) => setMaxDrop(Number(e.target.value))} />
            </label>
            <label className="terrain-field">
              <span>移动角下限 {minAngle}°（黄土滑坡常见 10–25°）</span>
              <input type="range" min={MIN_ANGLE_MIN} max={MIN_ANGLE_MAX} step={1} value={minAngle}
                onChange={(e) => setMinAngle(Number(e.target.value))} />
            </label>

            <ul className="impact-stats">
              <li><span>可达像元</span><b>{runout ? runout.cells.toLocaleString() : '—'}</b></li>
              <li><span>可达面积（估）</span><b>{runoutAreaKm2 > 0 ? `${runoutAreaKm2.toFixed(2)} km²` : '—'}</b></li>
              <li>
                <span>角度分区（α≥20°）</span>
                <b>{km2(runout?.tierKm2[2])}</b>
              </li>
              <li>
                <span>角度分区（15–20°）</span>
                <b>{km2(runout?.tierKm2[1])}</b>
              </li>
              <li>
                <span>角度分区（&lt;15°）</span>
                <b>{km2(runout?.tierKm2[0])}</b>
              </li>
              <li>
                <span>被移动角筛掉（未计入）</span>
                <b>{runout && runout.energyFilteredKm2 > 0.01
                  ? `${runout.energyFilteredKm2.toFixed(2)} km²`
                  : '—'}</b>
              </li>
              <li>
                <span>坡面能提供的最大移动角</span>
                <b>{runout ? `${runout.maxAngleBeforeDeg.toFixed(1)}°` : '—'}</b>
              </li>
              <li><span>最远水平距离</span><b>{runout ? `${Math.round(runout.maxDist)} m` : '—'}</b></li>
              <li><span>累计落差</span><b>{runout ? `${Math.round(runout.maxDrop)} m` : '—'}</b></li>
              <li>
                <span>最低到达高程</span>
                <b>{reachedMinH !== null ? `${Math.round(reachedMinH)} m` : '—'}</b>
              </li>
              {terrainBudget ? (
                <li>
                  <span>距本图最低点（{Math.round(terrainBudget.minH)} m）</span>
                  <b>
                    {reachedMinH === null ? '—'
                      : reachedMinH - terrainBudget.minH <= 5 ? '已到底'
                        : `还差 ${Math.round(reachedMinH - terrainBudget.minH)} m`}
                  </b>
                </li>
              ) : null}
              <li><span>可达区内路段</span><b>{inZoneRoads} 段</b></li>
              <li>
                <span>最近路段距离</span>
                <b>{nearestRoadM !== null ? `${nearestRoadM} m` : '—'}</b>
              </li>
              <li><span>可达区内村镇</span><b>{affectedPlaces.length} 个</b></li>
              <li>
                <span>最近村镇距离</span>
                <b>{nearestPlaceM !== null ? `${nearestPlaceM} m` : '—'}</b>
              </li>
            </ul>

            {showTruncHint ? (
              <div className="notice">
                已达落差上限 {applied.drop} m——继续调大上限可以往下游再推。
              </div>
            ) : null}

            {runout && runout.cells === 0 && runout.maxAngleBeforeDeg > 0 ? (
              <div className="notice">
                当前移动角下限 {applied.angle}° 下没有可达像元：这点所在坡面能提供的最大移动角只有
                ≈{runout.maxAngleBeforeDeg.toFixed(1)}°。两种可能：坡体本身很缓，或者
                <b>站点坐标没落在滑坡体上</b>（本页站点坐标是公开资料的示意坐标）。
                把移动角下限调到 5° 可以看看放宽后的范围。
              </div>
            ) : null}

            <div className="impact-scroll">
              {roadImpacts.length === 0 ? (
                <div className="empty">本图幅内没有路网数据</div>
              ) : (
                <>
                  <div className="admin-sub">
                    路段（区内 {inZoneRoads} 段 · 区内优先、其余按由近到远）
                  </div>
                  <ul className="impact-list">
                    {roadImpacts.slice(0, 8).map((r) => (
                      <li key={`${r.name}-${r.nearestM}-${r.total}`}>
                        <span className={`impact-name ${r.inZone ? 'in-zone' : ''}`}>
                          {r.inZone ? '★ ' : ''}{r.name}
                        </span>
                        <span className="impact-meta">
                          {roadKindCn(r.kind)} · 最近 {r.nearestM} m
                          {r.inZone ? ` · 区内 ${r.affected}/${r.total} 点` : '（可达区外）'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {placeImpacts.length > 0 ? (
                <>
                  <div className="admin-sub">最近村镇（含可达区内）</div>
                  <ul className="impact-list">
                    {placeImpacts.slice(0, 6).map((p) => (
                      <li key={`${p.name}-${p.lon}`}>
                        <span className={`impact-name ${p.inZone ? 'in-zone' : ''}`}>
                          {p.inZone ? '★ ' : ''}{p.name || '（未命名）'}
                        </span>
                        <span className="impact-meta">
                          {placeKindCn(p.kind)} · 距滑坡 {(p.distanceM / 1000).toFixed(2)} km
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              <div className="notice">
              推演规则：以落差为能量预算从滑坡点往下游铺开，累计落差 ≤ {applied.drop} m；
              允许单步 ≤ {Math.round(CLIMB_GRADE * 100)}% 的缓坡通行
              （全程总上坡 ≤ {Math.max(CLIMB_BUDGET_MIN_M, Math.round(applied.drop * CLIMB_BUDGET_FRAC))} m），
              模拟滑坡体靠惯性翻过坡脚小坎；再用移动角下限 {applied.angle}° 筛掉"够不着"的区域
              （α 越小越要靠大规模 / 高流动性事件），并按 α 分三档强度着色。
              结果随地势绕行山脊与冲沟。
                <b>这是只用地形的简化推演，不是岩土数值模拟</b>，不能作为定量评估或避险决策依据。
                <br />
                路网与村镇：© OpenStreetMap contributors（ODbL 1.0），已下载到本地，断网可用。
              </div>
            </div>
          </Panel>
        </div>

        <div className={`col col-terrain-mid ${pane === 'terrain' ? 'pane-on' : ''}`}>
          <Panel title={`三维地形 · ${site.short}`} className="grow" bodyClassName="tight"
            extra={<span className="notice">{data ? `${data.meta.elev_min.toFixed(0)}–${data.meta.elev_max.toFixed(0)} m` : '加载中…'}</span>}>
        <div
          className={`terrain-stage ${pickMode ? 'picking' : ''}`}
          ref={mountRef}
          data-testid="terrain-stage"
          data-terrain-site={data?.meta.site ?? ''}
        >
              {error ? <div className="terrain-overlay">高程加载失败：{error}</div> : null}
              {webglError ? <div className="terrain-overlay">{webglError}</div> : null}
              {!data && !error ? <div className="terrain-overlay">正在准备地形…</div> : null}
              {data && !webglError ? (
                <div className="terrain-hint">
                  左键旋转 · 滚轮缩放 · 右键平移
                </div>
              ) : null}
            </div>
          </Panel>
        </div>

        <div className={`col col-terrain-right ${pane === 'info' ? 'pane-on' : ''}`}>
          <Panel title="坡体信息" bodyClassName="tight">
            <table className="dataset-table">
              <tbody>
                <tr><th>位置</th><td>{site.location}{site.approx ? '（示意坐标）' : ''}</td></tr>
                <tr><th>数据范围</th><td>{site.period} · {site.channels}</td></tr>
                <tr>
                  <th>高程</th>
                  <td>{data ? `${data.meta.elev_min.toFixed(0)} – ${data.meta.elev_max.toFixed(0)} m` : '—'}</td>
                </tr>
                <tr>
                  <th>范围</th>
                  <td>{data ? `${data.meta.bbox.west.toFixed(3)}–${data.meta.bbox.east.toFixed(3)}°E，${data.meta.bbox.south.toFixed(3)}–${data.meta.bbox.north.toFixed(3)}°N` : '—'}</td>
                </tr>
                <tr><th>高程来源</th><td>AWS Terrain Tiles（公开数据）离线打包
                  {data?.sourceVoidPixels ? <details className="terrain-source"><summary>空洞处理</summary>
                    原始空洞 {data.sourceVoidPixels} 像元按局部有效邻域填补；填补为估计值。显示与几何推演共用修正高程。
                  </details> : null}
                </td></tr>
              </tbody>
            </table>
          </Panel>

      <Panel title="固定演示等级" bodyClassName="tight">
            <div className="terrain-monitor-binding" data-monitor-id={scenario?.monitorId ?? ''}>{monitorName}</div>
            {device?.presentation && <div className="archive-note">历史场景 · {fmtShort(device.presentation.at)} · 非该坡体实测</div>}
            {sceneError ? <div className="rx-error" role="alert">{sceneError}<button className="range-btn" onClick={retryScene}>重试场景</button></div> : null}
            <div className="level-block" style={{ borderColor: accent }}>
              <div className="level-ring" style={{ boxShadow: `0 0 22px ${accent}55`, borderColor: accent }}>
                <span className="level-num" style={{ color: accent }}>{devicesLoading ? '…' : noData ? '—' : level}</span>
                <span className="level-unit">{noData ? '' : '级'}</span>
              </div>
              <div className="level-text">
                <div className="level-stage" style={{ color: accent }}>{devicesLoading ? '正在同步预警' : noData ? '数据不足' : levelMeta(level).name}</div>
                <div className="level-advice">{devicesLoading ? '正在读取监测点位数据' : noData ? '当前数据不足，暂不判定等级' : levelMeta(level).advice}</div>
              </div>
            </div>
            <div className="field-meta">
              <div>点位：{monitorName}</div>
              <div>倾角 R/P：{fmtNum(device?.reading?.R, 2)} / {fmtNum(device?.reading?.P, 2)} °</div>
              <div>相对位移 D：{fmtNum(device?.reading?.D, 2)} mm{noData ? "（最近有效值）" : ""}</div>
              <div>{device?.presentation ? '回放读数' : '最近报文'}：{device?.latest_ts ? device.presentation ? fmtShort(device.latest_ts) : fmtAgo(new Date(device.latest_ts).getTime()) : '—'}</div>
              <div>绑定演示点：{scenario?.monitorId ?? '—'}</div>
            </div>
            <div className="notice">一坡体一固定演示点，等级不是该坡体实测风险。推演为几何情景，不是实测灾害边界。</div>
            <details className="terrain-source"><summary>场景来源</summary><div>{device?.name ?? '回放尚未加载'} · 历史回放模板，等级用于情景展示。</div></details>
          </Panel>

          <Panel title="天气与关注权重（参比）" bodyClassName="tight">
            {weather && weather.available ? (
              <>
                <ul className="impact-stats">
                  <li><span>未来 24 小时降雨</span><b>{(weather.rain24h ?? 0).toFixed(1)} mm</b></li>
                  <li><span>未来 72 小时降雨</span><b>{(weather.rain72h ?? 0).toFixed(1)} mm</b></li>
                  <li><span>最大小时雨强</span><b>{(weather.max_hourly ?? 0).toFixed(1)} mm/h</b></li>
                  <li>
                    <span>关注权重参比</span>
                    <b style={{ color: weather.weight_bonus > 0 ? '#ffb066' : undefined }}>
                      +{weather.weight_bonus.toFixed(2)}
                    </b>
                  </li>
                  <li><span>数据源</span><b>{weather.source === 'open-meteo' ? 'Open-Meteo' : weather.source}</b></li>
                </ul>
                <div className="notice">
                  {weather.weight_reason}
                  {weather.stale ? '（当前显示的是上一次结果）' : ''}
                </div>
              </>
            ) : (
              <div className="empty">
                暂无天气数据{weather?.error ? `：${weather.error}` : ''}
              </div>
            )}
            <div className="notice">
              天气只做**权重参比**，不参与"是否报警"的判定；接口异常时自动用缓存并标注，不会连累预警。
            </div>
          </Panel>
        </div>
      </main>
    </div>
  )
}
