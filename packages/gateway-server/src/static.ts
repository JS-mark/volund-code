/**
 * 移动端静态站托管（远程控制 REM-r1）：网关直接 serve apps/mobile 的 Next
 * 静态导出产物——移动站与 API 同源，浏览器 WS/fetch 无 CORS 面。
 *
 * 与 web-server 的 serveStatic 同规则（依赖方向是 web-server → gateway-server，
 * 这里不能反向 import，故独立实现）：路径逃逸门、SPA 回退 index.html、
 * 带扩展名资源缺失 404、HTML per-request CSP nonce、哈希资产长缓存。
 */
import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

const SECURITY_HEADERS: Record<string, string> = {
  // 移动站与网关同源；WS 也同源（wss），connect-src 'self' 即覆盖。
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

/** Next 静态导出的内联引导脚本挂 per-request nonce（与 web-server 同手法）。 */
function htmlWithCspNonce(html: string, nonce: string): string {
  return html.replaceAll('<script', `<script nonce="${nonce}"`)
}

function securityHeadersWithNonce(nonce: string): Record<string, string> {
  return {
    ...SECURITY_HEADERS,
    'Content-Security-Policy': SECURITY_HEADERS['Content-Security-Policy']!.replace(
      "script-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
    ),
  }
}

export interface StaticSiteServerOptions {
  readonly rootDir: string
}

export class StaticSiteServer {
  constructor(private readonly options: StaticSiteServerOptions) {}

  /** 是否可服务（目录存在且有 index.html）。 */
  get available(): boolean {
    return existsSync(join(this.options.rootDir, 'index.html'))
  }

  /** 处理一个 GET 请求路径；未命中文件时 SPA 回退，目录缺失时 404 JSON。 */
  async serve(path: string, res: ServerResponse): Promise<void> {
    const root = normalize(this.options.rootDir)
    if (!this.available) {
      const body = JSON.stringify({
        error: {
          code: 'gateway_static_missing',
          message: 'mobile site assets are not present on this gateway',
        },
      })
      res.writeHead(404, {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
      })
      res.end(body)
      return
    }
    const rel = normalize(path === '/' ? '/index.html' : path).replace(/^([/\\])+/, '')
    const file = join(root, rel)
    if (!file.startsWith(root)) {
      res.writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' })
      res.end('forbidden')
      return
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      // 带扩展名的资源缺失必须 404（nosniff 下回退 HTML 会让浏览器拦成白屏）。
      if (extname(rel)) {
        res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' })
        res.end('not found')
        return
      }
      await this.serveHtml(join(root, 'index.html'), res)
      return
    }
    if (extname(file) === '.html') {
      await this.serveHtml(file, res)
      return
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    })
    createReadStream(file).pipe(res)
  }

  private async serveHtml(file: string, res: ServerResponse): Promise<void> {
    const nonce = randomBytes(12).toString('base64url')
    res.writeHead(200, {
      ...securityHeadersWithNonce(nonce),
      'Content-Type': MIME['.html']!,
      'Cache-Control': 'no-store',
    })
    res.end(htmlWithCspNonce(await readFile(file, 'utf8'), nonce))
  }
}
