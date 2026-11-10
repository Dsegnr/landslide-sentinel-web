/// <reference types="vitest" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Optional QA target; the normal local-development ports remain unchanged.
const apiTarget = process.env.SENTINEL_DEV_API || 'http://127.0.0.1:8081'

// 开发期把 /api 代理到本地后端，前后端同源，省掉 CORS 与硬编码地址；
// 生产期由 nginx 做同样的转发（见 web/deploy/nginx.conf）。
export default defineConfig({
  plugins: [react()],
  // 发版号：给**不带内容哈希**的业务素材（/terrain/*、/field/* 等）当缓存钥匙用。
  // 每次构建都不同 ⇒ 重新部署后浏览器一定去取新素材，不会继续画旧的那座山
  // （实测踩到：白家包换了正确坐标，服务器上新 DEM 已就位，页面还在画旧的）。
  define: {
    __BUILD_ID__: JSON.stringify(Date.now().toString(36)),
  },
  server: {
    port: 5173,
    strictPort: true,
    // host: true = 监听 0.0.0.0，同一局域网内的队友可以用 http://<本机IP>:5173 打开大屏。
    // 后端仍然只监听回环地址，外部访问统一经本机的 vite 代理转发（少暴露一个端口）。
    host: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      // WebSocket 实时推送：开发期同样走代理，前端代码只认同源
      '/ws': { target: apiTarget.replace(/^http/, 'ws'), ws: true },
      // 现场影像与上传照片由后端托管（<video>/<img> 带不了 Authorization 头）
      '/media': { target: apiTarget, changeOrigin: true },
      '/uploads': { target: apiTarget, changeOrigin: true },
    },
  },
  preview: { port: 3000, strictPort: true, host: true },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // 把第三方库与业务代码分开打包。
        // 为什么：原先所有东西都塞进一个 index-*.js（966 KB，gzip 后 320 KB），
        // 任何一行业务代码改动都会让浏览器**重下整包**；而且一次只下一个文件、
        // 解析也要等它下完。拆开之后：库文件名带各自内容哈希、部署后不变（继续命中
        // 浏览器缓存），业务包只有几十 KB；同时几个文件可以并行下载与解析。
        // 纯构建产物变化，页面结构、样式与交互一律不动。
        manualChunks(id: string) {
          const terrain = id.replaceAll('\\', '/').match(/\/lib\/terrainReserve\/([^/]+)\.ts$/)
          if (terrain && terrain[1] !== 'index') return `terrain-reserve-${terrain[1]}`
          if (!id.includes('node_modules')) return undefined
          if (id.includes('echarts') || id.includes('zrender')) return 'vendor-echarts'
          if (id.includes('leaflet')) return 'vendor-leaflet'
          if (id.includes('three/examples/jsm/libs/fflate')) return 'vendor-inflate'
          if (id.includes('three')) return 'vendor-three'
          if (id.includes('react') || id.includes('scheduler')) return 'vendor-react'
          return 'vendor'
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
