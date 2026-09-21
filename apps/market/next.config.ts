import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // API 路由走 Node 运行时读写 data/ 存储，不能做静态导出；
  // 浏览页与 API 同源，客户端回环 http 才能装插件（见 README 信任模型）。
  reactStrictMode: true,
  // Docker 构建置 NEXT_OUTPUT=standalone 产出自包含 server.js（见 Dockerfile）；
  // 本地 pnpm dev / next start 不置该变量，维持默认输出。
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),
}

export default nextConfig
