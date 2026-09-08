/**
 * @volund/web-server — Volund Web 的 loopback HTTP/SSE 网关（§22.7.3 / Web 计划 P2-02/03/05）。
 *
 * 安全模型（§22.10，本模块的硬门）：
 * - 只绑 loopback（127.0.0.1 / ::1）；Host/Origin 精确匹配绑定地址，其余拒绝；
 * - 进入无 token 门：GET /api/v1/bootstrap 在无有效 cookie 时自动签发
 *   HttpOnly SameSite=Strict browser session + 内存态 CSRF token；
 *   mutation 必须同站 Origin + cookie + CSRF 头三件套；
 * - /api/v1 其余读端点也要 browser session；严格 CSP / nosniff / no-referrer /
 *   API 禁缓存；请求体 64 KiB 上限（附件端点 20 MiB 裸字节单列）；
 * - 错误恒为 { error: { code, message } }；敏感值（credential/token）永不进 payload。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { extname, join, normalize } from 'node:path'

import { acceptWebSocket, WsConnection } from '@volund/gateway-server'
import type { SubmitAttachment } from '@volund/shared'

import { actionDispatcher, type ManagementPorts } from './management'
import type { SessionGroupsPort } from './session-groups'
import type { TerminalPort } from './terminal'
import type { WorkbenchPort } from './workbench'

/** W-08：会话变更/undo 的宿主端口（BackupStore 背书）。 */
export interface ChangesPortLike {
  list(sessionId: string): Promise<unknown>
  previewUndo(sessionId: string): Promise<unknown>
  undoStep(sessionId: string): Promise<unknown>
}
import { SessionHub } from './session-hub'

