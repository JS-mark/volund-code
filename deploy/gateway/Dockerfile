# syntax=docker/dockerfile:1
# volund 远程网关注镜像（§GATEWAY-r1）。
# 构建上下文必须是仓库根（需要整个 pnpm workspace）：
#   docker build -f deploy/gateway/Dockerfile -t volund-gateway .
#
# 运行时模型：node 直跑 apps/cli 的 rolldown bundle（platform:'node' 产物，
# 与 npm bin 直跑同一份字节），子命令 `volund gateway` 起服务。

FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
# turbo 依依赖图拓扑序构建 @volund/cli 及其全部 workspace 依赖。
RUN pnpm build --filter @volund/cli

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    VOLUND_HOME=/data \
    GATEWAY_HOST=0.0.0.0 \
    GATEWAY_PORT=8788 \
    GATEWAY_WORKSPACE=/workspace
# 非 root 运行；/data 存 volund home（会话/凭据/网关客户端与密钥），/workspace 是会话工作区。
RUN groupadd --system volund && useradd --system --gid volund --home /data volund \
  && mkdir -p /data /workspace && chown -R volund:volund /data /workspace
WORKDIR /workspace
COPY --from=build --chown=volund:volund /repo/apps/cli/dist /app/dist
USER volund
VOLUME ["/data", "/workspace"]
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8788/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/app/dist/volund.js", "gateway"]
