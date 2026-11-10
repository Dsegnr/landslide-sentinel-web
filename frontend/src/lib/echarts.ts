// ECharts 按需注册：只引入大屏实际用到的图表与组件，
// 避免把整个 echarts 打进包里（首屏体积与构建告警都可控）。
import { BarChart, EffectScatterChart, HeatmapChart, LineChart, ScatterChart } from 'echarts/charts'
import {
  DataZoomComponent,
  GeoComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapPiecewiseComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  LineChart,
  BarChart,
  HeatmapChart,
  ScatterChart,
  EffectScatterChart,
  GeoComponent,
  GridComponent,
  TooltipComponent,
  VisualMapPiecewiseComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
  MarkLineComponent,
  CanvasRenderer,
])

export { echarts }
