#!/usr/bin/env sh
# 构建并推送全部 Docker 镜像到镜像仓库（默认阿里云杭州）：
#   sh deploy/image-push.sh                       # 三个镜像全推，TAG=git 短 SHA
#   sh deploy/image-push.sh gateway v1.2.0        # 只推网关，指定 TAG
#   sh deploy/image-push.sh market                # 只推市场
#   REGISTRY=registry.example.com/volund sh deploy/image-push.sh all v0.2.0
# 环境变量：
#   REGISTRY   可选，默认 registry.cn-hangzhou.aliyuncs.com/future-coding-backend
#   TAG        可选，默认当前 git 短 SHA；第二个位置参数也可指定
#   PLATFORMS  可选，默认 linux/amd64,linux/arm64（多架构，需 buildx + binfmt 模拟）；
#              设为 host 只构当前机器架构（也是无 buildx 时的自动回退）
# 目标镜像（均另推 :latest；构建上下文均为仓库根）：
#   volund-gateway  ← deploy/gateway/Dockerfile
#   volund-mobile   ← deploy/mobile/Dockerfile
#   volund-market   ← deploy/market/Dockerfile
# 推送前须已登录：docker login registry.cn-hangzhou.aliyuncs.com
set -eu
cd "$(dirname "$0")/.." # 仓库根

REGISTRY=${REGISTRY:-registry.cn-hangzhou.aliyuncs.com/future-coding-backend}
TAG=${TAG:-${2:-$(git rev-parse --short HEAD)}}
TARGET=${1:-all}
PLATFORMS=${PLATFORMS:-linux/amd64,linux/arm64}

case "$TARGET" in
gateway | mobile | market | all) ;;
*)
  echo "usage: sh deploy/image-push.sh [gateway|mobile|market|all] [TAG]" >&2
  exit 2
  ;;
esac

targets=""
case "$TARGET" in
gateway | all) targets="$targets volund-gateway" ;;
esac
case "$TARGET" in
mobile | all) targets="$targets volund-mobile" ;;
esac
case "$TARGET" in
market | all) targets="$targets volund-market" ;;
esac

echo "REGISTRY=$REGISTRY TAG=$TAG TARGET=$TARGET PLATFORMS=$PLATFORMS"

if ! docker buildx version >/dev/null 2>&1 && [ "$PLATFORMS" != "host" ]; then
  echo "错误：PLATFORMS=$PLATFORMS 需要 buildx（brew install docker-buildx 后重试，" >&2
  echo "或 PLUGIN 里软链：ln -sfn \"\$(brew --prefix)/opt/docker-buildx/bin/docker-buildx\" ~/.docker/cli-plugins/docker-buildx）。" >&2
  echo "单架构推通用 PLATFORMS=host（镜像只在当前机器架构上可跑）。" >&2
  exit 1
fi

for name in $targets; do
  file="deploy/${name#volund-}/Dockerfile"
  echo "==> 构建 ${REGISTRY}/${name}:${TAG}（-f ${file}，platforms=${PLATFORMS}）"
  if [ "$PLATFORMS" != "host" ]; then
    docker buildx build --platform "$PLATFORMS" -f "$file" \
      -t "$REGISTRY/$name:$TAG" -t "$REGISTRY/$name:latest" --push .
  else
    docker build -f "$file" -t "$REGISTRY/$name:$TAG" -t "$REGISTRY/$name:latest" .
    docker push "$REGISTRY/$name:$TAG"
    docker push "$REGISTRY/$name:latest"
  fi
  echo "==> 已推送 ${REGISTRY}/${name}:${TAG}（+latest）"
done
