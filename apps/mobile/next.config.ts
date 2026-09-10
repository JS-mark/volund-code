import type { NextConfig } from 'next'

/**
 * 静态导出（output: 'export'）→ apps/mobile/out。两种托管形态：
 * 网关同源（gateway-server StaticSiteServer，HTML 注入 CSP nonce）或独立部署
 * （deploy/mobile 镜像 / 任意静态托管，跨源调网关走 #gw= 参数 + localStorage）。
 * 纯客户端应用：配对/会话/聊天全走网关 REST + /v1/ws，无 SSR/server action。
 * 配对入口用 hash 路由（#pair=CODE[&gw=]），无需动态路由。
 */
const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: false,
  // dev 指示器（可拖拽的 Next 徽标）在移动视口上会盖住底栏「对话」按钮，
  // 且其拖拽释放逻辑会抛 releasePointerCapture NotFoundError——移动站用不到，关掉。
  devIndicators: false,
}

export default nextConfig
