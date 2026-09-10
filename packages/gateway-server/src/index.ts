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
 *
 * 两种装配形态：
 * - 直挂：`hub` 直接挂本进程 SessionHub（库形态保留；产品面不再有 CLI 入口）；
 * - 中转 relay（远程控制 REM-r1）：`relay` 开启后 `/v1/*` 流量经 `/uplink`
 *   反向隧道路由到已注册的本机实例（RemoteHub），并开放 `/pairing/redeem`
 *   设备配对；`staticDir` 可同时托管移动端静态站（同源免 CORS）。
 *   独立入口 `dist/bin.js`（`volund-gateway` bin / deploy/gateway Docker 镜像）
 *   即此形态，不经 volund CLI。
 */
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { Duplex } from 'node:stream'

import { handleChatCompletion } from './chat'
import type { GatewayEnvelope, GatewayHubLike, GatewayModelListing, GatewayModelsView } from './hub'
import type { GatewayOAuthClient, GatewayTokenClaims } from './oauth'
import { GatewayOAuthServer } from './oauth'
import { PairingStore } from './pairing'
import type { PairedDeviceRecord } from './pairing'
import { GatewayError, TurnQueue } from './queue'
import { StaticSiteServer } from './static'
import { UplinkRegistry } from './uplink'
import { acceptWebSocket, WsConnection } from './websocket'
import { attachWsConnection, WsBroadcaster } from './ws'

export type { ChatCompletionParsed, TurnOutcome } from './chat'
export type {
  GatewayEnvelope,
  GatewayHubLike,
  GatewayModelListing,
  GatewayModelsView,
  GatewayStagedAttachment,
  GatewaySubmitAttachment,
} from './hub'
export type {
  GatewayOAuthClient,
  GatewayTokenClaims,
  GeneratedGatewayClient,
  IssuedToken,
  ParsedGatewayClients,
} from './oauth'
export {
  deriveSigningKey,
  GatewayOAuthServer,
  generateGatewayClient,
  hashGatewayClient,
  hashGatewayClientREFID_014Q,
  parseGatewayClients,
  signGatewayJwt,
  verifyGatewayJwt,
} from './oauth'
export { GatewayError, TurnQueue } from './queue'
export type { PairedDeviceRecord, PairingCodeRecord, RedeemResult } from './pairing'
export { PairingStore } from './pairing'
export { StaticSiteServer } from './static'
export type {
  UplinkCommandHandler,
  UplinkInstanceInfo,
  UplinkRegistration,
  UplinkRegistryOptions,
} from './uplink'
export { UplinkRegistry } from './uplink'
export { acceptWebSocket, WS_CLOSE, WsConnection } from './websocket'
export type {
  ClientFrame,
  GatewayFrame,
  HubRpcMethod,
  MachineFrame,
  ProtocolActiveState,
  ProtocolError,
  ServerFrame,
  ServerHelloFrame,
  UplinkCommandMethod,
  UplinkEventFrame,
  UplinkPingFrame,
  UplinkPongFrame,
  UplinkRegisterFrame,
  UplinkRegisteredFrame,
  UplinkRequestFrame,
  UplinkResponseFrame,
  UplinkRpcFrame,
  UplinkRpcResultFrame,
  UplinkStateFrame,
} from './protocol'
export type { GatewayCredentialsResolution, RelayServerConfig } from './relay-config'
export {
  createGatewayModelResolver,
  readModelAliases,
  resolveGatewayCredentials,
  resolveRelayConfig,
} from './relay-config'

