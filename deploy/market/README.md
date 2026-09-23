# volund 市场服务端（镜像部署物）

`@volund/market`（apps/market，Next.js 前后端一体）的 Docker 部署资产：

- `Dockerfile` — 多阶段构建，**上下文是仓库根**（与 gateway/mobile 一致），容器内完成
  standalone 构建——不能宿主机构建后 COPY：standalone 产物含平台相关可选依赖
  （如 sharp 的原生 `.node`），宿主（如 darwin/arm64）产物进 linux 镜像会带错平台二进制：
  ```bash
  docker build -f deploy/market/Dockerfile -t volund-market .
  ```
- `image-push.sh` — 构建并推送 `:TAG` 与 `:latest`（默认 buildx 多架构
  `linux/amd64,linux/arm64`，`PLATFORMS=host` 只构本机架构）：
  ```bash
  REGISTRY=registry.cn-hangzhou.aliyuncs.com/future-coding-backend sh deploy/market/image-push.sh
  ```
  三镜像（gateway / mobile / market）统一入口：`sh deploy/image-push.sh market`。
- `docker-compose.yml` — 使用方编排（直接拉镜像仓库里的镜像）：
  ```bash
  MARKET_IMAGE=registry.cn-hangzhou.aliyuncs.com/future-coding-backend/volund-market:1.0.0 \
  MARKET_ADMIN_TOKEN=xxx \
  docker compose -f deploy/market/docker-compose.yml up -d
  ```

服务 API、客户端接入、信任模型、数据备份等完整文档见 `apps/market/README.md`；
文档站指南 `docs/guides/marketplace.md`。
