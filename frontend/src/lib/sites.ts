// 数据集站点注册表：现场监测页的"地图上的地点"就是这几条。
// 每个站点带位置、数据规模、通道、用途、状态与现场素材（视频/照片）。
// 素材路径统一以 `/field/...` 或 `/media/...` 开头，由后端静态托管。

export interface SiteMedia {
  /** 参考录像：必须写清"是哪个地方、什么许可、是否本站点实拍" */
  video?: { src: string; label: string }
  /** 逐张带标注：必须写清"这是卫星影像/是数据集随附影像/是同类滑坡实景参考" */
  images: { src: string; label: string }[]
  /** 素材说明（例如"参考素材"），如实标注，避免被当成该点实拍 */
  caption: string
}

/** 统一的"参考录像"：USGS 公有领域的 2008 汶川红岩村滑坡现场录像（前端已转码为 mp4） */
const REF_VIDEO = {
  src: '/field/video/landslide-reference.mp4',
  label: '滑坡实景参考录像：2008 汶川地震红岩村滑坡现场（USGS 公有领域，非本点位实拍）',
}

/** USGS 公有领域的真实滑坡实拍（2008 汶川地震灾区）：每个站点挑一张作"同类滑坡实景参考" */
function usgsRef(file: string, place: string) {
  return { src: `/field/ref/${file}`, label: `同类滑坡实景参考：${place}（USGS 公有领域）` }
}

/** NASA Worldview 真彩色卫星影像（公有领域）：按站点真实经纬度取，可复现 */
function satellite(id: string, date: string) {
  return [
    { src: `/field/sat/${id}-near.jpg`, label: `卫星影像 · 近景约 6 km（NASA Worldview ${date}，公有领域）` },
    { src: `/field/sat/${id}-area.jpg`, label: `卫星影像 · 区域约 40 km（NASA Worldview ${date}，公有领域）` },
  ]
}

/**
 * 三峡站《专业监测年报汇编》里按章节归属到该站点的现场照片与图件
 * （ncdc.ac.cn 申请获取；脚本 `tools/extract_annual_photos.py` 提取，矢量图已转 PNG）。
 */
function annual(file: string, caption: string) {
  return {
    src: `/field/annual/${file}`,
    label: `专业监测年报图件：${caption}（湖北长江三峡滑坡国家野外科学观测研究站）`,
  }
}

export interface SiteInfo {
  id: string
  name: string
  short: string
  lon: number
  lat: number
  location: string
  /** 坐标是否为示意（没有权威经纬度时置 true，界面上会标注"示意位置"） */
  approx: boolean
  /** 是否在库区（有三峡库水位、可画水面） */
  reservoir?: boolean
  period: string
  scale: string
  channels: string
  role: string
  status: string
  tone: 'ok' | 'warn' | 'muted'
  note: string
  media: SiteMedia
}

