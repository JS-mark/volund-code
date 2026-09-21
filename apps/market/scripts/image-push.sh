#!/usr/bin/env sh
# 构建并推送 market 镜像到镜像仓库：
#   REGISTRY=registry.example.com/volund sh apps/market/scripts/image-push.sh
#   REGISTRY=registry.example.com/volund sh apps/market/scripts/image-push.sh v1.2.0
# 环境变量：
#   REGISTRY  必填，仓库地址（含命名空间，如 docker.io/<user> / registry.example.com/volund）
#   TAG       可选，默认取 apps/market/package.json 的 version
# 流程：宿主机构建 standalone 产物 → 打包镜像（上下文仅产物，秒级）→ 推送 :TAG 与 :latest。
# 多架构（amd64+arm64）请改用本文件末尾注释里的 buildx 命令。
set -eu
cd "$(dirname "$0")/.." # apps/market

REGISTRY=${REGISTRY:?需要 REGISTRY 环境变量（镜像仓库地址，含命名空间）}
TAG=${1:-$(node -p "require('./package.json').version")}
IMAGE="$REGISTRY/volund-market:$TAG"

# 1. 宿主机构建 standalone 产物（含裁剪后的 node_modules）
rm -rf .docker-build
NEXT_OUTPUT=standalone pnpm build

# 2. 整理镜像上下文：standalone 布局（apps/market/server.js）+ 静态资源
mkdir -p .docker-build
cp -R .next/standalone/. .docker-build/
mkdir -p .docker-build/apps/market/.next
cp -R .next/static .docker-build/apps/market/.next/static

# 3. 打包镜像（上下文只有 .docker-build，秒级）并推送
docker build -t "$IMAGE" -t "$REGISTRY/volund-market:latest" .
docker push "$IMAGE"
docker push "$REGISTRY/volund-market:latest"
echo "已推送 $IMAGE 与 $REGISTRY/volund-market:latest"

# 多架构构建（在 amd64 机器上发布 arm64 镜像等场景，需要 buildx）：
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t "$REGISTRY/volund-market:$TAG" -t "$REGISTRY/volund-market:latest" --push .
