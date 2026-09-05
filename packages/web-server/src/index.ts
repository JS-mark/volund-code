/**
 * @volund/web-server — Volund Web 的 loopback HTTP/SSE 网关（§22.7.3 / Web 计划 P2-02/03/05）。
 *
 * 安全模型（§22.10，本模块的硬门）：
 * - 只绑 loopback（127.0.0.1 / ::1）；Host/Origin 精确匹配绑定地址，其余拒绝；
 * - 启动 nonce 经 URL fragment 一次性交换 → HttpOnly SameSite=Strict cookie +
 *   内存态 CSRF token；mutation 必须同站 Origin + cookie + CSRF 头三件套；
 * - /api/v1 读端点也要 browser session；nonce 单次、有界有效期、server 重启即失效；
 * - 严格 CSP / nosniff / no-referrer / API 禁缓存；请求体 64 KiB 上限；
 * - 错误恒为 { error: { code, message } }；敏感值（credential/token）永不进 payload。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { extname, join, normalize } from 'node:path'

/** §22.8.2 之外的管理面宿主端口的最小结构面（由 apps/cli 用真实 VolundPorts 装配）。 */
export interface WebRuntimePorts {
  readonly identity: { readonly version: string }
  readonly cwd: string
  readonly session?: {
    list?(): Promise<readonly unknown[]>
  }
  readonly config?: {
    status?(input: { cwd: string }): Promise<unknown>
  }
  readonly native?: {
    available?(): {
      sandbox: boolean | 'probing'
      search: boolean | 'probing'
      fs: boolean | 'probing'
    }
  }
}

export interface WebServerOptions {
  /** 只接受 loopback 字面量；其余直接拒绝（§22 W-01）。 */
  readonly host: string
  /** 0 = 随机空闲端口；显式值限 1024..65535。 */
  readonly port: number
  readonly ports: WebRuntimePorts
  /** 静态资源目录（apps/web 构建产物）；缺失时 API 仍可用，/ 返回装配说明。 */
  readonly staticDir?: string | undefined
  /** 测试注入：会话有效期（默认 12h）与 nonce 有效期（默认 5min）。 */
  readonly sessionTtlMs?: number
  readonly nonceTtlMs?: number
}

export interface WebServerHandle {
  /** 含一次性 nonce fragment 的启动 URL（fragment 不进 HTTP 请求/日志）。 */
  readonly url: string
  readonly host: string
  readonly port: number
  readonly serverId: string
  readonly close: () => Promise<void>
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1'])
const MAX_BODY_BYTES = 64 * 1024
const SSE_MAX_QUEUE = 1000

interface BrowserSession {
  readonly id: string
  readonly csrfToken: string
  readonly createdAt: number
  readonly expiresAt: number
}

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
}

function fail(
  res: ServerResponse,
  status: number,
  error: { code: string; message: string },
  extraHeaders: Record<string, string> = {},
): void {
  const body = JSON.stringify({ error })
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function ok(res: ServerResponse, data: unknown): void {
  const body = JSON.stringify({ data })
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 常量时间比较（nonce/CSRF/session id 全走这里）。 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
  }
  return out
}

