import type { NextConfig } from 'next'

/**
 * 静态导出（output: 'export'）→ apps/web/out，由 volund 嵌入式 loopback
 * server 托管（web-server serveStatic；HTML 响应由服务端注入 CSP nonce）。
 * 纯客户端应用：数据全走 /api/v1 fetch + SSE，无 SSR/server action。
 */
const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  // 静态导出无 trailingSlash 需求；单页 + 客户端内部路由。
  trailingSlash: false,
}

export default nextConfig
