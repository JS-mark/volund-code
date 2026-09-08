/**
 * @volund/gateway-server — volund 的公网远程网关（OAuth2 + SSE + WebSocket）。
 *
 * 与 @volund/web-server 的分工：web-server 是 loopback-only 的本机控制台
 * （cookie/CSRF 模型）；本包是面向远程客户端的 API 网关——
 * - 认证：自建 OAuth2 client_credentials（POST /oauth/token → HS256 JWT Bearer）；
 * - 传输：POST /v1/chat/completions（OpenAI 兼容，stream=true 时 SSE）+
 *   WS /v1/ws（交互会话全双工通道）；
 * - 会话模型：volund 单 runner——所有 turn 经 FIFO 队列串行（忙时 409），
 *   WS 与 chat/completions 共享同一个活动会话；
 * - 安全面：Token 过期强制校验、client secret 常量时间比对、请求体/WS 帧上限、
 *   每客户端每分钟限流、审批无人决策超时自动 deny、CORS 默认关闭。
 */
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { Duplex } from 'node:stream'

import { handleChatCompletion } from './chat'
import type { GatewayHubLike } from './hub'
import type { GatewayOAuthClient, GatewayTokenClaims } from './oauth'
import { GatewayOAuthServer } from './oauth'
import { GatewayError, TurnQueue } from './queue'
import { acceptWebSocket, WsConnection } from './websocket'
import { attachWsConnection, WsBroadcaster } from './ws'

export type { ChatCompletionParsed, TurnOutcome } from './chat'
export type { GatewayEnvelope, GatewayHubLike } from './hub'
export type { GatewayOAuthClient, GatewayTokenClaims, IssuedToken } from './oauth'
export {
  deriveSigningKey,
  GatewayOAuthServer,
  generateGatewayClient,
  parseGatewayClients,
} from './oauth'
export { GatewayError, TurnQueue } from './queue'
export { acceptWebSocket, WS_CLOSE, WsConnection } from './websocket'

export interface GatewayModelListing {
  readonly id: string
  readonly label?: string
}

export interface GatewayServerOptions {
  readonly host: string
  readonly port: number
  /** OAuth2 签发/校验面（clients/key/TTL 由装配侧解析）。 */
  readonly oauth: {
    readonly issuer: string
    readonly signingKey: Uint8Array
    readonly tokenTtlSeconds: number
    readonly clients: readonly GatewayOAuthClient[]
  }
  /** 会话枢纽（CLI 传 SessionHub；测试传内存假实现）。 */
  readonly hub: GatewayHubLike
  /** 会话工作区根：chat/completions 与 WS session.start 的 cwd 都被关进这里。 */
  readonly workspaceCwd: string
  readonly version: string
  /** GET /v1/models 数据源；缺省返回空列表。 */
  readonly listModels?: () => Promise<readonly GatewayModelListing[]>
  /** GET /v1/sessions 数据源（可恢复会话清单）；缺省返回空列表。 */
  readonly listSessions?: () => Promise<readonly unknown[]>
  /** 无 '/' 的 model 名补的 provider 前缀（默认 'openai'）。 */
  readonly defaultProvider?: string
  /** 队列等待上限（默认 600s）。 */
  readonly queueTimeoutMs?: number
  /** 审批无人决策的自动 deny 超时（默认 120s；0 = 不兜底）。 */
  readonly permissionTimeoutMs?: number
  /** turn 持锁上限（默认 30min）。 */
  readonly maxTurnHoldMs?: number
  /** 每客户端每分钟 /v1/* 请求上限（默认 600）。 */
  readonly rateLimitPerMinute?: number
  /** /oauth/token 每 IP 每分钟上限（默认 30）。 */
  readonly tokenRateLimitPerMinute?: number
  /** 允许跨域的 Origin 白名单；默认空 = 不下发任何 CORS 头。 */
  readonly corsOrigins?: readonly string[]
  /** JSON body 上限（默认 4 MiB）。 */
  readonly maxBodyBytes?: number
  readonly logger?: (message: string) => void
}

