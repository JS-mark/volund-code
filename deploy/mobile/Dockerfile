# syntax=docker/dockerfile:1
# volund 移动站独立部署镜像（REM-r1）：Next 静态导出 + nginx 托管。
# 与网关完全解耦——移动站是纯静态产物，可挂任意静态托管/CDN；
# 跨源调网关时网关侧须配 GATEWAY_CORS_ORIGINS（本站 Origin）与
# GATEWAY_MOBILE_PUBLIC_URL（配对链接指向本站）。
# 构建上下文必须是仓库根（pnpm workspace）：
#   docker build -f deploy/mobile/Dockerfile -t volund-mobile .

# 构建阶段钉 BUILDPLATFORM：构建机原生跑 node/pnpm（跨架构时不进 QEMU——
# node 在 QEMU 用户态模拟下会撞 libuv 断言崩溃）。产物是纯静态文件，架构无关。
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build --filter @volund/mobile

FROM nginx:1.27-alpine
COPY deploy/mobile/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/mobile/out /usr/share/nginx/html
EXPOSE 8800
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
