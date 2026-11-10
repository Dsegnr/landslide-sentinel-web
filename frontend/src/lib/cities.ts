/** 地图上的城市标注（省级市 + 部分地级市）。

 *  只用于"看得懂地图"：降水色块铺开时，光有省份边界分不清是哪儿，
 *  参考图里也是靠城市名把位置点出来的。坐标取市中心，误差对展示无影响。
 */
export interface City {
  name: string
  lon: number
  lat: number
  /** true = 只在降水图层打开时显示（避免地图太挤） */
  minor?: boolean
}

export const CITIES: City[] = [
  { name: '北京', lon: 116.41, lat: 39.90 },
  { name: '天津', lon: 117.20, lat: 39.13 },
  { name: '上海', lon: 121.47, lat: 31.23 },
  { name: '重庆', lon: 106.55, lat: 29.56 },
  { name: '石家庄', lon: 114.51, lat: 38.04 },
  { name: '太原', lon: 112.55, lat: 37.87 },
  { name: '呼和浩特', lon: 111.75, lat: 40.84 },
  { name: '沈阳', lon: 123.43, lat: 41.80 },
  { name: '长春', lon: 125.32, lat: 43.82 },
  { name: '哈尔滨', lon: 126.53, lat: 45.80 },
  { name: '南京', lon: 118.80, lat: 32.06 },
  { name: '杭州', lon: 120.15, lat: 30.27 },
  { name: '合肥', lon: 117.28, lat: 31.86 },
  { name: '福州', lon: 119.30, lat: 26.08 },
  { name: '南昌', lon: 115.89, lat: 28.68 },
  { name: '济南', lon: 117.00, lat: 36.65 },
  { name: '郑州', lon: 113.62, lat: 34.75 },
  { name: '武汉', lon: 114.30, lat: 30.59 },
  { name: '长沙', lon: 112.94, lat: 28.23 },
  { name: '广州', lon: 113.26, lat: 23.13 },
  { name: '南宁', lon: 108.37, lat: 22.82 },
  { name: '海口', lon: 110.20, lat: 20.04 },
  { name: '成都', lon: 104.07, lat: 30.57 },
  { name: '贵阳', lon: 106.63, lat: 26.65 },
  { name: '昆明', lon: 102.83, lat: 24.88 },
  { name: '拉萨', lon: 91.11, lat: 29.65 },
  { name: '西安', lon: 108.94, lat: 34.34 },
  { name: '兰州', lon: 103.83, lat: 36.06 },
  { name: '西宁', lon: 101.78, lat: 36.62 },
  { name: '银川', lon: 106.23, lat: 38.49 },
  { name: '乌鲁木齐', lon: 87.62, lat: 43.83 },
  { name: '台北', lon: 121.56, lat: 25.03 },
  { name: '香港', lon: 114.17, lat: 22.32 },
  // 与滑坡项目相关、需要在地图上点出来的地方
  { name: '宜昌', lon: 111.29, lat: 30.69, minor: true },
  { name: '秭归', lon: 110.98, lat: 30.83, minor: true },
  { name: '十堰', lon: 110.79, lat: 32.65, minor: true },
  { name: '襄阳', lon: 112.12, lat: 32.01, minor: true },
  { name: '天水', lon: 105.72, lat: 34.58, minor: true },
  { name: '定西', lon: 104.63, lat: 35.58, minor: true },
]

/** 全国视图下真正显示的标签：只留 16 个、彼此拉得开。
 *
 *  我们的地图面板只有 ~300 px 宽，塞 30 多个城市名会互相压字
 *  （参考图看着不挤，是因为它只显示一个区域、且画布大得多）。
 *  想看更细的地名，放大后由点位标记与 tooltip 补足。
 */
const LABEL_NAMES = [
  '乌鲁木齐', '拉萨', '西宁', '兰州', '银川', '呼和浩特', '北京',
  '哈尔滨', '沈阳', '西安', '成都', '武汉', '上海', '广州', '昆明', '台北',
]

export const LABEL_CITIES: City[] = CITIES.filter((c) => LABEL_NAMES.includes(c.name))