export interface GatewayServerHandle {
  readonly url: string
  readonly host: string
  readonly port: number
  readonly serverId: string
  readonly close: () => Promise<void>
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

function fail(
  res: ServerResponse,
  error: GatewayError,
  extraHeaders: Record<string, string> = {},
): void {
  const body = JSON.stringify({ error: { code: error.code, message: error.message } })
  res.writeHead(error.status, {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function ok(res: ServerResponse, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 每分钟固定窗口限流（进程内存态；多实例部署需前置网关收口）。 */
class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>()

  constructor(private readonly limit: number) {}

  /** 超限时返回 retry-after 秒数，否则 undefined。 */
  hit(key: string): number | undefined {
    const now = Date.now()
    const window = this.windows.get(key)
    if (!window || window.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + 60_000 })
      return undefined
    }
    window.count += 1
    if (window.count <= this.limit) return undefined
    return Math.ceil((window.resetAt - now) / 1000)
  }
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) return undefined
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (!header) return undefined
  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || rest.length !== 1) return undefined
  return rest[0]
}

export async function createGatewayServer(
  options: GatewayServerOptions,
): Promise<GatewayServerHandle> {
  const serverId = randomBytes(16).toString('base64url')
  const oauth = new GatewayOAuthServer(options.oauth)
  const hub = options.hub
  const queue = new TurnQueue()
  const startedAt = Date.now()
  const queueTimeoutMs = options.queueTimeoutMs ?? 600_000
  const permissionTimeoutMs = options.permissionTimeoutMs ?? 120_000
  const maxTurnHoldMs = options.maxTurnHoldMs ?? 30 * 60_000
  const maxBodyBytes = options.maxBodyBytes ?? 4 * 1024 * 1024
  const corsOrigins = new Set(options.corsOrigins ?? [])
  const apiLimiter = new RateLimiter(options.rateLimitPerMinute ?? 600)
  const tokenLimiter = new RateLimiter(options.tokenRateLimitPerMinute ?? 30)
  const log = options.logger ?? (() => {})

  // ── 审批超时兜底：无人决策的权限请求到点自动 deny（chat/completions 没有
  // 交互审批面；WS 客户端掉线同理）。decide 幂等，已被决策的请求静默忽略。──
  let permissionTimer: ReturnType<typeof setTimeout> | undefined
  if (permissionTimeoutMs > 0) {
    hub.subscribe((envelope) => {
      const event = envelope.event as { type?: unknown; request?: { id?: unknown } }
      if (envelope.kind === 'view' && event?.type === 'permission.request') {
        const requestId = typeof event.request?.id === 'string' ? event.request.id : undefined
        if (!requestId) return
        if (permissionTimer) clearTimeout(permissionTimer)
        permissionTimer = setTimeout(() => {
          log(
            `permission ${requestId} auto-denied after ${permissionTimeoutMs}ms without a decider`,
          )
          hub.decide(requestId, 'deny')
        }, permissionTimeoutMs)
        permissionTimer.unref?.()
      }
      if (envelope.kind === 'view' && event?.type === 'permission.resolved' && permissionTimer) {
        clearTimeout(permissionTimer)
        permissionTimer = undefined
      }
    })
  }

  const broadcaster = new WsBroadcaster(hub)

  const authenticate = (req: IncomingMessage): GatewayTokenClaims | undefined => {
    const token = bearerToken(req)
    return token ? oauth.verify(token) : undefined
  }

  const corsHeaders = (req: IncomingMessage): Record<string, string> => {
    const origin = req.headers.origin
    if (!origin || corsOrigins.size === 0) return {}
    if (!corsOrigins.has(origin)) return {}
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      Vary: 'Origin',
    }
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://gateway.internal')
    const path = url.pathname
    const cors = corsHeaders(req)

    // CORS 预检（只在配置了白名单时生效）。
    if (req.method === 'OPTIONS') {
      res.writeHead(cors['Access-Control-Allow-Origin'] ? 204 : 403, {
        ...SECURITY_HEADERS,
        ...cors,
      })
      res.end()
      return
    }

    // ── 公开端点 ────────────────────────────────────────────────────────
    if ((path === '/healthz' || path === '/v1/health') && req.method === 'GET') {
      ok(res, {
        status: 'ok',
        serverId,
        version: options.version,
        uptimeMs: Date.now() - startedAt,
        pid: process.pid,
      })
      return
    }

    if (path === '/oauth/token' && req.method === 'POST') {
      const retryAfter = tokenLimiter.hit(`token:${req.socket.remoteAddress ?? 'unknown'}`)
      if (retryAfter !== undefined)
        return fail(res, new GatewayError('gateway_rate_limited', 429, 'too many token requests'), {
          'Retry-After': String(retryAfter),
        })
      // 两种客户端凭证形式都收：Authorization: Basic base64(id:secret)（RFC 6749）
      // 与 body 字段（client_id/client_secret）。
      const raw = await readRawBody(req, maxBodyBytes)
      if (raw === undefined)
        return fail(
          res,
          new GatewayError('gateway_schema_invalid', 400, 'request body is required'),
        )
      const fields = parseTokenRequest(req.headers['content-type'], raw)
      if (!fields)
        return fail(
          res,
          new GatewayError('gateway_schema_invalid', 400, 'malformed token request body'),
        )
      let clientId = fields.get('client_id') ?? ''
      let clientSecret = fields.get('client_secret') ?? ''
      const basic = req.headers.authorization
      if (basic?.toLowerCase().startsWith('basic ')) {
        try {
          const decoded = Buffer.from(basic.slice(6), 'base64').toString('utf8')
          const colon = decoded.indexOf(':')
          if (colon > 0) {
            clientId = decoded.slice(0, colon)
            clientSecret = decoded.slice(colon + 1)
          }
        } catch {
          // fallthrough：解码失败按凭证缺失处理
        }
      }
      if (fields.get('grant_type') !== 'client_credentials')
        return fail(
          res,
          new GatewayError(
            'gateway_grant_unsupported',
            400,
            'grant_type must be client_credentials',
          ),
        )
      if (!clientId || !clientSecret)
        return fail(
          res,
          new GatewayError(
            'gateway_schema_invalid',
            400,
            'client_id and client_secret are required',
          ),
        )
      const client = oauth.authenticate(clientId, clientSecret)
      if (!client)
        return fail(
          res,
          new GatewayError('gateway_client_rejected', 401, 'invalid client credentials'),
          {
            'WWW-Authenticate': 'Basic realm="volund-gateway"',
          },
        )
      const scopeParam = fields.get('scope')
      const requestedScopes = scopeParam ? scopeParam.split(' ').filter(Boolean) : []
      const issued = oauth.issue(client, requestedScopes)
      if (!issued)
        return fail(
          res,
          new GatewayError('gateway_schema_invalid', 400, 'requested scope exceeds client grants'),
        )
      ok(res, {
        access_token: issued.accessToken,
        token_type: issued.tokenType,
        expires_in: issued.expiresIn,
        scope: requestedScopes.length ? requestedScopes.join(' ') : client.scopes.join(' '),
      })
      return
    }

    // ── 其余 /v1/* 一律 Bearer 认证 + 每客户端限流 ───────────────────────
    if (path.startsWith('/v1/')) {
      const claims = authenticate(req)
      if (!claims)
        return fail(
          res,
          new GatewayError('gateway_auth_invalid', 401, 'missing or expired bearer token'),
          {
            'WWW-Authenticate': 'Bearer realm="volund-gateway"',
          },
        )
      const retryAfter = apiLimiter.hit(`client:${claims.sub}`)
      if (retryAfter !== undefined)
        return fail(res, new GatewayError('gateway_rate_limited', 429, 'rate limit exceeded'), {
          'Retry-After': String(retryAfter),
        })

      if (path === '/v1/models' && req.method === 'GET') {
        const models = (await options.listModels?.()) ?? []
        ok(res, {
          object: 'list',
          data: models.map((model) => ({
            id: model.id,
            object: 'model',
            created: Math.floor(startedAt / 1000),
            owned_by: 'volund',
            ...(model.label ? { label: model.label } : {}),
          })),
        })
        return
      }

      if (path === '/v1/sessions' && req.method === 'GET') {
        ok(res, { sessions: (await options.listSessions?.()) ?? [] })
        return
      }

      if (path === '/v1/chat/completions' && req.method === 'POST') {
        const body = await readJsonBody(req, maxBodyBytes)
        if (body === undefined)
          return fail(
            res,
            new GatewayError('gateway_schema_invalid', 400, 'invalid or oversized JSON body'),
          )
        let finished = false
        res.on('finish', () => {
          finished = true
        })
        const disconnectListeners = new Set<() => void>()
        req.on('close', () => {
          if (!finished) for (const listener of disconnectListeners) listener()
        })
        try {
          await handleChatCompletion(
            {
              hub,
              queue,
              workspaceCwd: options.workspaceCwd,
              defaultProvider: options.defaultProvider ?? 'openai',
              queueTimeoutMs,
            },
            body,
            res,
            {
              disconnected: () => !finished,
              onDisconnect: (listener) => disconnectListeners.add(listener),
            },
          )
        } catch (cause) {
          const error =
            cause instanceof GatewayError
              ? cause
              : new GatewayError(
                  'gateway_upstream_failed',
                  502,
                  cause instanceof Error ? cause.message : String(cause),
                )
          if (!res.headersSent) fail(res, error, cors)
          else res.end()
        }
        return
      }

      return fail(
        res,
        new GatewayError('gateway_schema_invalid', 404, `unknown endpoint: ${req.method} ${path}`),
      )
    }

    return fail(
      res,
      new GatewayError('gateway_schema_invalid', 404, `unknown endpoint: ${req.method} ${path}`),
    )
  }

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      if (!res.headersSent)
        fail(res, new GatewayError('gateway_upstream_failed', 500, 'internal error'))
    })
  })

  // ── WebSocket 升级通道 ─────────────────────────────────────────────────
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://gateway.internal')
    const reject = (status: number, code: string, message: string) => {
      const reason = status === 401 ? 'Unauthorized' : status === 400 ? 'Bad Request' : 'Not Found'
      const body = JSON.stringify({ error: { code, message } })
      socket.write(
        `HTTP/1.1 ${status} ${reason}\r\n` +
          'Content-Type: application/json; charset=utf-8\r\n' +
          `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      )
      socket.destroy()
    }
    if (url.pathname !== '/v1/ws')
      return reject(404, 'gateway_schema_invalid', 'unknown websocket endpoint')
    // 认证：优先 Authorization 头；浏览器 WS 不能自定义头 → ?access_token= 兜底。
    let claims = authenticate(req)
    if (!claims) {
      const queryToken = url.searchParams.get('access_token')
      if (queryToken) claims = oauth.verify(queryToken)
    }
    if (!claims) return reject(401, 'gateway_auth_invalid', 'missing or expired bearer token')
    if (head.length > 0) return reject(400, 'gateway_ws_protocol_error', 'unexpected upgrade body')
    if (!acceptWebSocket(req, socket)) {
      socket.destroy()
      return
    }
    const conn = new WsConnection(socket, { pingIntervalMs: 30_000 })
    broadcaster.add(conn)
    attachWsConnection(
      {
        hub,
        queue,
        workspaceCwd: options.workspaceCwd,
        queueTimeoutMs,
        maxTurnHoldMs,
        serverId,
        version: options.version,
      },
      conn,
    )
  })

  let boundPort = options.port
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(options.port, options.host, () => resolveListen())
  })
  const address = server.address()
  boundPort = typeof address === 'object' && address ? address.port : options.port

  const hostForUrl = options.host === '0.0.0.0' ? '127.0.0.1' : options.host
  return {
    url: `http://${hostForUrl}:${boundPort}`,
    host: options.host,
    port: boundPort,
    serverId,
    close: () =>
      new Promise((resolveClose) => {
        if (permissionTimer) clearTimeout(permissionTimer)
        broadcaster.closeAll()
        server.close(() => resolveClose())
      }),
  }
}

/** 有界裸 body 读取（token 端点需要 form-urlencoded 原文）。 */
async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) return undefined
    chunks.push(buffer)
  }
  if (size === 0) return undefined
  return Buffer.concat(chunks)
}

/** token 请求体解析：form-urlencoded（RFC 6749 标准）或 JSON（便利形式）。 */
function parseTokenRequest(
  contentType: string | undefined,
  raw: Buffer,
): Map<string, string> | undefined {
  const mime = (contentType ?? '').split(';')[0]!.trim().toLowerCase()
  if (mime === 'application/x-www-form-urlencoded' || mime === '') {
    const params = new URLSearchParams(raw.toString('utf8'))
    const out = new Map<string, string>()
    for (const [key, value] of params) out.set(key, value)
    return out
  }
  if (mime === 'application/json') {
    try {
      const body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
      if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
      const out = new Map<string, string>()
      for (const [key, value] of Object.entries(body))
        if (typeof value === 'string') out.set(key, value)
      return out
    } catch {
      return undefined
    }
  }
  return undefined
}
