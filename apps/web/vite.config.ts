import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: {
    // 产物由 @volund/web-server 以不可变哈希资产伺服（CSP `default-src 'self'`）。
    outDir: 'dist',
    sourcemap: false,
    target: 'es2024',
  },
  server: {
    // 开发模式：API 反代到 `volund web` 的 loopback 端口。
    proxy: { '/api': { target: 'http://127.0.0.1:4097', changeOrigin: false } },
  },
})