export const SITES: SiteInfo[] = [
  {
    id: 'baijiabao',
    name: '白家包滑坡观测站',
    short: '白家包',
    // 坐标取自数据集官方元数据（_ncdc_meta_.json 的 ds_acq_lon/lat），不是猜的：
    // DOI 10.12072/ncdc.sanxia.db6815.2025；原先写的 110.96/30.83 差了约 26 km。
    lon: 110.759167,
    lat: 30.983333,
    location: '湖北秭归 · 三峡库区',
    approx: false,
    reservoir: true,
    period: '2017–2024（8 年）',
    scale: '日尺度 · 2832 天',
    channels: 'GNSS 位移、裂缝、日降雨、三峡库水位',
    role: '主训练/验证集（含 12 次阶跃事件标签）',
    status: '已到货并质检',
    tone: 'ok',
    note: '本项目的核心数据；库水位触发特征全部来自这里。',
    media: {
      video: REF_VIDEO,
      images: [
        { src: '/field/baijiabao-site.jpg', label: '现场全貌（白家包观测数据随附影像，非卫星图）' },
        { src: '/field/baijiabao-layout.jpg', label: '观测点布置图（数据集随附）' },
        ...satellite('baijiabao', '2025-01-15'),
        usgsRef('shibangou.jpg', '四川汶川石板沟滑坡与河谷堆积体，2008'),
      ],
      caption: '数据集随附实景影像 + 站点卫星影像 + 同类滑坡实景参考',
    },
  },
  {
    id: 'majiagou',
    name: '马家沟水平位移观测点',
    short: '马家沟',
    // 坐标来自数据集 README 的权威值：110°57′44″E / 30°49′48″N
    // （湖北秭归县归州镇马家沟滑坡；DOI 10.12072/ncdc.bnorsg.db7199.2026）
    // 原先写的 110.985/30.815 偏了约 2.8 km
    lon: 110.962222,
    lat: 30.83,
    location: '湖北秭归归州镇 · 马家沟滑坡',
    approx: false,
    period: '2024-11 → 2025-07',
    scale: '小时级连续序列',
    channels: '东西/南北/垂直/平面位移',
    role: '多尺度时序建模与对比实验',
    status: '已到货并质检',
    tone: 'ok',
    note: '与白家包逐时段对照，用于检验方法在同库区另一坡体上的表现。',
    media: {
      video: REF_VIDEO,
      images: [
        ...satellite('majiagou', '2025-01-15'),
        usgsRef('xiaojiaqiao.jpg', '四川安县肖家桥滑坡，2008'),
      ],
      caption: '站点卫星影像 + 同类滑坡实景参考（马家沟实拍待现场补充）',
    },
 },
 {
    id: 'shuiping',
    name: '树坪滑坡专业监测点',
    short: '树坪',
    // 坐标出自 ncdc 2024 年资料《树坪滑坡基本特征及监测数据使用说明》原文：
    // 「湖北秭归县沙镇溪镇树坪村一组，长江南岸，下距三峡大坝约 47 km，
    //   经度 110°37′0″，纬度 30°59′37″」——不是估的。
    lon: 110.616667,
    lat: 30.993611,
    location: '湖北秭归沙镇溪镇 · 树坪滑坡',
    approx: false,
    reservoir: true,
    period: '2024–2025（两年，位移基准自 2023.12 起）',
    scale: '日级降雨/库水位 · 7 个 GPS 点月监测',
    channels: 'GPS 位移（ΔX/ΔY/ΔF/ΔH）、日降雨、长江库水位',
    role: '多触发因子（降雨 + 库水位）与位移响应的跨年检验',
    status: '已到货并质检',
    tone: 'ok',
    note: '两年含 145.7~175.0 m 完整库水位循环；2024 旱（579.8 mm）与 2025 湿（1073.0 mm）构成天然对照。',
    media: {
      video: REF_VIDEO,
      images: [
        ...satellite('shuiping', '2024-10-20'),
        annual('shuiping-2009-07.png', '树坪滑坡监测点平面布置图（2009 年报）'),
        annual('_emf/shuiping-2007-08.png', '图2-1-3 树坪滑坡 ZG86 累计位移—降雨量—库区水位关系图（2007）'),
        annual('shuiping-2009-09.jpeg', '现场巡查：坡面裂缝（2009 年报）'),
        annual('shuiping-2010-15.jpeg', '现场巡查（2010 年报）'),
        usgsRef('donghekou.jpg', '四川青川东河口滑坡与堆积体，2008（同类库区滑坡参考）'),
      ],
      caption: '站点卫星影像 + 专业监测年报现场照片与图件 + 同类滑坡实景参考',
    },
  },
  {
    id: 'baishuihe',
    name: '白水河滑坡专业监测点',
    short: '白水河',
    // 坐标出自 2007—2010 年报汇编「滑坡概况」原文：
    // 「位于长江南岸，下距三峡大坝坝址 56km，属沙镇溪镇白水河村，
    //   经度 110°32′09″，纬度 31°01′34″」
    lon: 110.535833,
    lat: 31.026111,
    location: '湖北秭归沙镇溪镇 · 白水河滑坡',
    approx: false,
    reservoir: true,
    period: '2024（库水位/降雨日尺度）+ 2006（月尺度）+ 2007–2010（年报）',
    scale: '库水位/降雨：逐日（2024 全年）；位移：逐月（2024 年 14 个 GPS 点、2006 年 11 个点）',
    channels: 'GPS 位移（ΔX/ΔF/ΔH）、降雨、长江水位、气温',
    role: '175 m 运行期（2024）与 156 m 蓄水初期（2006）的**同点跨期对照**',
    status: '已到货并质检',
    tone: 'ok',
    note: '同一滑坡相隔 18 年的两段资料：2024 已进入 175 m 正常运行期（库水位 145.7→168.2 m），'
      + '2006 处 156 m 蓄水初期（140→136→156.5 m），触发因子口径完全不同，'
      + '正好用来检验"在一个时期标定的阈值能否搬到另一个时期"。'
      + '注意位移是**月尺度**，驱动不了实时哨兵层，它的价值在离线验证与跨期对照。',
    media: {
      video: REF_VIDEO,
      images: [
        ...satellite('baishuihe', '2024-10-20'),
        annual('baishuihe-2007-01.png', '白水河滑坡监测点布置（2007 年报）'),
        annual('_emf/baishuihe-2007-04.png', '白水河滑坡 XD-1 累计位移—降雨量—库区水位关系图（2007）'),
        annual('baishuihe-2009-02.jpeg', '现场巡查（2009 年报）'),
        usgsRef('shibangou.jpg', '四川汶川石板沟滑坡与河谷堆积体，2008（同类库区滑坡参考）'),
      ],
      caption: '站点卫星影像 + 专业监测年报现场照片与图件 + 同类滑坡实景参考',
    },
  },
  {
    id: 'bazimen',
    name: '八字门滑坡（资料站点）',
    short: '八字门',
    // 坐标出自 2007—2010 年报汇编：「秭归县归州镇，长江北岸支流香溪河右岸河口处，
    //   经度 110°45′30″，纬度 30°58′16″」
    lon: 110.758333,
    lat: 30.971111,
    location: '湖北秭归归州镇 · 八字门滑坡（香溪河右岸）',
    approx: false,
    reservoir: true,
    period: '2007–2010（年报汇编）',
    scale: '年报：变形分析 + 宏观地质巡查 + 现场照片',
    channels: 'GPS 位移与宏观巡查（年报口径）',
    role: '库区对照站点（资料性，暂无连续序列）',
    status: '有年报资料',
    tone: 'muted',
    note: '只有年报文字与图件，没有可直接建模的连续序列；先作为"专业监测网"的一部分展示，序列等后续申请。',
    media: {
      video: REF_VIDEO,
      images: [
        ...satellite('bazimen', '2024-10-20'),
        annual('bazimen-2007-10.jpeg', '现场巡查（2007 年报）'),
        annual('_emf/bazimen-2007-05.png', '八字门滑坡累计位移—时间曲线（2007 年报）'),
        usgsRef('xiaojiaqiao.jpg', '四川安县肖家桥滑坡，2008（同类库区滑坡参考）'),
      ],
      caption: '站点卫星影像 + 专业监测年报现场照片与图件 + 同类滑坡实景参考',
    },
  },
  {
    id: 'xintan',
    name: '新滩滑坡（资料站点）',
    short: '新滩',
    // 坐标出自 2007—2010 年报汇编：「长江北岸兵书宝剑峡出口，下距三峡大坝坝趾 26km，
    //   属屈原镇长江村二组，经度 110°48′32″，纬度 30°57′02″」
    lon: 110.808889,
    lat: 30.950556,
    location: '湖北秭归屈原镇 · 新滩滑坡（兵书宝剑峡出口）',
    approx: false,
    reservoir: true,
    period: '2007–2010（年报汇编）',
    scale: '年报：变形分析 + 监测点平面布置',
    channels: 'GPS 位移与宏观巡查（年报口径）',
    role: '历史大滑坡遗址的对照站点（资料性）',
    status: '有年报资料',
    tone: 'muted',
    note: '1985 年新滩曾发生大规模滑坡堵江；本站点用于对照"同一库区不同失稳型式"，序列待申请。',
    media: {
      video: REF_VIDEO,
      images: [
        ...satellite('xintan', '2024-10-20'),
        annual('xintan-2007-12.jpeg', '新滩滑坡监测点平面布置图（2007 年报）'),
        annual('_emf/xintan-2007-10.png', '新滩滑坡累计位移—时间曲线（2007 年报）'),
        usgsRef('donghekou.jpg', '四川青川东河口滑坡与堆积体，2008（同类滑坡参考）'),
      ],
      caption: '站点卫星影像 + 专业监测年报图件 + 同类滑坡实景参考',
    },
  },
  {
    id: 'lianziya',
    name: '链子崖危岩体（资料站点）',
    short: '链子崖',
    // 坐标出自 2007—2010 年报汇编：「秭归县屈原镇链子崖村 1 组，长江南岸，距三峡大坝 26km，
    //   与新滩滑坡隔江对峙，经度 110°47′26″，纬度 30°56′35″」
    lon: 110.790556,
    lat: 30.943056,
    location: '湖北秭归屈原镇 · 链子崖危岩体（长江南岸）',
    approx: false,
    reservoir: true,
    period: '1996–2006（裂缝变形）+ 2007–2010（年报）',
    scale: '裂缝监测 3258 次测次（13 条裂缝，千分卡尺 0.01–0.1 mm）',
    channels: '裂缝张合、位错（含旋向）；年报含危岩体位移监测',
    role: '岩质危岩体对照：裂缝开合速率正是哨兵层判据的物理量',
    status: '有年报与裂缝资料',
    tone: 'muted',
    note: '裂缝变形数据集（1996–2006）按"长江三峡库区"整体发布，站点归属需与原报告逐条核对后再并入建模。',
    media: {
      video: REF_VIDEO,
      images: [
        ...satellite('lianziya', '2024-10-20'),
        annual('lianziya-2007-13.jpeg', '链子崖危岩崩滑体监测点分布图（2007 年报）'),
        annual('_emf/lianziya-2007-11.png', '链子崖危岩体裂缝/位移变化曲线（2007 年报）'),
        usgsRef('hongyan-scarp.jpg', '四川汶川红岩村滑坡后壁，2008（岩质坡面参考）'),
      ],
      caption: '站点卫星影像 + 专业监测年报图件 + 同类岩质滑坡参考',
    },
  },
  {
    id: 'gaolan',
    name: '皋兰山黄土边坡监测',
    short: '皋兰山',
    lon: 103.83,
    lat: 36.03,
    location: '甘肃兰州 · 黄土边坡',
    approx: true,
    period: '2019-08 → 2020-04（8 个月）',
    scale: '10–200 Hz · 152 通道',
    channels: '三轴/单轴加速度、温湿度、自电位、降雨、孔隙水压、位移计、照度',
    role: '正常态建模 · 多传感器异常检测 · 跨区验证（无滑坡事件标签）',
    status: '已下载 45.8GB 并重采样',
    tone: 'warn',
    note: '用作"正常态背景"与跨区泛化检验；该数据集不含滑坡事件标签，答辩务必如实说明。',
    media: {
      video: REF_VIDEO,
      images: [
        ...satellite('gaolan', '2024-10-20'),
        usgsRef('hongyan-scarp.jpg', '四川汶川红岩村滑坡的黄色滑坡后壁，2008（黄土状坡面）'),
      ],
      caption: '站点卫星影像 + 同类滑坡实景参考（皋兰山实拍待现场补充）',
    },
  },
  {
      id: 'self-collected',
      name: '自采扰动序列（原型机）',
      short: '自采',
      // 注意：这是**占位坐标**（暂时借库区参考点），真实部署点要等队长给。
      // 下面 location/note 都写明了，避免被当成实测位置。
      lon: 110.759,
      lat: 30.983,
      location: '随硬件部署点（坐标待确认）',
    approx: true,
    period: '2026-09-09（约 8.6 小时）',
    scale: '15144 行 · 约 1.24 s 采样',
    channels: '7 通道：位移、雨量、温湿度、倾角、土壤含水率',
    role: '哨兵层验证与阈值标定（受控"基线→扰动→恢复"实验）',
    status: '已到货 · 待补测',
    tone: 'warn',
    note: '这是唯一来自我们自己的硬件的数据；补测后用于现场阈值标定。',
    media: {
      video: REF_VIDEO,
      images: [
        ...satellite('self-collected', '2025-01-15'),
        usgsRef('donghekou.jpg', '四川青川东河口滑坡现场勘察，2008'),
      ],
      caption: '站点卫星影像 + 同类滑坡实景参考（自采实验影像待现场补充）',
    },
  },
]

export function findSite(id: string): SiteInfo | undefined {
  return SITES.find((s) => s.id === id)
}
