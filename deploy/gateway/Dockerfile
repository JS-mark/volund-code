# syntax=docker/dockerfile:1
# volund 远程网关（relay）镜像（§GATEWAY-r1 / REM-r1）。
# 构建上下文必须是仓库根（需要整个 pnpm workspace）：
#   docker build -f deploy/gateway/Dockerfile -t volund-gateway .
#
# 运行时模型：node 直跑 @volund/gateway-server 的 tsc 产物 dist/bin.js——
# 独立进程，不经 volund CLI。纯中转（relay）：不挂本机会话，桌面 volund 经
# /uplink 反向拨出注册；镜像同时携带移动站静态产物（apps/mobile/out），
# 由网关同源托管（VOLUND_MOBILE_ASSET_DIR）。

FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
# turbo 依依赖图拓扑序构建 @volund/gateway-server（零运行时依赖，dist 自包含）
# 与移动站静态产物（@volund/mobile out/）。
RUN pnpm build --filter @volund/gateway-server --filter @volund/mobile

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    VOLUND_HOME=/data \
    GATEWAY_HOST=0.0.0.0 \
    GATEWAY_PORT=8788 \
    VOLUND_MOBILE_ASSET_DIR=/app/mobile
# 非 root 运行；/data 存 volund home（网关客户端哈希/签名密钥/已配对设备表）。
RUN groupadd --system volund && useradd --system --gid volund --home /data volund \
  && mkdir -p /data && chown -R volund:volund /data
WORKDIR /app
COPY --from=build --chown=volund:volund /repo/packages/gateway-server /app/gateway
COPY --from=build --chown=volund:volund /repo/apps/mobile/out /app/mobile
USER volund
VOLUME ["/data"]
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8788/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/app/gateway/dist/bin.js"]
