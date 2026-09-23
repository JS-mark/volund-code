# syntax=docker/dockerfile:1
# market 运行镜像：容器内多阶段构建（构建上下文 = 仓库根，与 gateway/mobile 一致）。
#   docker build -f deploy/market/Dockerfile -t volund-market .
# 推送走 deploy/market/image-push.sh 或统一入口 deploy/image-push.sh market。
# 必须在容器内构建：standalone 产物含平台相关可选依赖（如 sharp 的原生 .node），
# 宿主机（如 darwin/arm64）构建再 COPY 进 linux 镜像会带上错误平台的二进制。
# 镜像内不需要 node_modules/lockfile——standalone 已包含裁剪后的依赖。
# 构建阶段钉 BUILDPLATFORM：构建机原生跑 node/pnpm（跨架构时不进 QEMU——
# node 在 QEMU 用户态模拟下会撞 libuv 断言崩溃 uv__io_poll: errno == EEXIST）。
# 前提是产物架构无关：本服务不用 sharp/图片优化，构建后把 Next 依赖追踪误带入
# 的 @img/sharp 原生二进制从 standalone 剪除，产物即纯 JS。
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN NEXT_OUTPUT=standalone pnpm build --filter @volund/market
# 剪除 sharp 全家（.pnpm 里各平台的 .node 包目录与顶层软链）。本服务全量 grep
# 无 next/image 引用，sharp 纯属 Next 依赖追踪误带入，剪除无副作用。
RUN cd apps/market/.next/standalone \
    && find node_modules -type d \( -name '@img' -o -name '@img+sharp*' \
       -o -name 'sharp' -o -name 'sharp@*' \) -prune -exec rm -rf {} +

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=4315 \
    MARKET_DATA_DIR=/app/data \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /repo/apps/market/.next/standalone ./
COPY --from=build /repo/apps/market/.next/static ./apps/market/.next/static
# 非 root 运行；/app/data 存市场数据（首次启动自动播种）。
RUN mkdir -p /app/apps/market/public /app/data && chown -R node:node /app
USER node
EXPOSE 4315
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/market/server.js"]
