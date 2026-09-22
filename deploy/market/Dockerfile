# market 运行镜像：只打包「宿主机构建好的 standalone 产物」（上下文 = apps/market）。
# 产物与镜像的构建/推送走 scripts/image-push.sh（或手动 NEXT_OUTPUT=standalone pnpm
# build 后按脚本第 2 步整理到 .docker-build）。
# 镜像内不需要 node_modules/lockfile——standalone 已包含裁剪后的依赖。
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=4315 \
    MARKET_DATA_DIR=/app/data \
    NEXT_TELEMETRY_DISABLED=1
COPY .docker-build ./
RUN mkdir -p /app/apps/market/public /app/data && chown -R node:node /app
USER node
EXPOSE 4315
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/market/server.js"]
