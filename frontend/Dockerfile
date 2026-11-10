# 边坡哨兵前端（React + Vite 构建 -> nginx 静态服务）
FROM node:22-alpine AS build

WORKDIR /app
ENV npm_config_registry=https://registry.npmmirror.com

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# build 脚本 = tsc --noEmit && vite build，类型错误会在这里直接失败
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