/** 认证上下文：机器凭证 client=sub；设备 token sub=deviceId、client=绑定机器。 */
interface AuthContext {
  readonly sub: string
  readonly client: string
  readonly scopes: readonly string[]
  readonly expiresAt: number
  readonly device: boolean
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
  /**
   * 直挂模式的会话枢纽（CLI 传 SessionHub；测试传内存假实现）。
   * relay 模式下可省略（hub 与 relay 至少其一）。
   */
  readonly hub?: GatewayHubLike
  /**
   * 中转模式（远程控制）：本机经 /uplink 反向拨出注册，/v1/* 流量按
   * 认证 client 路由到对应实例；`pairing` 缺省时网关自建内存态配对存储。
   */
  readonly relay?: {
    readonly pairing?: PairingStore
  }
  /** 移动端静态站目录（Next 静态导出产物）；GET 非保留路径由此托管。 */
  readonly staticDir?: string
  /** 配对 URL 的公网基地址（https://gateway.ai-agentic.cc）；缺省按请求 Host 推断。 */
  readonly publicUrl?: string
  /**
   * 移动站单独部署时的站点公网基地址（https://m.example.com）。缺省 = publicUrl
   * （网关同源托管）。与网关不同源时配对 URL 指向移动站并携带 &gw=<网关地址>，
   * 移动站落 localStorage 后跨源调网关（此时须把移动站 Origin 加进 corsOrigins）。
   */
  readonly mobilePublicUrl?: string
  /** 会话工作区根：chat/completions 与 WS session.start 的 cwd 都被关进这里。 */
  readonly workspaceCwd: string
  readonly version: string
  /** GET /v1/models 数据源；缺省返回空列表。 */
  readonly listModels?: () => Promise<readonly GatewayModelListing[]>
  /** GET /v1/sessions 数据源（直挂模式；relay 模式经 uplink 取自本机）。 */
  readonly listSessions?: () => Promise<readonly unknown[]>
  /**
   * model 名归一钩子（别名 → 全限定 id → 裸名补 provider 前缀）。
   * 缺省实现：`provider/model` 原样、裸名补 defaultProvider 前缀。
   */
  readonly resolveModel?: (model: string) => string
  /** 缺省 resolveModel 用的 provider 前缀（默认 'openai'）。 */
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
  /** /pairing/redeem 每 IP 每分钟上限（默认 20）。 */
  readonly pairingRateLimitPerMinute?: number
  /** 允许跨域的 Origin 白名单；默认空 = 不下发任何 CORS 头。 */
  readonly corsOrigins?: readonly string[]
  /** JSON body 上限（默认 4 MiB）。 */
  readonly maxBodyBytes?: number
  /** POST /v1/attachments 原始字节上限（默认 20 MiB，与 AttachmentStore 一致）。 */
  readonly maxAttachmentBytes?: number
  readonly logger?: (message: string) => void
}

