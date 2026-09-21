# market 运行镜像：只打包「宿主机构建好的 standalone 产物」（上下文 = apps/market）。
# 不要直接 docker build——产物由部署脚本生成：
#   sh apps/market/scripts/docker-deploy.sh
# 脚本流程：宿主 NEXT_OUTPUT=standalone 构建 → 产物整理到 apps/market/.docker-build → 本镜像。
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
