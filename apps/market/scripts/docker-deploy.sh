#!/usr/bin/env sh
# market Docker 部署：宿主机构建 standalone 产物 → 打包进镜像 → 起容器。
#   MARKET_ADMIN_TOKEN=xxx sh apps/market/scripts/docker-deploy.sh
# 可用环境变量：PORT（宿主端口，默认 4315）、IMAGE（默认 volund-market:latest）。
# 数据持久化在命名卷 volund-market-data；升级 = 重跑本脚本（旧容器原地替换，数据保留）。
set -eu
cd "$(dirname "$0")/.." # apps/market

IMAGE=${IMAGE:-volund-market:latest}
PORT=${PORT:-4315}
: "${MARKET_ADMIN_TOKEN:?需要 MARKET_ADMIN_TOKEN 环境变量}"

# 1. 宿主机构建 standalone 产物（含裁剪后的 node_modules）
rm -rf .docker-build
NEXT_OUTPUT=standalone pnpm build

# 2. 整理镜像上下文：standalone 布局（apps/market/server.js）+ 静态资源
mkdir -p .docker-build
cp -R .next/standalone/. .docker-build/
mkdir -p .docker-build/apps/market/.next
cp -R .next/static .docker-build/apps/market/.next/static

# 3. 打包镜像（秒级：上下文只有 .docker-build）
docker build -t "$IMAGE" .

# 4. 起容器
docker volume create volund-market-data >/dev/null
docker rm -f volund-market >/dev/null 2>&1 || true
docker run -d --name volund-market \
  -p "$PORT:4315" \
  -e PORT=4315 \
  -e MARKET_ADMIN_TOKEN="$MARKET_ADMIN_TOKEN" \
  -e MARKET_DATA_DIR=/app/data \
  -v volund-market-data:/app/data \
  --restart unless-stopped \
  "$IMAGE"

echo
echo "market → http://127.0.0.1:$PORT"
echo "~/.volund/config.toml："
echo "  [plugins] market = \"http://127.0.0.1:$PORT/api/plugins/index.json\""
echo "  [skills]  market = \"http://127.0.0.1:$PORT/api/skills/index.json\""
echo "  [mcp]     market = \"http://127.0.0.1:$PORT/api/mcp/index.json\""