/** §22.8.2 之外的管理面宿主端口的最小结构面（由 apps/cli 用真实 VolundPorts 装配）。 */
export interface WebRuntimePorts {
  readonly identity: { readonly version: string }
  readonly cwd: string
  readonly session?: {
    list?(): Promise<readonly unknown[]>
  }
  readonly config?: {
    status?(input: { cwd: string }): Promise<unknown>
    /**
     * §11.3.3 config 写（web 设置页）：web 层只做 key 形状门，schema 校验
     * （未知 key / 类型错）由端口内 assertConfigKeyValue 把守；一律写用户级
     * config.toml（web 不提供 project scope——§8.3.1 数据流向门因此天然满足）。
     */
    setValue?(input: { cwd: string; key: string; value: unknown }): Promise<unknown>
    /** W-13 set/replace/clear 三件套之 clear：删除用户级 key 并剪掉空父表。 */
    unsetValue?(input: { cwd: string; key: string }): Promise<unknown>
    /** W-13 设置页读取：user+project 合并视图；凭据键在 web 层脱敏为 presence。 */
    listMerged?(input: { cwd: string }): Promise<unknown>
    /** 系统信息区展示用：user/project 两个 config.toml 的路径。 */
    filePaths?(input: { cwd: string }): { user: string; project: string }
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
  /** 测试注入：会话有效期（默认 12h）。 */
  readonly sessionTtlMs?: number
  /** P3：会话枢纽（存在即开放会话写端点；§22.3.4 诚实能力面）。 */
  readonly sessionHub?: SessionHub
  /** W-01：随 TUI 静默启动的嵌入模式（会话所有权在 TUI；前端据此降级会话切换入口）。 */
  readonly embedded?: boolean
  /** P4：管理面（memory/skills/mcp/plugins/telemetry）。 */
  readonly management?: ManagementPorts
  /** W-08：会话变更与 undo。 */
  readonly changes?: ChangesPortLike
  /** W-06：模型列表（当前生效模型 + config 别名解析后的 provider/model 候选）。 */
  readonly models?: {
    list(): Promise<unknown>
  }
  /** §4.4 三档权限模式（ask/auto/full）的读取与切换。 */
  readonly permissionMode?: {
    current(): string
    set(mode: 'ask' | 'auto' | 'full'): void
  }
  /** 侧栏会话分组（分组 CRUD + 会话归属）；缺失时端点 503、前端隐藏分组入口。 */
  readonly sessionGroups?: SessionGroupsPort
  /** 工作台（右侧栏：文件树/读取/写入/搜索/git）；缺失时端点 503、前端隐藏入口。 */
  readonly workbench?: WorkbenchPort
  /** 工作台终端（交互式 shell over WebSocket）；缺失时前端隐藏终端入口。 */
  readonly terminal?: TerminalPort
}

export interface WebServerHandle {
  /** 启动 URL（无鉴权 fragment——进入即用，bootstrap 自动签发 browser session）。 */
  readonly url: string
  readonly host: string
  readonly port: number
  readonly serverId: string
  readonly close: () => Promise<void>
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1'])
const MAX_BODY_BYTES = 64 * 1024
/** 工作台文件保存的 body 上限（与端口内 writeText 的内容上限同量级）。 */
const MAX_WRITE_BODY_BYTES = 3 * 1024 * 1024
/** W-05 附件上传上限：与 AttachmentStore 的 20 MiB 一致（图片字节直传，不经 JSON）。 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
/** 上传端点接受的图片 MIME（字节魔数由 AttachmentStore.stage 二次校验）。 */
const ATTACHMENT_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const SSE_MAX_QUEUE = 1000

interface BrowserSession {
  readonly id: string
  readonly csrfToken: string
  readonly createdAt: number
  readonly expiresAt: number
}

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

/**
 * HTML 响应的 per-request CSP nonce（Next 静态导出的引导脚本与我们的主题
 * bootstrap 是内联脚本）：重写 `<script` 标签挂 nonce，CSP 同步放开。
 * 只用于 HTML；其余资产保持 script-src 'self'。
 */
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

function ok(res: ServerResponse, data: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify({ data })
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 域是否装配（写动作的诚实降级门）。 */
function mgmtSupports(mgmt: ManagementPorts, domain: string): boolean {
  switch (domain) {
    case 'memory':
      return mgmt.memory !== undefined
    case 'skill':
      return mgmt.skill !== undefined
    case 'mcp':
      return mgmt.mcp !== undefined
    case 'plugins':
      return mgmt.plugins !== undefined
    case 'telemetry':
      return mgmt.telemetry !== undefined
    default:
      return false
  }
}

/** 域错误的统一映射：带 code 的错误按语义取状态码，其余 500。 */
const FAIL_STATUS: Record<string, number> = {
  web_session_invalid: 409,
  session_turn_in_progress: 409,
  web_state_conflict: 409,
  web_attachment_rejected: 400,
  web_schema_invalid: 400,
  session_id_invalid: 400,
  config_unknown_key: 400,
  config_invalid: 400,
  config_project_forbidden: 403,
  web_capability_unavailable: 503,
  session_not_found: 404,
  web_session_group_not_found: 404,
}

function failFrom(res: ServerResponse, cause: unknown): void {
  const code = (cause as { code?: string } | undefined)?.code
  const message = cause instanceof Error ? cause.message : String(cause)
  fail(res, (code !== undefined && FAIL_STATUS[code]) || 500, {
    code: code ?? 'internal_error',
    message,
  })
}

/**
 * W-13 凭据只写不读：设置页读取 config 时把敏感值替换为 presence 标记
 * （`true` = 已设置），并把被脱敏的 key 路径收进 redacted 列表供 UI 展示
 * "已设置（不回显）"。脱敏面：[auth] 段除 skipAuth 外的全部 key（§8.4），
 * 以及 [env] 段中 `*_api_key` 结尾的名字（§8.3.1 通用模式同族）。
 */
function redactConfigCredentials(config: Record<string, unknown>): {
  config: Record<string, unknown>
  redacted: string[]
} {
  const redacted: string[] = []
  const clone = structuredClone(config)
  const auth = clone.auth
  if (auth && typeof auth === 'object' && !Array.isArray(auth)) {
    for (const [key, value] of Object.entries(auth as Record<string, unknown>)) {
      if (key === 'skipAuth' || typeof value !== 'string') continue
      ;(auth as Record<string, unknown>)[key] = true
      redacted.push(`auth.${key}`)
    }
  }
  const env = clone.env
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (!/_api_key$/i.test(key) || typeof value !== 'string') continue
      ;(env as Record<string, unknown>)[key] = true
      redacted.push(`env.${key}`)
    }
  }
  return { config: clone, redacted }
}

/** config/set、config/unset 的 key 形状门（与 config-edit assertSafeKey 同规则）。 */
function isConfigKeyShape(key: unknown): key is string {
  return (
    typeof key === 'string' && /^[\w@.-]+$/.test(key) && !key.split('.').some((part) => part === '')
  )
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
  const sessions = new Map<string, BrowserSession>()
  const sessionTtl = options.sessionTtlMs ?? 12 * 60 * 60_000
  const startedAt = Date.now()

  const createSession = (): BrowserSession => {
    const session: BrowserSession = {
      id: randomBytes(24).toString('base64url'),
      csrfToken: randomBytes(24).toString('base64url'),
      createdAt: Date.now(),
      expiresAt: Date.now() + sessionTtl,
    }
    sessions.set(session.id, session)
    return session
  }

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

    // 进入无 token 门：bootstrap 在无有效 cookie 时自动签发 browser session
    //（Set-Cookie + payload 带回 CSRF token）。硬门收敛在 loopback + Host 精确
    // 匹配 + 无 CORS 放行（跨站响应浏览器读不到）+ mutation 的 Origin/CSRF 三件套。
    if (path === '/api/v1/bootstrap' && req.method === 'GET') {
      let session = findSession(req)
      const extraHeaders: Record<string, string> = {}
      if (!session) {
        session = createSession()
        extraHeaders['Set-Cookie'] =
          `volund_session=${session.id}; HttpOnly; SameSite=Strict; Path=/`
      }
      const ports = options.ports
      ok(
        res,
        {
          server: { serverId, version: ports.identity.version, startedAt },
          workspace: { cwd: ports.cwd },
          // 已认证页面恢复会话用（刷新后内存态 CSRF 丢失；cookie 本身就是凭证）。
          session: { csrfToken: session.csrfToken, expiresAt: session.expiresAt },
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
            // §22.3.4 诚实状态：写能力随 sessionHub 装配而开放。
            mutations: {
              turnSubmit: options.sessionHub !== undefined,
              permissionDecision: options.sessionHub !== undefined,
              attachments: options.sessionHub !== undefined,
            },
            // W-01：嵌入式（随 TUI 静默启动）——会话切换/结束由 TUI 持有，前端降级。
            embedded: options.embedded === true,
            models: options.models !== undefined,
            permissionMode: options.permissionMode !== undefined,
            sessionGroups: options.sessionGroups !== undefined,
            // 工作台（文件树/搜索/git）：端口装配即全开（路径逃逸门在端口内）。
            workbench: options.workbench !== undefined,
            // 工作台终端（交互式 shell over WS）：与 workbench 分开计能力。
            terminal: options.terminal !== undefined,
            // W-13：设置页全量 config（读合并视图 + 写/清用户级）。
            config:
              options.ports.config?.listMerged !== undefined &&
              options.ports.config?.setValue !== undefined,
            management: {
              memory: options.management?.memory !== undefined,
              skill: options.management?.skill !== undefined,
              mcp: options.management?.mcp !== undefined,
              plugins: options.management?.plugins !== undefined,
              telemetry: options.management?.telemetry !== undefined,
            },
          },
        },
        extraHeaders,
      )
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

    if (path === '/api/v1/sessions' && req.method === 'GET') {
      if (!options.ports.session?.list) {
        fail(res, 503, { code: 'web_capability_unavailable', message: 'session port is not wired' })
        return
      }
      ok(res, { sessions: await options.ports.session!.list!() })
      return
    }

    // 退出登录：销毁当前 browser session（cookie 过期+服务端删除）；刷新页面即自动重签。
    if (path === '/api/v1/browser-session/logout' && req.method === 'POST') {
      const cookieId = parseCookies(req.headers.cookie).get('volund_session')
      if (cookieId) sessions.delete(cookieId)
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': 'volund_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
      })
      res.end(JSON.stringify({ data: { loggedOut: true } }))
      return
    }

    // ── W-13 设置页 config 读取/写入/清除 ────────────────────────────
    // 写入面不做键白名单：web 层只验 key 形状，schema 校验（未知 key / 类型错）
    // 由端口 assertConfigKeyValue 把守（config_unknown_key/config_invalid → 400）。
    // 一律写用户级 config.toml（web 无 project scope）；凭据键只写不读——
    // 读取经 redactConfigCredentials 脱敏为 presence 标记后才出 payload。
    if (path === '/api/v1/config' && req.method === 'GET') {
      if (!options.ports.config?.listMerged) {
        fail(res, 503, { code: 'web_capability_unavailable', message: 'config port is not wired' })
        return
      }
      try {
        const merged = (await options.ports.config.listMerged({ cwd: options.ports.cwd })) as {
          config?: Record<string, unknown>
          warnings?: string[]
        }
        const { config, redacted } = redactConfigCredentials(merged.config ?? {})
        ok(res, {
          config,
          redacted,
          warnings: merged.warnings ?? [],
          files: options.ports.config.filePaths?.({ cwd: options.ports.cwd }),
        })
      } catch (cause) {
        failFrom(res, cause)
      }
      return
    }
    if (path === '/api/v1/config/set' && req.method === 'POST') {
      if (!options.ports.config?.setValue) {
        fail(res, 503, { code: 'web_capability_unavailable', message: 'config port is not wired' })
        return
      }
      const body = await readJsonBody(req)
      const key = (body as { key?: unknown })?.key
      const value = (body as { value?: unknown })?.value
      if (!isConfigKeyShape(key)) {
        fail(res, 400, {
          code: 'web_schema_invalid',
          message: `malformed config key: ${String(key)}`,
        })
        return
      }
      // 自锁死门：web.enabled=false 会让下次 TUI 不再起 Web 控制台——本控制台
      // 不能关掉自己，该键只能经 CLI（volund config set）调整。
      if (key === 'web.enabled') {
        fail(res, 403, {
          code: 'web_capability_unavailable',
          message: 'web.enabled is not adjustable from the web console; use the CLI instead',
        })
        return
      }
      if (value === undefined) {
        fail(res, 400, { code: 'web_schema_invalid', message: 'value is required' })
        return
      }
      try {
        ok(res, await options.ports.config.setValue({ cwd: options.ports.cwd, key, value }))
      } catch (cause) {
        failFrom(res, cause)
      }
      return
    }
    if (path === '/api/v1/config/unset' && req.method === 'POST') {
      if (!options.ports.config?.unsetValue) {
        fail(res, 503, { code: 'web_capability_unavailable', message: 'config port is not wired' })
        return
      }
      const body = await readJsonBody(req)
      const key = (body as { key?: unknown })?.key
      if (!isConfigKeyShape(key)) {
        fail(res, 400, {
          code: 'web_schema_invalid',
          message: `malformed config key: ${String(key)}`,
        })
        return
      }
      try {
        ok(res, await options.ports.config.unsetValue({ cwd: options.ports.cwd, key }))
      } catch (cause) {
        failFrom(res, cause)
      }
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

    // ── W-06 模型列表 / §4.4 权限模式 ────────────────────────────────
    if (path === '/api/v1/models' && req.method === 'GET') {
      if (!options.models) {
        fail(res, 503, { code: 'web_capability_unavailable', message: 'models port is not wired' })
        return
      }
      ok(res, await options.models.list())
      return
    }
    if (path === '/api/v1/permission-mode' && req.method === 'GET') {
      if (!options.permissionMode) {
        fail(res, 503, {
          code: 'web_capability_unavailable',
          message: 'permission mode port is not wired',
        })
        return
      }
      ok(res, { mode: options.permissionMode.current() })
      return
    }
    if (path === '/api/v1/permission-mode' && req.method === 'POST') {
      if (!options.permissionMode) {
        fail(res, 503, {
          code: 'web_capability_unavailable',
          message: 'permission mode port is not wired',
        })
        return
      }
      const body = await readJsonBody(req)
      const mode = (body as { mode?: unknown })?.mode
      if (mode !== 'ask' && mode !== 'auto' && mode !== 'full') {
        fail(res, 400, {
          code: 'web_schema_invalid',
          message: 'mode must be one of ask | auto | full',
        })
        return
      }
      options.permissionMode.set(mode)
      ok(res, { mode: options.permissionMode.current() })
      return
    }

    // ── 侧栏会话分组（纯组织元数据：CRUD + 会话归属，不碰会话本体）──────────
    const sessionGroups = options.sessionGroups
    if (path === '/api/v1/session-groups' && req.method === 'GET') {
      if (!sessionGroups) {
        fail(res, 503, {
          code: 'web_capability_unavailable',
          message: 'session groups port is not wired',
        })
        return
      }
      const view = await sessionGroups.list()
      // 视图级裁剪：已消失会话的归属不下发（存储里的陈旧条目随删组/重分配收敛）。
      if (options.ports.session?.list) {
        const known = new Set(
          (await options.ports.session.list()).map((session) => (session as { id?: unknown }).id),
        )
        const assignments: Record<string, string> = {}
        for (const [sessionId, groupId] of Object.entries(view.assignments))
          if (known.has(sessionId)) assignments[sessionId] = groupId
        ok(res, { groups: view.groups, assignments })
        return
      }
      ok(res, view)
      return
    }
    if (path.startsWith('/api/v1/session-groups') && req.method === 'POST') {
      if (!sessionGroups) {
        fail(res, 503, {
          code: 'web_capability_unavailable',
          message: 'session groups port is not wired',
        })
        return
      }
      const body = (await readJsonBody(req)) as Record<string, unknown> | undefined
      if (body === undefined) {
        fail(res, 400, { code: 'web_schema_invalid', message: 'invalid JSON body' })
        return
      }
      try {
        if (path === '/api/v1/session-groups') {
          if (typeof body.name !== 'string') {
            fail(res, 400, { code: 'web_schema_invalid', message: 'name is required' })
            return
          }
          ok(res, { group: await sessionGroups.create(body.name) })
          return
        }
        if (path === '/api/v1/session-groups/rename') {
          if (typeof body.id !== 'string' || typeof body.name !== 'string') {
            fail(res, 400, { code: 'web_schema_invalid', message: 'id and name are required' })
            return
          }
          ok(res, { group: await sessionGroups.rename(body.id, body.name) })
          return
        }
        if (path === '/api/v1/session-groups/delete') {
          if (typeof body.id !== 'string') {
            fail(res, 400, { code: 'web_schema_invalid', message: 'id is required' })
            return
          }
          await sessionGroups.remove(body.id)
          ok(res, { deleted: true })
          return
        }
        if (path === '/api/v1/session-groups/assign') {
          const groupId = body.groupId
          if (
            typeof body.sessionId !== 'string' ||
            (groupId !== null && typeof groupId !== 'string')
          ) {
            fail(res, 400, {
              code: 'web_schema_invalid',
              message: 'sessionId is required and groupId must be a string or null',
            })
            return
          }
          await sessionGroups.assign(body.sessionId, groupId)
          ok(res, { assigned: true })
          return
        }
      } catch (cause) {
        failFrom(res, cause)
        return
      }
    }

    // ── 工作台（右侧栏）：工作区文件树/读取/写入、按名查找、内容搜索、git。
    // 路径安全（逃逸门/上限/跳过规则）全在 WorkbenchPort 内；这里只做参数形状校验。
    // 终端走 WebSocket（/api/v1/workbench/terminal/ws，见 server 'upgrade' 处理）。
    const workbench = options.workbench
    if (path.startsWith('/api/v1/workbench/')) {
      if (!workbench) {
        fail(res, 503, { code: 'web_capability_unavailable', message: 'workbench is not wired' })
        return
      }
      try {
        if (path === '/api/v1/workbench/fs/list' && req.method === 'GET') {
          const rel = url.searchParams.get('path') ?? ''
          ok(res, await workbench.listDir(rel))
          return
        }
        if (path === '/api/v1/workbench/fs/read' && req.method === 'GET') {
          const rel = url.searchParams.get('path') ?? ''
          if (!rel) {
            fail(res, 400, { code: 'web_schema_invalid', message: 'path is required' })
            return
          }
          ok(res, await workbench.readText(rel))
          return
        }
        if (path === '/api/v1/workbench/fs/write' && req.method === 'POST') {
          // 文件保存允许比常规 64 KiB 更大的 body（端口内仍卡 2 MiB）。
          const body = (await readJsonBody(req, MAX_WRITE_BODY_BYTES)) as
            | { path?: unknown; content?: unknown }
            | undefined
          if (typeof body?.path !== 'string' || typeof body.content !== 'string') {
            fail(res, 400, {
              code: 'web_schema_invalid',
              message: 'path and content are required',
            })
            return
          }
          ok(res, await workbench.writeText(body.path, body.content))
          return
        }
        if (path === '/api/v1/workbench/fs/find' && req.method === 'GET') {
          ok(res, await workbench.findFiles(url.searchParams.get('q') ?? ''))
          return
        }
        // ── 内嵌 vscode workbench 的 FileSystemProvider 后端（代码页）─────────
        if (path === '/api/v1/workbench/fs/stat' && req.method === 'GET') {
          ok(res, await workbench.stat(url.searchParams.get('path') ?? ''))
          return
        }
        if (path === '/api/v1/workbench/fs/read-bytes' && req.method === 'GET') {
          ok(res, await workbench.readBytes(url.searchParams.get('path') ?? ''))
          return
        }
        if (path === '/api/v1/workbench/fs/write-bytes' && req.method === 'POST') {
          const body = (await readJsonBody(req, MAX_WRITE_BODY_BYTES)) as
            | { path?: unknown; base64?: unknown }
            | undefined
          if (typeof body?.path !== 'string' || typeof body.base64 !== 'string') {
            fail(res, 400, { code: 'web_schema_invalid', message: 'path and base64 are required' })
            return
          }
          ok(res, await workbench.writeBytes(body.path, body.base64))
          return
        }
        if (path === '/api/v1/workbench/fs/mkdir' && req.method === 'POST') {
          const body = (await readJsonBody(req)) as { path?: unknown } | undefined
          if (typeof body?.path !== 'string') {
            fail(res, 400, { code: 'web_schema_invalid', message: 'path is required' })
            return
          }
          ok(res, await workbench.mkdir(body.path))
          return
        }
        if (path === '/api/v1/workbench/fs/delete' && req.method === 'POST') {
          const body = (await readJsonBody(req)) as
            | { path?: unknown; recursive?: unknown }
            | undefined
          if (typeof body?.path !== 'string') {
            fail(res, 400, { code: 'web_schema_invalid', message: 'path is required' })
            return
          }
          ok(res, await workbench.deletePath(body.path, body.recursive === true))
          return
        }
        if (path === '/api/v1/workbench/fs/rename' && req.method === 'POST') {
          const body = (await readJsonBody(req)) as { from?: unknown; to?: unknown } | undefined
          if (typeof body?.from !== 'string' || typeof body?.to !== 'string') {
            fail(res, 400, { code: 'web_schema_invalid', message: 'from and to are required' })
            return
          }
          ok(res, await workbench.rename(body.from, body.to))
          return
        }
        if (path === '/api/v1/workbench/search' && req.method === 'GET') {
          ok(res, await workbench.searchContent(url.searchParams.get('q') ?? ''))
          return
        }
        if (path === '/api/v1/workbench/git/status' && req.method === 'GET') {
          ok(res, await workbench.gitStatus())
          return
        }
        if (path === '/api/v1/workbench/git/diff' && req.method === 'GET') {
          const rel = url.searchParams.get('path')
          ok(res, await workbench.gitDiff(rel ?? undefined))
          return
        }
      } catch (cause) {
        failFrom(res, cause)
        return
      }
      fail(res, 404, {
        code: 'web_schema_invalid',
        message: `unknown endpoint: ${req.method} ${path}`,
      })
      return
    }

    // ── P3 会话生命周期（sessionHub 存在才开放；能力诚实降级）──────────────
    const hub = options.sessionHub
    if (hub && path === '/api/v1/sessions/active' && req.method === 'GET') {
      ok(res, { active: hub.active ?? null, pendingPermissions: hub.pendingPermissionIds() })
      return
    }
    if (hub && path === '/api/v1/sessions' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const cwd = (body as { cwd?: unknown })?.cwd
      if (typeof cwd !== 'string' || !cwd) {
        fail(res, 400, { code: 'web_schema_invalid', message: 'cwd is required' })
        return
      }
      try {
        ok(res, await hub.start({ cwd }))
      } catch (cause) {
        failFrom(res, cause)
      }
      return
    }
    if (hub && path === '/api/v1/sessions/resume' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const id = (body as { id?: unknown })?.id
      if (typeof id !== 'string' || !id) {
        fail(res, 400, { code: 'web_schema_invalid', message: 'id is required' })
        return
      }
      try {
        ok(res, await hub.resume(id))
      } catch (cause) {
        failFrom(res, cause)
      }
      return
    }
    if (hub && path === '/api/v1/sessions/active/transcript' && req.method === 'GET') {
      ok(res, hub.transcript())
      return
    }
    if (hub && path === '/api/v1/sessions/active/turns' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const prompt = (body as { prompt?: unknown })?.prompt
      const model = (body as { model?: unknown })?.model
      const attachments = parseSubmitAttachments((body as { attachments?: unknown })?.attachments)
      if (typeof prompt !== 'string' || !prompt.trim()) {
        fail(res, 400, { code: 'web_schema_invalid', message: 'prompt is required' })
        return
      }
      if (attachments === undefined) {
        fail(res, 400, { code: 'web_schema_invalid', message: 'attachments are malformed' })
        return
      }
      try {
        const accepted = await hub.submit({
          prompt,
          ...(typeof model === 'string' && model ? { model } : {}),
          ...(attachments.length ? { attachments } : {}),
        })
        res.writeHead(202, {
          ...SECURITY_HEADERS,
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(JSON.stringify({ data: { accepted } })),
        })
        res.end(JSON.stringify({ data: { accepted } }))
      } catch (cause) {
        failFrom(res, cause)
      }
      return
    }
    if (hub && path === '/api/v1/sessions/active/interrupt' && req.method === 'POST') {
      await hub.interrupt()
      ok(res, { interrupted: true })
      return
    }
    if (hub && path === '/api/v1/sessions/active/end' && req.method === 'POST') {
      await hub.closeActive()
      ok(res, { ended: true })
      return
    }
    // ── W-08 变更/undo（preview → 确认 → 执行的 destructive 门）────────────
    if (
      options.changes &&
      hub &&
      path === '/api/v1/sessions/active/changes' &&
      req.method === 'GET'
    ) {
      const activeId = hub.active?.id
      if (!activeId) {
        fail(res, 409, { code: 'web_session_invalid', message: 'no active session' })
        return
      }
      try {
        const changes = (await options.changes.list(activeId)) as Record<string, unknown>
        ok(res, { sessionId: activeId, ...changes })
      } catch (cause) {
        failFrom(res, cause)
      }
      return
    }
    if (
      options.changes &&
      hub &&
      path === '/api/v1/sessions/active/undo/preview' &&
      req.method === 'GET'
    ) {
      const activeId = hub.active?.id
      if (!activeId) {
        fail(res, 409, { code: 'web_session_invalid', message: 'no active session' })
        return
      }
      try {
        ok(res, await options.changes.previewUndo(activeId))
      } catch (cause) {
        failFrom(res, cause)
      }
      return
    }
    if (
      options.changes &&
      hub &&
      path === '/api/v1/sessions/active/undo' &&
      req.method === 'POST'
    ) {
      const activeId = hub.active?.id
      if (!activeId) {
        fail(res, 409, { code: 'web_session_invalid', message: 'no active session' })
        return
      }
      try {
        ok(res, await options.changes.undoStep(activeId))
      } catch (cause) {
        failFrom(res, cause)
      }
      return
    }
    // ── W-05 附件上传（图片字节 → AttachmentStore 暂存 → handle 引用）─────────
    if (hub && path === '/api/v1/sessions/active/attachments' && req.method === 'POST') {
      const mime = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
      if (!ATTACHMENT_MIMES.has(mime)) {
        fail(res, 400, {
          code: 'web_attachment_rejected',
          message: `unsupported attachment type: ${mime || '<missing>'}`,
        })
        return
      }
      const bytes = await readRawBody(req, MAX_ATTACHMENT_BYTES)
      if (bytes === undefined) {
        fail(res, 400, { code: 'web_attachment_rejected', message: 'empty attachment body' })
        return
      }
      if (bytes === 'too-large') {
        fail(res, 413, {
          code: 'web_attachment_rejected',
          message: `attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`,
        })
        return
      }
      try {
        ok(res, await hub.stageAttachment(bytes, mime))
      } catch (cause) {
        failFrom(res, cause)
      }
      return
    }
    if (hub && path === '/api/v1/permissions/decide' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const requestId = (body as { requestId?: unknown })?.requestId
      const kind = (body as { kind?: unknown })?.kind
      if (typeof requestId !== 'string' || typeof kind !== 'string') {
        fail(res, 400, { code: 'web_schema_invalid', message: 'requestId and kind are required' })
        return
      }
      ok(res, { decided: hub.decide(requestId, kind) })
      return
    }

    // ── P4 管理域（GET inventory + POST tagged-union action；§22.8.2）──────
    const mgmt = options.management
    if (mgmt && path.startsWith('/api/v1/') && path.endsWith('/actions')) {
      const raw = path.slice('/api/v1/'.length, -'/actions'.length)
      // 规范别名：§22.8.2 的复数路径 → 域单数键。
      const domain = raw === 'skills' ? 'skill' : raw
      const tables: Record<
        string,
        Record<string, (body: Record<string, unknown>) => Promise<unknown>>
      > = {}
      if (mgmt.memory) {
        tables.memory = {
          list: async (body) => ({
            scopeLabel: mgmt.memory!.scopeLabel,
            searchAvailable: mgmt.memory!.searchAvailable,
            items: await mgmt.memory!.list({
              limit: typeof body.limit === 'number' ? body.limit : 50,
            }),
          }),
          search: async (body) =>
            mgmt.memory!.search({
              query: String(body.query ?? ''),
              limit: typeof body.limit === 'number' ? body.limit : 20,
            }),
          get: async (body) => await mgmt.memory!.get(String(body.id)),
          delete: async (body) =>
            await mgmt.memory!.delete(String(body.id), String(body.expectedUpdatedAt ?? '')),
          pin: async (body) =>
            await mgmt.memory!.pin(String(body.id), String(body.expectedUpdatedAt ?? '')),
          unpin: async (body) =>
            await mgmt.memory!.unpin(String(body.id), String(body.expectedUpdatedAt ?? '')),
        }
      }
      if (mgmt.skill) {
        tables.skill = {
          list: async () => ({ items: await mgmt.skill!.list() }),
          show: async (body) => ({ body: await mgmt.skill!.show(String(body.name)) }),
          setEnabled: async (body) => {
            await mgmt.skill!.setEnabled(String(body.name), body.enabled === true)
            return { ok: true }
          },
        }
      }
      if (mgmt.mcp) {
        tables.mcp = {
          list: async () => ({ items: await mgmt.mcp!.list() }),
          inspect: async (body) => await mgmt.mcp!.inspect(String(body.name)),
          setEnabled: async (body) => {
            await mgmt.mcp!.setEnabled(String(body.name), body.enabled === true)
            return { ok: true }
          },
        }
      }
      if (mgmt.plugins) {
        tables.plugins = {
          list: async () => ({ items: await mgmt.plugins!.builtinDomains() }),
          domains: async () => ({ items: await mgmt.plugins!.builtinDomains() }),
          setDomain: async (body) => {
            await mgmt.plugins!.setBuiltinDomain(String(body.id), body.enabled === true)
            return { ok: true }
          },
          availability: async () => await mgmt.plugins!.availability(),
        }
      }
      if (mgmt.telemetry) {
        tables.telemetry = {
          list: async () => ({
            summary: await mgmt.telemetry!.summary(),
            health: await mgmt.telemetry!.health(),
          }),
          summary: async () => await mgmt.telemetry!.summary(),
          health: async () => await mgmt.telemetry!.health(),
          events: async (body) =>
            (await (
              mgmt.telemetry as unknown as { events?: (limit: number) => Promise<unknown> }
            ).events?.(typeof body.limit === 'number' ? body.limit : 200)) ?? {
              events: [],
              corruptLines: 0,
              total: 0,
            },
        }
      }
      const table = tables[domain]
      if (!table) {
        fail(res, 404, { code: 'web_capability_unavailable', message: `unknown domain: ${domain}` })
        return
      }
      if (req.method === 'GET') {
        const listAll = table['list']
        if (!listAll) {
          fail(res, 503, { code: 'web_capability_unavailable', message: `${domain} is not wired` })
          return
        }
        ok(res, await listAll({}))
        return
      }
      if (!mgmtSupports(options.management!, domain)) {
        fail(res, 503, { code: 'web_capability_unavailable', message: `${domain} is not wired` })
        return
      }
      const body = await readJsonBody(req)
      if (body === undefined || typeof body !== 'object') {
        fail(res, 400, { code: 'web_schema_invalid', message: 'invalid JSON body' })
        return
      }
      try {
        ok(res, await actionDispatcher(table)(body as Record<string, unknown>))
      } catch (cause) {
        failFrom(res, cause)
      }
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
      // P3：订阅会话枢纽（core/view 信封透传）；hub 未装配时只有心跳。
      const unsubscribe =
        options.sessionHub?.subscribe((envelope) => {
          if (client.queue.length >= SSE_MAX_QUEUE) {
            client.res.end()
            sseClients.delete(client)
            return
          }
          const channel = envelope.kind === 'control' ? 'control' : envelope.kind
          client.res.write(`event: ${channel}\ndata: ${JSON.stringify(envelope)}\n\n`)
        }) ?? (() => {})
      req.on('close', () => {
        unsubscribe()
        sseClients.delete(client)
      })
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
      // 带扩展名的资源缺失必须 404——回退成 index.html 会让 <script> 拿到
      // text/html 被 nosniff/MIME 拦截，表现为白屏（升级后旧哈希资产即此情形）。
      if (extname(rel)) {
        fail(res, 404, { code: 'web_schema_invalid', message: 'not found' })
        return
      }
      // SPA 路由回退到 index.html（客户端路由）；no-store——index 引用的资产带
      // 内容哈希，缓存住 index 等于钉死旧版本。
      const indexFile = join(staticDir, 'index.html')
      if (!existsSync(indexFile)) {
        fail(res, 404, { code: 'web_schema_invalid', message: 'not found' })
        return
      }
      {
        const nonce = randomBytes(12).toString('base64url')
        res.writeHead(200, {
          ...securityHeadersWithNonce(nonce),
          'Content-Type': MIME['.html']!,
          'Cache-Control': 'no-store',
        })
        res.end(htmlWithCspNonce(await readFile(indexFile, 'utf8'), nonce))
      }
      return
    }
    // HTML（Next 导出的页面）同样需要 per-request CSP nonce。
    if (extname(file) === '.html') {
      const nonce = randomBytes(12).toString('base64url')
      res.writeHead(200, {
        ...securityHeadersWithNonce(nonce),
        'Content-Type': MIME['.html']!,
        'Cache-Control': 'no-store',
      })
      res.end(htmlWithCspNonce(await readFile(file, 'utf8'), nonce))
      return
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      // vite 产物带内容哈希：长缓存安全；index.html 自身永不远缓存。
      'Cache-Control': 'public, max-age=31536000, immutable',
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

  // ── 工作台终端：WebSocket 交互式 shell（浏览器 WS 握手带不了自定义头——
  // CSWSH 门 = Host/Origin 精确匹配 + session cookie，与 HTTP mutation 同模型）。
  // JSON 文本帧：⇦ {type:'in',data}|{type:'resize',cols,rows}；⇨ {type:'out',data}|{type:'exit',code}。
  const terminal = options.terminal
  server.on('upgrade', (req, socket, head) => {
    const reject = (status: number) => {
      socket.write(`HTTP/1.1 ${status} Forbidden\r\nConnection: close\r\n\r\n`)
      socket.destroy()
    }
    const hostHeader = req.headers.host ?? ''
    const url = new URL(req.url ?? '/', `http://${hostHeader || 'localhost'}`)
    if (
      url.pathname !== '/api/v1/workbench/terminal/ws' ||
      !terminal ||
      hostHeader !== expectedOriginHost(boundPort) ||
      req.headers.origin !== `http://${hostHeader}` ||
      !findSession(req) ||
      !acceptWebSocket(req, socket)
    ) {
      reject(403)
      return
    }
    const conn = new WsConnection(socket, { pingIntervalMs: 30_000 })
    const shellSession = terminal.spawnShell()
    shellSession.onData((data) => conn.send(JSON.stringify({ type: 'out', data })))
    shellSession.onExit((code) => {
      conn.send(JSON.stringify({ type: 'exit', code }))
      conn.close()
    })
    conn.onMessage = (text) => {
      try {
        const msg = JSON.parse(text) as {
          type?: unknown
          data?: unknown
          cols?: unknown
          rows?: unknown
        }
        if (msg.type === 'in' && typeof msg.data === 'string') shellSession.write(msg.data)
        else if (
          msg.type === 'resize' &&
          typeof msg.cols === 'number' &&
          typeof msg.rows === 'number'
        )
          shellSession.resize(msg.cols, msg.rows)
      } catch {
        // 非 JSON 帧忽略（协议面之外的输入不致命）
      }
    }
    conn.onClose = () => shellSession.kill()
  })

  const hostForUrl = options.host === '::1' ? '[::1]' : options.host
  const url = `http://${hostForUrl}:${boundPort}/`
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

/** 有界 JSON body 读取（默认 64 KiB 上限；超限/非 JSON → undefined）。 */
async function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
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

/** 有界二进制 body 读取（附件上传）；空 body → undefined，超限 → 'too-large'。 */
async function readRawBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Uint8Array | 'too-large' | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) return 'too-large'
    chunks.push(buffer)
  }
  if (size === 0) return undefined
  return new Uint8Array(Buffer.concat(chunks))
}

/** turns body 的 attachments 字段校验：形状不符 → undefined（400）；缺省 → []。 */
function parseSubmitAttachments(value: unknown): SubmitAttachment[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const out: SubmitAttachment[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined
    const candidate = item as Record<string, unknown>
    if (candidate.kind !== 'image' && candidate.kind !== 'file') return undefined
    if (typeof candidate.mime !== 'string' || typeof candidate.chip !== 'string') return undefined
    if (typeof candidate.size !== 'number' || !Number.isFinite(candidate.size)) return undefined
    if (candidate.handle !== undefined && typeof candidate.handle !== 'string') return undefined
    if (candidate.path !== undefined && typeof candidate.path !== 'string') return undefined
    out.push({
      kind: candidate.kind,
      mime: candidate.mime,
      chip: candidate.chip,
      size: candidate.size,
      ...(typeof candidate.handle === 'string' ? { handle: candidate.handle } : {}),
      ...(typeof candidate.path === 'string' ? { path: candidate.path } : {}),
    })
  }
  return out
}