/** 上传端点接受的图片 MIME（字节魔数由本机侧 AttachmentStore.stage 二次校验）。 */
const ATTACHMENT_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export interface GatewayServerHandle {
  readonly url: string
  readonly host: string
  readonly port: number
  readonly serverId: string
  /** relay 模式下的 uplink 注册表（装配侧可查询在线实例）。 */
  readonly registry?: UplinkRegistry
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
  if (!options.hub && !options.relay)
    throw new Error('gateway requires either hub (direct mode) or relay (relay mode)')
  const serverId = randomBytes(16).toString('base64url')
  const oauth = new GatewayOAuthServer(options.oauth)
  const hub = options.hub
  const queue = new TurnQueue()
  const startedAt = Date.now()
  const queueTimeoutMs = options.queueTimeoutMs ?? 600_000
  const permissionTimeoutMs = options.permissionTimeoutMs ?? 120_000
  const maxTurnHoldMs = options.maxTurnHoldMs ?? 30 * 60_000
  const maxBodyBytes = options.maxBodyBytes ?? 4 * 1024 * 1024
  // 附件上传上限与 AttachmentStore 的 20 MiB 一致（字节直传，不经 JSON）。
  const maxAttachmentBytes = options.maxAttachmentBytes ?? 20 * 1024 * 1024
  const corsOrigins = new Set(options.corsOrigins ?? [])
  const apiLimiter = new RateLimiter(options.rateLimitPerMinute ?? 600)
  const tokenLimiter = new RateLimiter(options.tokenRateLimitPerMinute ?? 30)
  const pairingLimiter = new RateLimiter(options.pairingRateLimitPerMinute ?? 20)
  const log = options.logger ?? (() => {})
  const registry = new UplinkRegistry({ logger: log })
  const pairing =
    options.relay?.pairing ??
    (options.relay
      ? new PairingStore({
          signingKey: options.oauth.signingKey,
          issuer: options.oauth.issuer,
          logger: log,
        })
      : undefined)
  const staticSite = options.staticDir
    ? new StaticSiteServer({ rootDir: options.staticDir })
    : undefined

  // ── 统一事件面：直挂 hub 的信封（source=undefined → 广播不筛）与 relay
  // uplink 的信封（source=client id → 只发归属该机器的连接）。 ──────────────
  const envelopeListeners = new Set<
    (source: string | undefined, envelope: GatewayEnvelope) => void
  >()
  const dispatchEnvelope = (source: string | undefined, envelope: GatewayEnvelope): void => {
    for (const listener of envelopeListeners) listener(source, envelope)
  }
  hub?.subscribe((envelope) => dispatchEnvelope(undefined, envelope))
  if (options.relay) registry.subscribe((client, envelope) => dispatchEnvelope(client, envelope))

  // ── 审批超时兜底：无人决策的权限请求到点自动 deny（chat/completions 没有
  // 交互审批面；WS 客户端掉线同理）。decide 幂等，已被决策的请求静默忽略。
  // relay 模式下审批来自某台已注册机器——deny 必须路由回同一台。 ─────────────
  let permissionTimer: ReturnType<typeof setTimeout> | undefined
  let permissionSource: string | undefined
  if (permissionTimeoutMs > 0) {
    envelopeListeners.add((source, envelope) => {
      const event = envelope.event as { type?: unknown; request?: { id?: unknown } }
      if (envelope.kind === 'view' && event?.type === 'permission.request') {
        const requestId = typeof event.request?.id === 'string' ? event.request.id : undefined
        if (!requestId) return
        permissionSource = source
        if (permissionTimer) clearTimeout(permissionTimer)
        permissionTimer = setTimeout(() => {
          log(
            `permission ${requestId} auto-denied after ${permissionTimeoutMs}ms without a decider`,
          )
          const target = permissionSource ? registry.resolve(permissionSource)?.hub : hub
          target?.decide(requestId, 'deny')
          permissionSource = undefined
        }, permissionTimeoutMs)
        permissionTimer.unref?.()
      }
      if (envelope.kind === 'view' && event?.type === 'permission.resolved' && permissionTimer) {
        clearTimeout(permissionTimer)
        permissionTimer = undefined
        permissionSource = undefined
      }
    })
  }

  const broadcaster = new WsBroadcaster((subscribe) => {
    envelopeListeners.add(subscribe)
    return () => envelopeListeners.delete(subscribe)
  })

  const authenticate = async (req: IncomingMessage): Promise<AuthContext | undefined> => {
    const token = bearerToken(req)
    if (!token) return undefined
    const claims: GatewayTokenClaims | undefined = oauth.verify(token)
    if (claims) return { ...claims, client: claims.sub, device: false }
    if (pairing) {
      const device = await pairing.verifyDeviceToken(token)
      if (device)
        return {
          sub: device.sub,
          client: device.client,
          scopes: device.scopes.length ? device.scopes : ['chat'],
          expiresAt: device.expiresAt,
          device: true,
        }
    }
    return undefined
  }

  const offline = () =>
    new GatewayError(
      'gateway_uplink_offline',
      503,
      'no machine is connected to this gateway; start remote control on the desktop first',
    )

  /** 认证 client → 会话枢纽（直挂=进程内 hub；relay=该机器的 RemoteHub）。 */
  const resolveHub = (auth: AuthContext): GatewayHubLike => {
    if (!options.relay) {
      if (!hub) throw offline()
      return hub
    }
    const registration = registry.resolve(auth.client)
    if (!registration) throw offline()
    return registration.hub
  }

  /** cwd 关卡的工作区根（relay=注册实例上报的本机工作区）。 */
  const workspaceFor = (auth: AuthContext | undefined): string =>
    options.relay && auth
      ? (registry.resolve(auth.client)?.info.workspaceCwd ?? options.workspaceCwd)
      : options.workspaceCwd

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

  /** uplink 侧本机发起的请求（配对码/设备管理）→ 网关处理器。 */
  const uplinkCommandHandler = async (input: {
    readonly method: string
    readonly params: Record<string, unknown>
    readonly client: string
    readonly hostHeader: string
  }): Promise<unknown> => {
    if (!pairing)
      throw new GatewayError(
        'gateway_schema_invalid',
        404,
        `unknown uplink command: ${input.method}`,
      )
    switch (input.method) {
      case 'pairing.create': {
        const code = await pairing.createCode(input.client)
        return {
          code: code.code,
          url: pairingUrl(input.hostHeader, code.code),
          expiresAt: code.expiresAt,
        }
      }
      case 'devices.list': {
        const devices = await pairing.listDevices(input.client)
        return { devices: devices.map(viewDevice) }
      }
      case 'device.revoke': {
        const deviceId = input.params.deviceId
        if (typeof deviceId !== 'string' || !deviceId)
          throw new GatewayError('gateway_schema_invalid', 400, 'deviceId is required')
        const revoked = await pairing.revokeDevice(input.client, deviceId)
        // 撤销即失效要覆盖存量：注册表删除只挡新握手，已建立的 WS 连接必须主动踢掉。
        if (revoked) broadcaster.closeDevice(deviceId)
        return { revoked }
      }
      default:
        throw new GatewayError(
          'gateway_schema_invalid',
          400,
          `unknown uplink command: ${input.method}`,
        )
    }
  }

  /** 配对入口 URL：移动站单独部署（mobilePublicUrl）时指向移动站并携带 &gw= 网关地址。 */
  const pairingUrl = (hostHeader: string, code: string): string => {
    const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(hostHeader)
    const scheme = loopback ? 'http' : 'https'
    const gatewayBase = options.publicUrl
      ? options.publicUrl.replace(/\/+$/, '')
      : `${scheme}://${hostHeader}`
    const mobileBase = options.mobilePublicUrl?.replace(/\/+$/, '')
    if (mobileBase && mobileBase !== gatewayBase)
      return `${mobileBase}/#pair=${code}&gw=${encodeURIComponent(gatewayBase)}`
    return `${mobileBase ?? gatewayBase}/#pair=${code}`
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://gateway.internal')
    const path = url.pathname
    const cors = corsHeaders(req)

    // 统一 CORS 注入点：白名单命中后，本请求的全部响应（ok/fail 的 JSON、
    // chat 的 SSE、静态站）都必须带 Access-Control-Allow-*——只挂预检的话，
    // 浏览器拿到实际响应没 allow 头照样拦截（redeem 跨域报错即此坑）。
    if (cors['Access-Control-Allow-Origin']) {
      const writeHead = res.writeHead.bind(res) as (
        statusCode: number,
        headers?: Record<string, string | number | string[]>,
      ) => ServerResponse
      res.writeHead = ((statusCode: number, headers?: Record<string, string | number | string[]>) =>
        writeHead(statusCode, { ...cors, ...headers })) as ServerResponse['writeHead']
    }

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
        ...(options.relay ? { relay: { instances: registry.list().length } } : {}),
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
      // 标准字段是 client_id/client_secret；{id, secret} 简写也收（内部工具/测试便利）。
      let clientId = fields.get('client_id') ?? fields.get('id') ?? ''
      let clientSecret = fields.get('client_secret') ?? fields.get('secret') ?? ''
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

    // ── 设备配对核销（公开端点，IP 限流收敛爆破面；错误不区分码是否存在）──
    if (path === '/pairing/redeem' && req.method === 'POST') {
      if (!pairing)
        return fail(
          res,
          new GatewayError(
            'gateway_schema_invalid',
            404,
            `unknown endpoint: ${req.method} ${path}`,
          ),
        )
      const retryAfter = pairingLimiter.hit(`pairing:${req.socket.remoteAddress ?? 'unknown'}`)
      if (retryAfter !== undefined)
        return fail(
          res,
          new GatewayError('gateway_rate_limited', 429, 'too many pairing requests'),
          {
            'Retry-After': String(retryAfter),
          },
        )
      const body = await readJsonBody(req, maxBodyBytes)
      if (body === undefined)
        return fail(
          res,
          new GatewayError('gateway_schema_invalid', 400, 'invalid or oversized JSON body'),
        )
      const entry = body as { code?: unknown; name?: unknown }
      if (typeof entry.code !== 'string' || !entry.code)
        return fail(res, new GatewayError('gateway_schema_invalid', 400, 'code is required'))
      const redeemed = await pairing.redeem(
        entry.code,
        typeof entry.name === 'string' ? entry.name : undefined,
      )
      if (!redeemed)
        return fail(
          res,
          new GatewayError('gateway_pairing_invalid', 400, 'pairing code is invalid or expired'),
        )
      ok(res, {
        access_token: redeemed.result.accessToken,
        token_type: redeemed.result.tokenType,
        expires_in: redeemed.result.expiresIn,
        device_id: redeemed.result.deviceId,
        scope: redeemed.result.scope,
      })
      return
    }

    // ── 其余 /v1/* 一律 Bearer 认证 + 每客户端限流 ───────────────────────
    if (path.startsWith('/v1/')) {
      const auth = await authenticate(req)
      if (!auth)
        return fail(
          res,
          new GatewayError('gateway_auth_invalid', 401, 'missing or expired bearer token'),
          {
            'WWW-Authenticate': 'Bearer realm="volund-gateway"',
          },
        )
      const retryAfter = apiLimiter.hit(`client:${auth.sub}`)
      if (retryAfter !== undefined)
        return fail(res, new GatewayError('gateway_rate_limited', 429, 'rate limit exceeded'), {
          'Retry-After': String(retryAfter),
        })

      if (path === '/v1/models' && req.method === 'GET') {
        // relay 模式经隧道取自本机（hub.listModels 未实现 = 空列表，与直挂缺省一致）。
        if (options.relay) {
          let view: GatewayModelsView = { options: [] }
          try {
            const remote = resolveHub(auth)
            if (remote.listModels) view = await remote.listModels()
          } catch (cause) {
            // 模型清单是 UI 便利面：本机离线降级为空清单（不阻断认证探测/选择器隐藏）。
            if (!(cause instanceof GatewayError && cause.code === 'gateway_uplink_offline'))
              throw cause
          }
          ok(res, {
            object: 'list',
            ...(view.current ? { current: view.current } : {}),
            data: view.options.map((model) => ({
              id: model.id,
              object: 'model',
              created: Math.floor(startedAt / 1000),
              owned_by: 'volund',
              ...(model.label ? { label: model.label } : {}),
            })),
          })
          return
        }
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
        if (options.relay) {
          // RemoteHub 在 GatewayHubLike 之外多一个 listSessions（会话清单经隧道取自本机）。
          const remote = resolveHub(auth) as unknown as {
            listSessions?: () => Promise<readonly unknown[]>
          }
          ok(res, { sessions: remote.listSessions ? await remote.listSessions() : [] })
          return
        }
        ok(res, { sessions: (await options.listSessions?.()) ?? [] })
        return
      }

      if (path === '/v1/sessions/active/transcript' && req.method === 'GET') {
        // 活动会话快照（relay 经隧道取自本机；直挂模式 hub 未实现该面则空视图）。
        const hubForAuth = resolveHub(auth) as unknown as {
          transcript?(): Promise<{ transcript?: readonly unknown[] }>
        }
        ok(res, hubForAuth.transcript ? await hubForAuth.transcript() : { transcript: [] })
        return
      }

      // ── 附件上传（图片字节 → 经隧道进本机 AttachmentStore 暂存 → handle 引用）──
      if (path === '/v1/attachments' && req.method === 'POST') {
        const mime = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
        if (!ATTACHMENT_MIMES.has(mime))
          return fail(
            res,
            new GatewayError(
              'gateway_unsupported_content',
              400,
              `unsupported attachment type: ${mime || '<missing>'}`,
            ),
          )
        // Content-Length 预检给出明确的 413（chunked 缺长时 oversized 落进下面的 400）。
        const declared = Number(req.headers['content-length'] ?? 0)
        if (declared > maxAttachmentBytes)
          return fail(
            res,
            new GatewayError(
              'gateway_unsupported_content',
              413,
              `attachment exceeds ${maxAttachmentBytes} bytes`,
            ),
          )
        const bytes = await readRawBody(req, maxAttachmentBytes)
        if (!bytes || bytes.length === 0)
          return fail(
            res,
            new GatewayError(
              'gateway_schema_invalid',
              400,
              'attachment body is required and must fit the size limit',
            ),
          )
        let hubForUpload: GatewayHubLike
        try {
          hubForUpload = resolveHub(auth)
        } catch (cause) {
          return fail(res, cause instanceof GatewayError ? cause : offline())
        }
        if (typeof hubForUpload.stageAttachment !== 'function')
          return fail(
            res,
            new GatewayError(
              'gateway_unsupported_content',
              400,
              'attachments are not supported by this hub',
            ),
          )
        try {
          ok(
            res,
            await hubForUpload.stageAttachment({ mime, dataBase64: bytes.toString('base64') }),
          )
        } catch (cause) {
          return fail(res, cause instanceof GatewayError ? cause : offline())
        }
        return
      }

      // ── 附件字节回放（移动站 transcript 图片回显；经隧道反向取本机 AttachmentStore）──
      const attachmentHandle = /^\/v1\/attachments\/([a-f0-9]{64}\.(?:png|jpg|gif|webp))$/.exec(
        path,
      )?.[1]
      if (attachmentHandle !== undefined && req.method === 'GET') {
        let hubForRead: GatewayHubLike
        try {
          hubForRead = resolveHub(auth)
        } catch (cause) {
          return fail(res, cause instanceof GatewayError ? cause : offline())
        }
        if (typeof hubForRead.readAttachment !== 'function')
          return fail(
            res,
            new GatewayError(
              'gateway_attachment_not_found',
              404,
              'attachment reads are not supported by this hub',
            ),
          )
        try {
          const found = await hubForRead.readAttachment(attachmentHandle)
          if (!found)
            return fail(
              res,
              new GatewayError('gateway_attachment_not_found', 404, 'attachment not found'),
            )
          const bytes = Buffer.from(found.dataBase64, 'base64')
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            'Content-Type': found.mime,
            // 内容寻址 handle → 字节不可变，长缓存安全。
            'Cache-Control': 'private, max-age=31536000, immutable',
            'Content-Length': bytes.length,
          })
          res.end(bytes)
        } catch (cause) {
          return fail(res, cause instanceof GatewayError ? cause : offline())
        }
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
              hub: resolveHub(auth),
              queue,
              workspaceCwd: workspaceFor(auth),
              resolveModel:
                options.resolveModel ??
                ((model) =>
                  model.includes('/') ? model : `${options.defaultProvider ?? 'openai'}/${model}`),
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

    // ── 移动端静态站（非保留路径的 GET；SPA 回退 index.html） ─────────────
    if (staticSite && (req.method === 'GET' || req.method === 'HEAD')) {
      await staticSite.serve(path, res)
      return
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

  // ── WebSocket 升级通道（/v1/ws 客户端 + /uplink 本机反向拨出） ────────────
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
    const authenticateUpgrade = async (): Promise<AuthContext | undefined> => {
      // 认证：优先 Authorization 头；浏览器 WS 不能自定义头 → ?access_token= 兜底。
      const token = bearerToken(req) ?? url.searchParams.get('access_token') ?? undefined
      if (!token) return undefined
      const claims = oauth.verify(token)
      if (claims) return { ...claims, client: claims.sub, device: false }
      if (pairing) {
        const resolved = await pairing.verifyDeviceToken(token).catch(() => undefined)
        if (resolved)
          return {
            sub: resolved.sub,
            client: resolved.client,
            scopes: resolved.scopes.length ? resolved.scopes : ['chat'],
            expiresAt: resolved.expiresAt,
            device: true,
          }
      }
      return undefined
    }
    void (async () => {
      if (url.pathname === '/uplink') {
        if (!options.relay)
          return reject(404, 'gateway_schema_invalid', 'unknown websocket endpoint')
        const auth = await authenticateUpgrade()
        if (!auth) return reject(401, 'gateway_auth_invalid', 'missing or expired bearer token')
        if (!auth.scopes.includes('uplink'))
          return reject(403, 'gateway_auth_invalid', 'uplink requires the uplink scope')
        if (head.length > 0)
          return reject(400, 'gateway_ws_protocol_error', 'unexpected upgrade body')
        if (!acceptWebSocket(req, socket)) return socket.destroy()
        // 附件暂存 RPC 载 base64 字节（20 MiB 原图 ≈ 27 MiB 帧）——uplink 帧上限放到 32 MiB。
        const conn = new WsConnection(socket, {
          pingIntervalMs: 30_000,
          maxMessageBytes: 32 * 1024 * 1024,
        })
        const hostHeader = req.headers.host ?? ''
        registry.attach(conn, {
          client: auth.client,
          serverId,
          version: options.version,
          commandHandler: ({ method, params }) =>
            uplinkCommandHandler({ method, params, client: auth.client, hostHeader }),
        })
        return
      }
      if (url.pathname !== '/v1/ws')
        return reject(404, 'gateway_schema_invalid', 'unknown websocket endpoint')
      const auth = await authenticateUpgrade()
      if (!auth) return reject(401, 'gateway_auth_invalid', 'missing or expired bearer token')
      if (head.length > 0)
        return reject(400, 'gateway_ws_protocol_error', 'unexpected upgrade body')
      let hubForConnection: GatewayHubLike
      try {
        hubForConnection = resolveHub(auth)
      } catch (cause) {
        const error = cause instanceof GatewayError ? cause : offline()
        return reject(error.status, error.code, error.message)
      }
      if (!acceptWebSocket(req, socket)) {
        socket.destroy()
        return
      }
      const conn = new WsConnection(socket, { pingIntervalMs: 30_000 })
      broadcaster.add(conn, auth.client, auth.device ? auth.sub : undefined)
      attachWsConnection(
        {
          hub: hubForConnection,
          queue,
          workspaceCwd: workspaceFor(auth),
          queueTimeoutMs,
          maxTurnHoldMs,
          serverId,
          version: options.version,
        },
        conn,
      )
    })()
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
    ...(options.relay ? { registry } : {}),
    close: () =>
      new Promise((resolveClose) => {
        if (permissionTimer) clearTimeout(permissionTimer)
        broadcaster.closeAll()
        registry.closeAll()
        server.close(() => resolveClose())
      }),
  }
}

/** 设备视图（secret 类信息不出网关；lastSeen 供「在线状态」粗判）。 */
function viewDevice(device: PairedDeviceRecord): Record<string, unknown> {
  return {
    id: device.id,
    name: device.name,
    pairedAt: device.pairedAt,
    lastSeen: device.lastSeen,
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