export async function createWebServer(options: WebServerOptions): Promise<WebServerHandle> {
  if (!LOOPBACK_HOSTS.has(options.host))
    throw new Error(`volund web only binds loopback (127.0.0.1 / ::1); got: ${options.host}`)
  if (options.port !== 0 && (options.port < 1024 || options.port > 65535))
    throw new Error(`--port must be 1024..65535 (got ${options.port}); 0 picks a free port`)

  const serverId = randomBytes(16).toString('base64url')
  const nonce = randomBytes(32).toString('base64url')
  const nonceExpiresAt = Date.now() + (options.nonceTtlMs ?? 5 * 60_000)
  let nonceUsed = false
  const sessions = new Map<string, BrowserSession>()
  const sessionTtl = options.sessionTtlMs ?? 12 * 60 * 60_000
  const startedAt = Date.now()

  // ── SSE：每连接有界队列（§22.8.3）；首版只发 control 事件（hello/heartbeat），
  // CoreEvent/view 透传在 P3 接会话事件流时落地。
  const sseClients = new Set<{ queue: string[]; res: ServerResponse }>()
  const sseHeartbeat = setInterval(() => {
    for (const client of sseClients) {
      if (client.queue.length >= SSE_MAX_QUEUE) {
        client.res.end()
        sseClients.delete(client)
        continue
      }
      client.res.write(`event: control\ndata: ${JSON.stringify({ kind: 'heartbeat' })}\n\n`)
    }
  }, 15_000)
  sseHeartbeat.unref()

  const findSession = (req: IncomingMessage): BrowserSession | undefined => {
    const id = parseCookies(req.headers.cookie).get('volund_session')
    if (!id) return undefined
    const session = sessions.get(id)
    if (!session || session.expiresAt < Date.now()) {
      if (session) sessions.delete(id)
      return undefined
    }
    return session
  }

  const expectedOriginHost = (port: number): string =>
    options.host === '::1' ? `[::1]:${port}` : `${options.host}:${port}`

  const handleRequest = async (req: IncomingMessage, res: ServerResponse, port: number) => {
    const hostHeader = req.headers.host ?? ''
    // Host 精确匹配绑定地址（DNS rebinding 门）。
    if (hostHeader !== expectedOriginHost(port)) {
      fail(res, 403, {
        code: 'web_origin_rejected',
        message: `unexpected Host: ${hostHeader || '<missing>'}`,
      })
      return
    }
    const url = new URL(req.url ?? '/', `http://${hostHeader}`)
    const path = url.pathname

    // 静态资源与 SPA 入口（无数据，公开可读；API 全要带 session）。
    if (!path.startsWith('/api/')) {
      await serveStatic(path, res)
      return
    }

    if (path === '/api/v1/health' && req.method === 'GET') {
      ok(res, {
        status: 'ok',
        serverId,
        version: options.ports.identity.version,
        uptimeMs: Date.now() - startedAt,
        pid: process.pid,
      })
      return
    }

    if (path === '/api/v1/browser-session/exchange' && req.method === 'POST') {
      // 一次性 nonce 换 browser session（fragment 从不经 HTTP 传输，JS 读出后 POST）。
      const origin = req.headers.origin
      if (origin !== `http://${hostHeader}`) {
        fail(res, 403, {
          code: 'web_origin_rejected',
          message: 'Origin does not match the loopback server',
        })
        return
      }
      const body = await readJsonBody(req)
      if (body === undefined) {
        fail(res, 400, { code: 'web_schema_invalid', message: 'invalid JSON body' })
        return
      }
      const candidate = (body as { nonce?: unknown }).nonce
      const valid =
        !nonceUsed &&
        Date.now() < nonceExpiresAt &&
        typeof candidate === 'string' &&
        safeEqual(candidate, nonce)
      nonceUsed = true
      if (!valid) {
        fail(res, 403, {
          code: 'web_session_invalid',
          message: 'nonce is invalid, used, or expired',
        })
        return
      }
      const session: BrowserSession = {
        id: randomBytes(24).toString('base64url'),
        csrfToken: randomBytes(24).toString('base64url'),
        createdAt: Date.now(),
        expiresAt: Date.now() + sessionTtl,
      }
      sessions.set(session.id, session)
      const bodyOut = JSON.stringify({
        data: { serverId, csrfToken: session.csrfToken, expiresAt: session.expiresAt },
      })
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': `volund_session=${session.id}; HttpOnly; SameSite=Strict; Path=/`,
        'Content-Length': Buffer.byteLength(bodyOut),
      })
      res.end(bodyOut)
      return
    }

    // 其余 /api/v1 一律要求 browser session。
    const session = findSession(req)
    if (!session) {
      fail(res, 401, { code: 'web_session_invalid', message: 'missing or expired browser session' })
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // mutation 三件套：同站 Origin + session cookie + CSRF 头。
      const origin = req.headers.origin
      if (origin !== `http://${hostHeader}`) {
        fail(res, 403, {
          code: 'web_origin_rejected',
          message: 'Origin does not match the loopback server',
        })
        return
      }
      const csrf = req.headers['x-volund-csrf']
      if (typeof csrf !== 'string' || !safeEqual(csrf, session.csrfToken)) {
        fail(res, 403, { code: 'web_csrf_invalid', message: 'CSRF token mismatch' })
        return
      }
    }

    if (path === '/api/v1/bootstrap' && req.method === 'GET') {
      const ports = options.ports
      ok(res, {
        server: { serverId, version: ports.identity.version, startedAt },
        workspace: { cwd: ports.cwd },
        capabilities: {
          sessions: ports.session?.list !== undefined,
          status: ports.config?.status !== undefined,
          native: ports.native
            ? (ports.native.available?.() ?? {
                sandbox: 'probing',
                search: 'probing',
                fs: 'probing',
              })
            : 'unavailable',
          // §22.3.4 诚实状态：Web 首版的写能力边界。
          mutations: { turnSubmit: false, permissionDecision: false },
        },
      })
      return
    }

    if (path === '/api/v1/sessions' && req.method === 'GET') {
      if (!options.ports.session?.list) {
        fail(res, 503, { code: 'web_capability_unavailable', message: 'session port is not wired' })
        return
      }
      ok(res, { sessions: await options.ports.session!.list!() })
      return
    }

    if (path === '/api/v1/status' && req.method === 'GET') {
      if (!options.ports.config?.status) {
        fail(res, 503, { code: 'web_capability_unavailable', message: 'status port is not wired' })
        return
      }
      ok(res, await options.ports.config.status({ cwd: options.ports.cwd }))
      return
    }

    if (path === '/api/v1/events' && req.method === 'GET') {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      })
      const client = { queue: [], res } as { queue: string[]; res: ServerResponse }
      sseClients.add(client)
      res.write(
        `event: control\ndata: ${JSON.stringify({ kind: 'hello', serverId, cursor: '0' })}\n\n`,
      )
      req.on('close', () => sseClients.delete(client))
      return
    }

    fail(res, 404, {
      code: 'web_schema_invalid',
      message: `unknown endpoint: ${req.method} ${path}`,
    })
  }

  const serveStatic = async (path: string, res: ServerResponse) => {
    const staticDir = options.staticDir
    if (!staticDir || !existsSync(staticDir)) {
      const message =
        'Volund Web assets are not built into this distribution. Run `pnpm --filter @volund/web build` in the repo.'
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
      })
      res.end(
        `<!doctype html><html><body style="font-family:monospace;padding:2rem">${message}</body></html>`,
      )
      return
    }
    const rel = normalize(path === '/' ? '/index.html' : path).replace(/^([/\\])+/, '')
    const file = join(staticDir, rel)
    // 路径逃逸门：归一化后必须仍在 staticDir 内。
    if (!file.startsWith(normalize(staticDir))) {
      fail(res, 403, { code: 'web_origin_rejected', message: 'path escapes the asset root' })
      return
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      // SPA 路由回退到 index.html（客户端路由）。
      const indexFile = join(staticDir, 'index.html')
      if (!existsSync(indexFile)) {
        fail(res, 404, { code: 'web_schema_invalid', message: 'not found' })
        return
      }
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME['.html']! })
      res.end(await readFile(indexFile))
      return
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      // vite 产物带内容哈希：长缓存安全。
      'Cache-Control': path === '/' ? 'no-store' : 'public, max-age=31536000, immutable',
    })
    createReadStream(file).pipe(res)
  }

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res, boundPort).catch(() => {
      if (!res.headersSent)
        fail(res, 500, { code: 'web_schema_invalid', message: 'internal error' })
    })
  })

  let boundPort = options.port
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(options.port, options.host, () => resolveListen())
  })
  const address = server.address()
  boundPort = typeof address === 'object' && address ? address.port : options.port

  const hostForUrl = options.host === '::1' ? '[::1]' : options.host
  const url = `http://${hostForUrl}:${boundPort}/#token=${nonce}`
  return {
    url,
    host: options.host,
    port: boundPort,
    serverId,
    close: () =>
      new Promise((resolveClose) => {
        clearInterval(sseHeartbeat)
        for (const client of sseClients) client.res.end()
        sseClients.clear()
        sessions.clear()
        server.close(() => resolveClose())
      }),
  }
}

/** 有界 JSON body 读取（64 KiB 上限；超限/非 JSON → undefined）。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}
