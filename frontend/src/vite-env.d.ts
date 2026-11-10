/// <reference types="vite/client" />

/** 构建时注入的发版号（见 vite.config.ts 的 define），用于给非哈希素材做缓存穿透 */
declare const __BUILD_ID__: string
