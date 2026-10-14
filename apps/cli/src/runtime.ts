import { readFileSync } from 'node:fs'
import { access, appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { connect as http2Connect, constants as http2Constants } from 'node:http2'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect, isIP, type Socket as NetSocket } from 'node:net'
import { homedir } from 'node:os'
import { delimiter as pathDelimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { checkServerIdentity as tlsCheckServerIdentity, connect as tlsConnect } from 'node:tls'

import {
  createAppKernel,
  createProductionToolPermissionChain,
  createSessionKernel,
  collectPluginSkillDirs,
  createAuthDomain,
  readAuthSection,
  createConfigDomain,
  createMcpDomain,
  createMcpFatigueGuard,
  loadMcpServerConfigs,
  createNativeDomain,
  createPluginDomain,
  broadcastPluginLifecycleHook,
  createPluginHookDispatcher,
  escapeUntrustedText,
  languagePromptFragment,
  loadProductionContextTuning,
  resolveBuiltinPluginRoot,
  resolveModelAlias,
  createMemoryStack,
  consolidateSessionMemory,
  createPluginMemoryHost,
  createSkillDomain,
  registerRuntimeMemoryPrompts,
  createStatusSnapshotAdapter,
  AskPromptController,
  createAskUserInteraction,
  DEFAULT_PROMPT_TIMEOUT_MS,
  PermissionPromptController,
  ProductionPermissionSessionPolicy,
  SessionController,
  projectMemoryScope,
  sessionMemoryScope,
  workspaceMemoryScope,
} from '@volund/app-runtime'
import type { MemoryConsolidationModel } from '@volund/app-runtime'
import type { RunnerFactory } from '@volund/app-runtime'
import { AuthManager, EncryptedCredentialStore } from '@volund/auth'
import { SummaryPolicy } from '@volund/context'
import {
  builtinPromptFragment,
  DefaultPromptComposer,
  lineageRootSessionId,
  Runner,
} from '@volund/core'
import type { RunnerToolPort, SessionState } from '@volund/core'
import { SandboxService, ToolsService } from '@volund/kernel'
import { countTokens, execSandbox, probeSandbox } from '@volund/native-bridge'
import type { SandboxTier } from '@volund/native-bridge'
import type { PermissionSessionMode, PermissionSpec } from '@volund/permission'
import {} from '@volund/plugin-runtime'
import type {} from '@volund/plugin-runtime'
import type { HookPipelineSignal } from '@volund/plugin-runtime'
import { AnthropicClient, verifyAnthropicCredential } from '@volund/provider-anthropic'
import type { HttpPort, HttpRequest, HttpResponse } from '@volund/provider-anthropic'
import { GeminiClient } from '@volund/provider-gemini'
import { OllamaClient, isLoopbackOllamaEndpoint } from '@volund/provider-ollama'
import { OpenAIClient } from '@volund/provider-openai'
import {
  FallbackRouter,
  parseRoleRouterConfig,
  RoleRouter,
  SingleProviderRouter,
} from '@volund/router'
import type { RouterPolicy } from '@volund/router'
import { sanitize, VolundError, type JsonValue, type Locale } from '@volund/shared'
import { SkillsRuntime, defaultSkillSources } from '@volund/skills-runtime'
import {
  AttachmentStore,
  BackupStore,
  EvolutionStore,
  PromptLoader,
  SessionStore,
} from '@volund/storage'
import { AgentDefinitionRegistry, SubagentDispatcher, untrustedAgentBody } from '@volund/subagent'
import { LocalTelemetrySink, Telemetry, TelemetryLogger, TelemetryStore } from '@volund/telemetry'
import type { NativeBridge } from '@volund/tool-kit'
import {
  BackgroundShells,
  builtinToolDomains,
  ASK_USER_QUESTION_TOOL_NAME,
  createAskUserQuestionTool,
  WebSearchTool,
} from '@volund/tools'
import {
  renderDirectoryTrustPrompt,
  renderInteractiveApp,
  renderSessionPicker,
  MutableSlashCommandRegistry,
} from '@volund/ui'
import type {
  InteractivePermissionDecision,
  InteractivePermissionRequest,
  StatusViewModel,
  McpPanelController,
  SubagentsPanelController,
  SkillsPanelController,
} from '@volund/ui'

import { readConfigFileOrEmpty } from './config-edit'
import { readDaemonStatus } from './daemon'
import { createHistoryPort } from './history'
import { createMemoryTools } from './memory-tools'
import { PermissionRuleStore } from './permissions-store'
import type { VolundPorts } from './ports'
import { createRemoteControlPort } from './remote'
import { createScheduleTaskTool } from './schedule-task-tool'
import type { AppIdentity } from './shared/app-identity'
import { createSkillTool, SKILL_TOOL_NAME } from './skill-tool'
import { DirectoryTrustStore } from './trust'
import { createWebPort } from './web'

// P1-04 兼容适配：以下符号已迁至 @volund/app-runtime；既有测试与消费方经此再导出，
// 新代码一律直接从 app-runtime 导入。
export {
  broadcastPluginLifecycleHook,
  collectPluginSkillDirs,
  composeAttachmentInput,
  createPluginHookDispatcher,
  expandEnvValue,
  languagePromptFragment,
  loadProductionContextTuning,
  readEffectiveEnv,
  listWorkspaceFiles,
  registerPluginCommands,
  resolveModelAlias,
} from '@volund/app-runtime'

/**
 * 内置插件根目录（随产物分发的 apps/cli/plugins/<name>/）：位置锚点必须留在
 * CLI 包（import.meta.url），位置无关的解析内核在 app-runtime（P1-04d）。
 */
export function builtinPluginRoot(): string | undefined {
  return resolveBuiltinPluginRoot({
    importMetaUrl: import.meta.url,
    execPath: process.execPath,
    envAssetDir: process.env.VOLUND_STANDALONE_ASSET_DIR,
  })
}

const historySecretPattern =
  /\b(?:authorization|api[_-]?key|token|secret|passphrase|password|oauth[_-]?code|anthropic[_-]?api[_-]?key|openai[_-]?api[_-]?key)\b/i
export interface HookSignalRuntimeMapping {
  error?: { code: string; context: Record<string, JsonValue> }
  warning?: string
  telemetry?: { name: string; payload: Record<string, JsonValue> }
}

const unreachableHookSignal = (signal: never): never => {
  void signal
  throw new TypeError('unhandled hook pipeline signal')
}

/** Pure, exhaustive adapter from plugin-runtime hook signals to CLI observability. */
export function mapHookPipelineSignal(signal: HookPipelineSignal): HookSignalRuntimeMapping {
  switch (signal.kind) {
    case 'builtin_hook_timeout':
    case 'builtin_hook_error':
      return {
        error: { code: signal.code, context: { hook: signal.hook, event: signal.event } },
      }
    case 'hook_skipped':
      return {
        warning: `Hook skipped (${signal.domain} ${signal.hook} on ${signal.event}, ${signal.cause}): ${signal.message}`,
        telemetry: {
          name: 'hook.skipped',
          payload: {
            domain: signal.domain,
            hook: signal.hook,
            event: signal.event,
            cause: signal.cause,
          },
        },
      }
    case 'builtin_hook_payload_too_large': {
      const evidence = {
        domain: signal.domain,
        hook: signal.hook,
        event: signal.event,
        limitBytes: signal.limitBytes,
        rawBytes: signal.rawBytes,
        rawDigest: signal.rawDigest,
        scanStatus: signal.scanStatus,
        scannedBytes: signal.scannedBytes,
        scannedDigest: signal.scannedDigest,
        decision: signal.decision,
      } satisfies Record<string, JsonValue>
      return {
        error: { code: signal.code, context: evidence },
        warning: `Builtin hook payload rejected for ${signal.hook} on ${signal.event}: ${signal.rawBytes} bytes exceeds ${signal.limitBytes}`,
        telemetry: { name: 'hook.payload_rejected', payload: evidence },
      }
    }
    default:
      return unreachableHookSignal(signal)
  }
}

/** 粘贴文件路径的 MIME 猜测；未识别按 octet-stream（provider 不支持时降级为文本）。 */

/**
 * resume transcript 的全保真提取：markdown 的块级结构（标题/列表/表格/代码块）
 * 全靠换行界定，折叠空白会把整段塌成一行流水文本。
 * §7.5.2：image/file part 渲染回 chip 文本，resume 后用户消息仍可见附件占位。
 */
export class FileInputHistoryStore {
  constructor(
    readonly path: string,
    readonly maxBytes = 1024 * 1024,
    readonly maxEntries = 1000,
    readonly maxInputBytes = 8 * 1024,
  ) {}

  async append(input: string): Promise<void> {
    const value = input.trim()
    if (!this.storeable(value)) return
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await appendFile(
      this.path,
      `${JSON.stringify({ at: new Date().toISOString(), input: value })}\n`,
      { mode: 0o600 },
    )
    await this.compact()
  }

  async list(): Promise<readonly string[]> {
    return (await this.records()).map((record) => record.input)
  }

  private storeable(input: string): boolean {
    if (!input) return false
    if (Buffer.byteLength(input, 'utf8') > this.maxInputBytes) return false
    if (historySecretPattern.test(input)) return false
    return sanitize(input) === input
  }

  private async compact(): Promise<void> {
    let records = (await this.records()).slice(-this.maxEntries)
    let serialized = serializeHistory(records)
    while (records.length > 0 && Buffer.byteLength(serialized, 'utf8') > this.maxBytes) {
      records = records.slice(1)
      serialized = serializeHistory(records)
    }
    const temp = `${this.path}.${process.pid}.tmp`
    await writeFile(temp, serialized, { mode: 0o600 })
    await rename(temp, this.path)
  }

  private async records(): Promise<Array<{ at: string; input: string }>> {
    try {
      const text = await readFile(this.path, 'utf8')
      return text
        .split('\n')
        .flatMap((line) => {
          if (!line) return []
          try {
            const record = JSON.parse(line) as { at?: unknown; input?: unknown }
            if (typeof record.input !== 'string') return []
            return [{ at: typeof record.at === 'string' ? record.at : '', input: record.input }]
          } catch {
            return []
          }
        })
        .filter((record) => this.storeable(record.input))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
}

function serializeHistory(records: readonly { at: string; input: string }[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '')
}

// ── 抓包代理支持 ──────────────────────────────────────────────────────────
// NodeHttpPort 读 HTTPS_PROXY / HTTP_PROXY / NO_PROXY，通过 HTTP CONNECT 隧道转发
// 请求，使 mitmproxy / Charles / Whistle 等抓包工具可在本地拦截出站流量。
// 隧道对上层透明：h1 走 createConnection 注入，h2 走 net→tls 套接字。
// env 运行期读取（非模块级常量），使测试可按用例注入 / 覆盖。
function resolveProxyUrl(target: URL): string | undefined {
  const byProtocol =
    target.protocol === 'https:' || target.protocol === 'wss:'
      ? (process.env.HTTPS_PROXY ?? process.env.https_proxy)
      : (process.env.HTTP_PROXY ?? process.env.http_proxy)
  if (!byProtocol) return undefined
  if (shouldBypassProxy(target)) return undefined
  return byProtocol
}
function shouldBypassProxy(target: URL): boolean {
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy
  if (noProxy === undefined) return false
  if (noProxy === '' || noProxy === '*') return true
  const host = target.hostname.toLowerCase()
  for (const entry of noProxy.split(',').map((s) => s.trim().toLowerCase())) {
    if (!entry) continue
    if (entry === host || host.endsWith(`.${entry}`)) return true
  }
  return false
}

// 抓包代理（mitmproxy/Charles/Whistle）拦截 HTTPS 时用自签 CA 重新签名流量，
// 系统信任库不含该 CA → tlsConnect 握手报 "unable to verify the first certificate"。
// 解法：读 NODE_EXTRA_CA_CERTS 追加信任链，NODE_TLS_REJECT_UNAUTHORIZED=0 时完全跳过验证。
// Node 原生 https/http2 自动处理这两项，但代理路径手动 tlsConnect 需显式传入。
// 缓存解析结果，避免每个请求都重新读文件。
let cachedTlsOpts: { rejectUnauthorized: boolean; ca: Buffer[] | undefined } | undefined
function proxyTlsOptions(servername: string): {
  rejectUnauthorized: boolean
  ca: Buffer[] | undefined
  servername?: string
  checkServerIdentity?: (
    hostname: string,
    cert: import('node:tls').PeerCertificate,
  ) => Error | undefined
  ALPNProtocols?: string[]
} {
  if (!cachedTlsOpts) {
    const rejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0'
    let ca: Buffer[] | undefined
    const extraCa = process.env.NODE_EXTRA_CA_CERTS
    if (extraCa) {
      ca = []
      for (const p of extraCa
        .split(pathDelimiter)
        .map((s) => s.trim())
        .filter(Boolean)) {
        try {
          ca.push(readFileSync(p))
        } catch {
          // 路径不存在或不可读时跳过——行为与 Node 原生一致
        }
      }
      if (ca.length === 0) ca = undefined
    }
    cachedTlsOpts = { rejectUnauthorized, ca }
  }
  // Node ≥23 起 tls.connect 的 servername 传 IP 字面量直接抛 ERR_INVALID_ARG_VALUE
  //（此前静默忽略）——IP 目标本就无 SNI 语义，改经 checkServerIdentity 显式按该 IP
  // 校验证书 SAN（校验语义不变：不匹配仍拒握手）。域名目标维持 servername/SNI 原路径。
  if (isIP(servername))
    return {
      ...cachedTlsOpts,
      checkServerIdentity: (_hostname, cert) => tlsCheckServerIdentity(servername, cert),
    }
  return { ...cachedTlsOpts, servername }
}
// 测试用：清除缓存使环境变量变更生效。
export function resetProxyTlsCache(): void {
  cachedTlsOpts = undefined
}

// 建立 CONNECT 隧道，返回可用于 https.request / http2.connect 的裸套接字。
async function openProxyTunnel(
  proxyUrl: string,
  target: URL,
  signal: AbortSignal,
): Promise<NetSocket> {
  const proxy = new URL(proxyUrl)
  const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80')
  const socket = netConnect({
    host: proxy.hostname,
    port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)),
  })
  if (signal.aborted) {
    socket.destroy()
    throw new VolundError('proxy_tunnel_aborted', 'proxy_tunnel_aborted')
  }
  const onAbort = () => socket.destroy()
  signal.addEventListener('abort', onAbort, { once: true })
  await new Promise<void>((resolve, reject) => {
    let settled = false
    socket.once('connect', () => {
      if (settled) return
      socket.write(
        `CONNECT ${target.hostname}:${targetPort} HTTP/1.1\r\nHost: ${target.hostname}:${targetPort}\r\n\r\n`,
      )
      let buf = ''
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString('ascii')
        const idx = buf.indexOf('\r\n\r\n')
        if (idx === -1) return
        socket.off('data', onData)
        const statusLine = buf.slice(0, buf.indexOf('\r\n'))
        if (/^HTTP\/1\.[01] 2\d\d /.test(statusLine)) {
          settled = true
          resolve()
        } else {
          settled = true
          socket.destroy()
          reject(new VolundError('proxy_tunnel_rejected', `${statusLine}`))
        }
      }
      socket.on('data', onData)
    })
    socket.once('error', (cause) => {
      if (settled) return
      settled = true
      reject(new VolundError('proxy_tunnel_failed', `${cause.message}`))
    })
    // abort 走 destroy（无 error 事件）——close 先于 settled 到达时也要拒给上层，
    // 否则隧道中途被中断会让 openProxyTunnel 的 await 永久悬挂。
    socket.once('close', () => {
      if (settled) return
      settled = true
      reject(new VolundError('proxy_tunnel_closed', 'proxy_tunnel_closed'))
    })
  }).finally(() => {
    signal.removeEventListener('abort', onAbort)
  })
  return socket
}

function requestHttp1(url: URL, input: HttpRequest): Promise<HttpResponse> {
  // §4.6 强制路由：provider.anthropic.baseUrl 可能指向 http:// 网关（本地代理/自建网关，
  // 见 851f62e），按协议在 node:http / node:https 间分流，与 web-fetch.ts 范式一致。
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
  const proxyUrl = resolveProxyUrl(url)
  const baseOpts: import('node:https').RequestOptions = {
    method: input.method,
    headers: input.headers,
    signal: input.signal,
  }
  function handler(
    response: import('node:http').IncomingMessage,
    onAbort: () => void,
    resolve: (v: HttpResponse) => void,
  ): void {
    input.signal.removeEventListener('abort', onAbort)
    const headers = Object.fromEntries(
      Object.entries(response.headers).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, Array.isArray(value) ? value.join(',') : value]],
      ),
    )
    resolve({ status: response.statusCode ?? 0, headers, body: response })
  }
  // 无代理：原路径，直接 transport(url, opts, cb)。
  if (!proxyUrl) {
    return new Promise((resolve, reject) => {
      let reqRef: import('node:http').ClientRequest | undefined
      const onAbort = (): void => {
        reqRef?.destroy()
      }
      input.signal.addEventListener('abort', onAbort, { once: true })
      const req = transport(url, baseOpts, (response) => {
        handler(response, onAbort, resolve)
      })
      reqRef = req
      req.once('error', (cause) => {
        input.signal.removeEventListener('abort', onAbort)
        reject(cause)
      })
      req.end(input.method === 'GET' ? undefined : JSON.stringify(input.body))
    })
  }
  // CONNECT 隧道：先开裸 TCP 到代理，握手成功后注入 createConnection。
  // https:// → tlsConnect 在裸隧道上握手，返回已加密 socket；用 http.request
  //   （非 https.request）在已加密 socket 上发明文 HTTP——https.request 会在
  //   createConnection 返回的 socket 上再做一次 TLS（双重加密）。
  // http:// → 裸隧道 socket 直接喂 http.request 的 createConnection。
  // 两条路径都走 Node 原生 HTTP 解析器，支持流式 SSE / chunked。
  return openProxyTunnel(proxyUrl, url, input.signal).then(
    (socket) =>
      new Promise<HttpResponse>((resolve, reject) => {
        const onAbort = (): void => {
          socket.destroy()
        }
        input.signal.addEventListener('abort', onAbort, { once: true })
        const establishSocket =
          url.protocol === 'https:'
            ? new Promise<NetSocket>((res, rej) => {
                const tlsSock = tlsConnect({
                  socket,
                  ...proxyTlsOptions(url.hostname),
                })
                tlsSock.once('secureConnect', () => res(tlsSock as unknown as NetSocket))
                tlsSock.once('error', rej)
              })
            : Promise.resolve(socket)
        establishSocket
          .then((sock) => {
            // socket 已 TLS 包装时，用 http: 协议 URL（http.request 不认 https:），
            // createConnection 返回已加密 socket，HTTP 明文在 TLS 层上传输。
            const reqUrl =
              url.protocol === 'https:' ? `http://${url.host}${url.pathname}${url.search}` : url
            const req = httpRequest(
              reqUrl,
              {
                method: input.method,
                headers: input.headers,
                createConnection: () => sock,
              },
              (response) => {
                // 代理隧道响应完成后销毁 socket，释放代理连接（否则 server.close 挂起）。
                response.once('end', () => sock.destroy())
                handler(response, onAbort, resolve)
              },
            )
            req.once('error', (cause) => {
              input.signal.removeEventListener('abort', onAbort)
              reject(cause)
            })
            req.end(input.method === 'GET' ? undefined : JSON.stringify(input.body))
          })
          .catch((cause) => {
            // TLS 建立失败必须连隧道 socket 一起销毁——泄漏的 CONNECT 隧道会让
            // 对端代理的 server.close 永久等待（Node ≥23 的 IP servername 抛错
            // 路径即由此在测试里挂死）。
            socket.destroy()
            input.signal.removeEventListener('abort', onAbort)
            reject(cause)
          })
      }),
  )
}

const { HTTP2_HEADER_METHOD, HTTP2_HEADER_PATH, HTTP2_HEADER_STATUS, NGHTTP2_CANCEL } =
  http2Constants

// https:// 走 HTTP/2：企业网关（AWS ALB + APISIX）对 HTTP/1.1 的 SSE 整批缓冲、
// 对 HTTP/2 逐帧下发（实测同请求 h1 单 blob vs h2 渐进 2s+），h1 下 TUI 无流式效果。
// 代理模式：先 CONNECT 隧道到目标，再在 TLS 套接字上建立 h2 会话（createConnection 注入）。
export function requestHttp2(url: URL, input: HttpRequest): Promise<HttpResponse> {
  const proxyUrl = resolveProxyUrl(url)
  return new Promise((resolve, reject) => {
    let responded = false
    const establish = proxyUrl
      ? openProxyTunnel(proxyUrl, url, input.signal).then(async (tunneled) => {
          // ALPN 列 h2 优先、http/1.1 兜底：抓包代理（mitmproxy/Charles）通常只讲 h1，
          // h2 协商失败时 NodeHttpPort.request 回退 requestHttp1，仍经同一隧道。
          try {
            const tlsSocket = tlsConnect({
              socket: tunneled,
              ...proxyTlsOptions(url.hostname),
              ALPNProtocols: ['h2', 'http/1.1'],
            })
            return await new Promise<NetSocket>((res, rej) => {
              tlsSocket.once('secureConnect', () => {
                // ALPN 未选 h2 → 目标/代理只讲 h1，立即拒绝让上层回退 requestHttp1。
                // 必须销毁 tlsSocket + 底层隧道 socket，否则代理连接不释放、close() 挂起。
                if ((tlsSocket.alpnProtocol ?? 'http/1.1') !== 'h2') {
                  tlsSocket.destroy()
                  tunneled.destroy()
                  rej(new VolundError('proxy_alpn_not_h2', 'proxy_alpn_not_h2'))
                  return
                }
                res(tlsSocket)
              })
              tlsSocket.once('error', (cause) => rej(cause))
            })
          } catch (cause) {
            // 握手失败（含 tlsConnect 同步抛错）连隧道 socket 一起销毁——泄漏的
            // CONNECT 隧道会让对端代理的 server.close 永久等待。
            tunneled.destroy()
            throw cause
          }
        })
      : Promise.resolve(undefined)
    establish
      .then((tunneledSocket) => {
        const session = tunneledSocket
          ? http2Connect(url.origin, { createConnection: () => tunneledSocket })
          : http2Connect(url.origin)
        session.once('error', (cause) => {
          if (!responded) {
            session.destroy()
            reject(cause)
          }
        })
        const stream = session.request({
          [HTTP2_HEADER_METHOD]: input.method,
          [HTTP2_HEADER_PATH]: `${url.pathname}${url.search}`,
          // http2 禁传连接级 header；:authority 由 session 权威值自动生成。
          ...Object.fromEntries(
            Object.entries(input.headers).filter(
              ([key]) => !H2_FORBIDDEN_HEADERS.has(key.toLowerCase()),
            ),
          ),
        })
        const onAbort = () => stream.close(NGHTTP2_CANCEL)
        if (input.signal.aborted) onAbort()
        else input.signal.addEventListener('abort', onAbort, { once: true })
        stream.once('error', (cause) => {
          if (!responded) {
            responded = true
            input.signal.removeEventListener('abort', onAbort)
            session.destroy()
            reject(cause)
          }
        })
        stream.once('response', (headers) => {
          responded = true
          const flat: Record<string, string> = {}
          for (const [key, value] of Object.entries(headers)) {
            if (key.startsWith(':') || value === undefined) continue
            flat[key] = Array.isArray(value) ? value.join(',') : value
          }
          const body = (async function* () {
            try {
              for await (const chunk of stream) yield Buffer.from(chunk)
            } finally {
              input.signal.removeEventListener('abort', onAbort)
              session.close()
            }
          })()
          resolve({
            status: Number(headers[HTTP2_HEADER_STATUS] ?? 0),
            headers: flat,
            body,
          })
        })
        stream.end(input.method === 'GET' ? undefined : JSON.stringify(input.body))
      })
      .catch(reject)
  })
}
const H2_FORBIDDEN_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'host',
])

export class NodeHttpPort implements HttpPort {
  async request(input: HttpRequest): Promise<HttpResponse> {
    const url = new URL(input.url)
    if (url.protocol !== 'https:') return requestHttp1(url, input)
    try {
      return await requestHttp2(url, input)
    } catch (cause) {
      // h2 协商失败（ALPN 未选 h2 / 对端不支持）→ 回退 HTTP/1.1：功能正确性优先于流式。
      // 只发生在收到响应头之前（requestHttp2 此后只 resolve 不 reject），重发 POST 安全。
      // 调用方主动 abort 不在此列——原样抛出。
      if (input.signal.aborted) throw cause
      return requestHttp1(url, input)
    }
  }
}

async function promptLine(question: string): Promise<string> {
  return (await promptLineMaybe(question)) ?? ''
}
function isInteractiveTerminal(): boolean {
  return stdin.isTTY && stdout.isTTY
}
async function promptLineMaybe(question: string): Promise<string | undefined> {
  if (!isInteractiveTerminal()) return undefined
  const io = createInterface({ input: stdin, output: stdout })
  try {
    return await io.question(question)
  } catch {
    return undefined
  } finally {
    io.close()
  }
}
async function promptSecret(question: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode) return ''
  stdout.write(question)
  stdin.setRawMode(true)
  stdin.resume()
  return new Promise((resolve, reject) => {
    let value = ''
    const finish = (error?: Error) => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      stdout.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3)
          return finish(
            new VolundError('credential_input_cancelled', 'Credential input was cancelled'),
          )
        if (byte === 13 || byte === 10) return finish()
        if (byte === 8 || byte === 127) value = value.slice(0, -1)
        else if (byte >= 32) value += String.fromCharCode(byte)
      }
    }
    stdin.on('data', onData)
  })
}
/**
 * [models.aliases] 解析（§8.3）：preferences.model / 面板里可以写别名，命中返回
 * 目标 model（去掉 provider 前缀）；别名指向的 provider 与当前会话不一致时返回
 * mismatch 由调用方告警——绝不静默换 provider。
 */
/**
 * Bash 工具的生产 native 桥（spec 04-tools-permissions.md §4.3.1 / r13-I11）：
 * 把工具算好的最小 env（PATH/HOME/LANG/TZ + [tools] pass_through_env 白名单，
 * 值可含 [env] 段写入 process.env 的配置）透传进 volund-sandbox——Rust 侧
 * env_clear 后只注入 permissions.env.read 白名单内的名字，宿主其余环境不进沙箱。
 * `env` 绝不与宿主全量环境合并（tool-kit NativeBridge 契约）。
 *
 * 沙箱 fs 根 = cwd + `[tools] fs_read_roots` / `fs_write_roots`（~ 展开、必须
 * 解析为绝对路径）：没有它们，沙箱面永远钉死 cwd，项目外读写对 Bash 通道
 * 不可达（Read/Write/Edit 走各自的 fs spec，不受此限）。超时由
 * `[tools] command_timeout_ms`（缺省 60s）进 ExecRequest，Rust 侧执行真超时。
 */
export function createSandboxNativeBridge(options: {
  readonly cwd: () => string
  readonly onViolation: (input: { tier: SandboxTier; reason: string }) => Promise<void>
  readonly fsReadRoots?: readonly string[]
  readonly fsWriteRoots?: readonly string[]
  readonly timeoutMs?: number
}): NativeBridge {
  return {
    async execute(command, args, signal, env) {
      const cwd = options.cwd()
      const result = await execSandbox(
        {
          command: [command, ...args].join(' '),
          cwd,
          permissions: {
            fs: {
              read: [cwd, ...(options.fsReadRoots ?? [])],
              write: [cwd, ...(options.fsWriteRoots ?? [])],
            },
            net: false,
            env: { read: Object.keys(env ?? {}) },
          },
          ...(options.timeoutMs === undefined ? {} : { timeout_ms: options.timeoutMs }),
          ...(env ? { env } : {}),
        },
        signal,
      )
      for (const reason of result.sandbox_violations)
        await options.onViolation({ tier: result.sandbox_tier, reason })
      return result.stdout
    },
  }
}

export interface ProductionOptions {
  volundHome?: string
  identity: Readonly<AppIdentity>
  model?: string
}

/**
 * SAG-03 §2.7bis.4：config reload 整体替换 dispatcher 时保留运行史——
 * 有活跃运行不替换（原行为）；无活跃运行时新建实例并继承旧注册表历史，
 * 不再清史（旧行为：替换即丢全部已 settle 行）。
 */
export function rebuildDispatcherOnConfigReload(
  current: SubagentDispatcher,
  build: () => SubagentDispatcher,
): SubagentDispatcher {
  if (current.activeCount !== 0) return current
  const next = build()
  next.inheritRuns(current)
  return next
}

function messageTextParts(content: SessionState['messages'][number]['content']): string {
  return content
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

export function createProductionPorts(options: ProductionOptions): VolundPorts {
  const home = options.volundHome ?? process.env.VOLUND_HOME ?? join(homedir(), '.volund')
  // 应用级内核：面板收集器等跨会话服务挂这里；每会话 kernel（createRunner）是
  // 它的会话级兄弟层，S2 起插件贡献也经应用级内核汇聚。
  const appKernel = createAppKernel()
  // H2：活会话内核的 tools 服务集合——插件卸载/禁用时对每个活内核广播摘除。
  const liveToolServices = new Set<ToolsService>()
  const backups = new BackupStore(join(home, 'backups'))
  const evolution = new EvolutionStore(join(home, 'tuning'))
  const history = new FileInputHistoryStore(join(home, 'history', 'input.jsonl'))
  const trust = new DirectoryTrustStore(home)
  const telemetryPath = join(home, 'telemetry', 'events.jsonl')
  const telemetry = new Telemetry(new LocalTelemetrySink(telemetryPath))
  const telemetryStore = new TelemetryStore(telemetryPath)
  const logger = new TelemetryLogger(telemetry, 'cli')
  // r13 §4.4：持久化权限规则单例——allow-project → <cwd>/.volund/permissions.toml，
  // allow/deny-forever → <home>/permissions.toml。进程共享一份，子 session 的
  // grant 对父 session 立即可见；ready() 在首个 runner 构造前装载。
  const permissionRules = new PermissionRuleStore({
    project: join(process.cwd(), '.volund', 'permissions.toml'),
    global: join(home, 'permissions.toml'),
    logger,
  })
  const slashCommands = new MutableSlashCommandRegistry()
  // volund-plugin-web-search：跨会话共享的 WebSearch 工具实例——插件贡献的
  // provider 经 setProvider 热接线，启用/禁用即时生效于全部活会话。
  const webSearchTool = new WebSearchTool()
  // P1-04d：插件域装配迁入 app-runtime（createPluginDomain）；loadedPluginEntries /
  // localPluginState / localPluginHub 等共享句柄经解构取用，F1 工具域名单同源。
  // 记忆插件宿主：memoryStack 在下方创建，这里先声明惰性转发（插件调用
  // 发生在运行期，装配完成后 host 必已就绪）。
  let pluginMemoryHost: ReturnType<typeof createPluginMemoryHost> | undefined
  const pluginDomain = createPluginDomain({
    memoryHost: (plugin, operation, params) => {
      if (!pluginMemoryHost)
        return Promise.reject(
          new VolundError('plugin_memory_unavailable', 'memory host is not connected'),
        )
      return pluginMemoryHost(plugin, operation, params)
    },
    home,
    volundVersion: options.identity.version,
    logger,
    emitTelemetry: (name, category, payload) => telemetry.emit(name, category, payload),
    slashCommands,
    getAppliedEnv: () => configDomain.appliedEnv(),
    liveToolServices,
    resolveBuiltinPluginRoot: builtinPluginRoot,
    webSearchTool,
    httpFetch: async (url, init) => {
      const request = (init ?? {}) as {
        method?: string
        headers?: Record<string, string>
        body?: unknown
      }
      const method = request.method === 'POST' ? 'POST' : 'GET'
      const response = await http.request({
        url,
        method,
        headers: request.headers ?? {},
        body: request.body,
        signal: AbortSignal.timeout(9_000),
      })
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        // fd3 桥帧上限 1MB（plugin_host.mjs MAX_FRAME）：响应体整体作为 JSON 帧
        // 回传，必须留在帧限以内。
        if (size > 900_000)
          throw new VolundError(
            'plugin_rpc_frame_too_large',
            'plugin http.fetch response exceeds 900KB',
          )
        chunks.push(Buffer.from(chunk))
      }
      return {
        status: response.status,
        headers: response.headers ?? {},
        body: Buffer.concat(chunks).toString('utf8'),
      }
    },
  })
  const localPlugins = pluginDomain.localPlugins
  const localPluginState = pluginDomain.localPluginState
  const loadedPluginEntries = pluginDomain.loadedPluginEntries
  const localPluginHub = pluginDomain.localPluginHub
  const builtinToolsDisabled = pluginDomain.builtinToolsDisabled
  const ensureBuiltinToolsConfig = pluginDomain.ensureBuiltinToolsConfig
  const memoryStack = createMemoryStack(home, { cwd: process.cwd() })
  const memory = memoryStack.memory
  const memoryRecall = memoryStack.memoryRecall
  const memoryMaintenance = memoryStack.memoryMaintenance
  const memoryTransfer = memoryStack.memoryTransfer
  pluginMemoryHost = createPluginMemoryHost({
    home,
    cwd: process.cwd(),
    sessionId: () => lastRunner?.state.id,
    memory,
    memoryRecall,
    memoryTransfer,
  })
  let cachedPassphrase: string | undefined
  const passphrase = async () => {
    if (cachedPassphrase) return cachedPassphrase
    const value = await promptSecret('Credential-store passphrase: ')
    if (!value)
      throw new VolundError(
        'credential_passphrase_required',
        'A credential-store passphrase is required',
      )
    cachedPassphrase = value
    return value
  }
  const encrypted = new EncryptedCredentialStore(
    join(home, 'credentials.enc'),
    passphrase,
    join(home, 'auth.state.json'),
  )
  const auth = new AuthManager({
    encrypted,
    env: process.env,
    telemetry,
    configKeys: async (provider) => {
      const value = (await readAuthSection(home))[`${provider}_api_key`]
      return typeof value === 'string' && value ? value : undefined
    },
  })
  let skipAuthEmitted = false
  const http = new NodeHttpPort()
  const permissionPolicy = new ProductionPermissionSessionPolicy()
  // §4.4 /mode 热切换的活动顶层会话句柄：createRunner 建 chain 时登记，端口 set 时热切。
  let activePermissionControl:
    | {
        get(): PermissionSessionMode
        set(mode: PermissionSessionMode): void
      }
    | undefined
  // /skill-name 路径的 allowed-tools 登记口：slash 处理在 runtime 层，触达不到
  // per-Runner 的 permissionChain——顶层 chain 建好时登记，slash invoke 时授予。
  let activeSkillGrants:
    | {
        grant(rules: ReadonlyArray<{ tool: string; spec: PermissionSpec }>): void
        clear(): void
      }
    | undefined
  // 优先级：CLI flag / /mode 的 override > [permissions] mode 用户级 config > 'ask'。
  let overridePermissionMode: PermissionSessionMode | undefined
  let configPermissionMode: PermissionSessionMode | undefined
  // 审批/提问卡无人决策的兜底超时：控制器自带 120s 默认，[permissions]
  // request_timeout_ms 装载后回填（0 = 关闭兜底）；line 模式问询同钟。
  let configPromptTimeoutMs: number | undefined
  // §4.4 档位变更广播（TUI /mode、Web composer、权限卡 g 授权共用）：web 端
  // SSE 推 permission.mode 帧，多端选择器实时同步（此前只在挂载时拉一次会脱钩）。
  const permissionModeListeners = new Set<(mode: PermissionSessionMode) => void>()
  const notifyPermissionMode = (mode: PermissionSessionMode): void => {
    // 迭代副本：回调内退订不打断本轮通知
    for (const listener of Array.from(permissionModeListeners)) listener(mode)
  }
  // 启动期一次性装载的用户级 config 会话默认值：[subagent] 限制与 [models.aliases]。
  // config 是异步读的；dispatcher 在装载完成后整体替换（启动期必然没有在跑的 subagent）。
  let configSubagentLimits: {
    maxDepth?: number
    maxConcurrency?: number
    defaultBudget?: { costUSDMax?: number; tokenMax?: number; timeMsMax?: number }
  } = {}
  let configModelAliases: Record<string, { provider: string; model: string }> = {}
  // [ui].locale（i18n-r1）：会话列表「未命名会话」等服务端文案的取值面（web/mobile
  // 控制台自身语言走浏览器 localStorage，不读此值）。
  let configUiLocale: Locale | undefined
  void readConfigFileOrEmpty(join(home, 'config.toml'))
    .then((config) => {
      const permissions = config.permissions
      if (permissions && typeof permissions === 'object' && !Array.isArray(permissions)) {
        const mode = (permissions as Record<string, JsonValue>).mode
        if (mode === 'ask' || mode === 'auto' || mode === 'full') {
          configPermissionMode = mode
          if (!overridePermissionMode) permissionPolicy.configureMode({ mode })
        }
        const requestTimeoutMs = (permissions as Record<string, JsonValue>).request_timeout_ms
        if (typeof requestTimeoutMs === 'number' && requestTimeoutMs >= 0) {
          configPromptTimeoutMs = requestTimeoutMs
          permissionPrompts.configure({ timeoutMs: requestTimeoutMs })
          askPrompts.configure({ timeoutMs: requestTimeoutMs })
        }
      }
      const ui = config.ui
      if (ui && typeof ui === 'object' && !Array.isArray(ui)) {
        const locale = (ui as Record<string, JsonValue>).locale
        if (locale === 'zh' || locale === 'en') configUiLocale = locale
      }
      const subagent = config.subagent
      if (subagent && typeof subagent === 'object' && !Array.isArray(subagent)) {
        const section = subagent as Record<string, JsonValue>
        const limits: typeof configSubagentLimits = {}
        if (typeof section.max_depth === 'number' && section.max_depth > 0)
          limits.maxDepth = section.max_depth
        if (typeof section.max_concurrent === 'number' && section.max_concurrent > 0)
          limits.maxConcurrency = section.max_concurrent
        const budget = section.default_budget
        if (budget && typeof budget === 'object' && !Array.isArray(budget)) {
          const raw = budget as Record<string, JsonValue>
          const parsed: typeof limits.defaultBudget = {}
          if (typeof raw.costUSDMax === 'number') parsed.costUSDMax = raw.costUSDMax
          if (typeof raw.tokenMax === 'number') parsed.tokenMax = raw.tokenMax
          if (typeof raw.timeMsMax === 'number') parsed.timeMsMax = raw.timeMsMax
          if (Object.keys(parsed).length > 0) limits.defaultBudget = parsed
        }
        if (Object.keys(limits).length > 0) {
          configSubagentLimits = limits
          // SAG-03：reload 不再清运行史（无活跃运行时替换并继承旧注册表）。
          if (dispatcher) dispatcher = rebuildDispatcherOnConfigReload(dispatcher, buildDispatcher)
        }
      }
      const models = config.models
      if (models && typeof models === 'object' && !Array.isArray(models)) {
        const aliases = (models as Record<string, JsonValue>).aliases
        if (aliases && typeof aliases === 'object' && !Array.isArray(aliases)) {
          const parsed: Record<string, { provider: string; model: string }> = {}
          for (const [name, value] of Object.entries(aliases as Record<string, JsonValue>)) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) continue
            const entry = value as Record<string, JsonValue>
            if (typeof entry.provider === 'string' && typeof entry.model === 'string')
              parsed[name] = { provider: entry.provider, model: entry.model }
          }
          configModelAliases = parsed
        }
      }
    })
    .catch(() => {})

  // ── SKILLS-MCPS-r1：/skills 与 /mcp 的运行期装配（原生，不经插件桥）──────────
  // skills：多作用域发现（每个 Runner 一个 SkillsRuntime，共享同一个可变 disabled
  // 名单——面板 / config 任一侧改名单对所有会话即时生效）。
  // F1：第一方工具域禁用名单（[plugins] builtin_disabled）——createRunner 装配
  // 与 volund plugins builtin 面板/CLI 共用同一份可变状态。
  // P1-04c：skills 域装配迁入 app-runtime（createSkillDomain）；skillsRuntimes /
  // skillsDisabled 等多会话共享状态由工厂持有，createRunner 与面板经解构句柄取用。
  const skillDomain = createSkillDomain({
    home,
    volundVersion: options.identity.version,
    logger,
    emitTelemetry: (name, category, payload) => telemetry.emit(name, category, payload),
    slashCommands,
    getDefaultCwd: () => process.cwd(),
    getUserHome: homedir,
    getSkillGrants: () => activeSkillGrants,
    pluginSkillDirs: async () =>
      collectPluginSkillDirs({
        builtinRoot: builtinPluginRoot(),
        stateEntries: await localPluginState.list().catch(() => []),
      }),
  })
  const skillsRuntimes = skillDomain.skillsRuntimes
  const skillsDisabled = skillDomain.skillsDisabled
  const skillsPanelController = skillDomain.skillsPanelController
  const skillPort = skillDomain.skillPort
  const ensureSkillsConfig = skillDomain.ensureSkillsConfig
  const syncSkillSlashCommands = skillDomain.syncSkillSlashCommands
  // P1-04d：MCP 域装配迁入 app-runtime（createMcpDomain）；单例 manager 与
  // 端口/面板由工厂持有，createRunner 与 shutdown 经解构句柄取用。
  const mcpDomain = createMcpDomain({
    home,
    logger,
    emitTelemetry: (name, category, payload) => telemetry.emit(name, category, payload),
    getDefaultCwd: () => process.cwd(),
    credentialStore: encrypted,
    authGetCredential: (key) => auth.getCredential(key),
    authLogout: (key) => auth.logout(key),
  })
  const mcpPort = mcpDomain.mcpPort
  const mcpPanelController = mcpDomain.mcpPanelController
  const ensureMcpManager = mcpDomain.ensureManager
  // MCP fatigue S0（§11.3.9）：per-server 弹窗限速守卫——超限的交互审批请求在进
  // 共享队列前直接 deny（reason:'fatigue'），模型侧拿到 mcp_fatigue_rate_limited 码。
  const mcpFatigueGuard = createMcpFatigueGuard({
    cwd: () => process.cwd(),
    volundHome: () => home,
    loadConfigs: (input) => loadMcpServerConfigs(input),
    onLimited: (server) => {
      void telemetry.emit('mcp.fatigue_rate_limited', 'security', { server })
    },
    onWarning: (message) => logger.warn(message),
  })

  // ── SUBAGENTS-UI-r1：/subagents 面板控制器（dispatcher 运行注册表）──────────
  // 运行是 REPL 进程本地的：面板即管理面，取消走 dispatcher.cancel 的
  // interrupt 语义（子 session abort → DispatchResult.cancelled）。
  const subagentsPanelController: SubagentsPanelController = {
    async list() {
      return dispatcher.list().map((entry) => ({
        sessionId: entry.sessionId,
        ...(entry.agentType ? { agentType: entry.agentType } : {}),
        depth: entry.depth,
        status: entry.status,
        startedAt: entry.startedAt,
        ...(entry.endedAt === undefined ? {} : { endedAt: entry.endedAt }),
        promptPreview: entry.promptPreview,
        prompt: entry.prompt,
        ...(entry.usage === undefined ? {} : { usage: entry.usage }),
        ...(entry.toolCalls === undefined ? {} : { toolCalls: entry.toolCalls }),
        ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      }))
    },
    async cancel(sessionId) {
      if (!dispatcher.cancel(sessionId))
        throw new VolundError('subagent_not_running', `Subagent ${sessionId} is not running`)
      return `Subagent cancelled`
    },
    async cancelAll() {
      return dispatcher.cancelAllRunning()
    },
  }
  // 面板控制器汇入应用级内核收集器（渲染层按 id 取用，插件面板同路进场）。
  appKernel.ui.registerPanel('skills', skillsPanelController)
  appKernel.ui.registerPanel('mcp', mcpPanelController)
  appKernel.ui.registerPanel('subagents', subagentsPanelController)

  let interactivePermissionPrompt:
    | ((
        request: InteractivePermissionRequest,
        signal?: AbortSignal,
      ) => Promise<InteractivePermissionDecision>)
    | undefined
  // §22 W-07 多路审批：进程级共享队列是权限链的唯一 prompt 源——TUI 与 Web
  // 都订阅它，任一端决策全端清卡（不再经 setPermissionPromptHandler 抢单槽）。
  const permissionPrompts = new PermissionPromptController()
  interactivePermissionPrompt = (request, signal) => {
    // S0-4：只拦 MCP 来源（spec.custom.mcpServer 在净化后仍保留，卡面渲染即依赖它）。
    const serverName = (
      request.spec as { value?: { custom?: { mcpServer?: unknown } } } | undefined
    )?.value?.custom?.mcpServer
    if (typeof serverName === 'string') {
      const deny = mcpFatigueGuard.check(serverName)
      if (deny) return Promise.resolve({ kind: 'deny', reason: deny.reason })
    }
    return permissionPrompts.request(request, signal)
  }
  // AskUserQuestion 的共享提问队列（同款多路分发）：TUI 选项卡与 Web/Mobile
  // 问答卡都订阅它，任一端作答全端清卡。
  const askPrompts = new AskPromptController()
  // §22 W-01：嵌入式 Web 控制台的 URL cell（startEmbedded 起服务后回填，状态面板 Web 行读取）。
  let webConsoleUrl: string | undefined
  let streamToStdout = true
  let dispatcher: SubagentDispatcher
  // r13-G2：后台 shell 注册表（跨 session 共享一个实例；事件在 SessionController
  // activate() 里挂到当前 session 的 EventBus，session.ended 统一 kill）
  const background = new BackgroundShells()
  // §2.7.1（r13-G3）：白名单校验全集 = 父工具注册表全集——内置域（按
  // [plugins] builtin_disabled 门控，与下方 createRunner 注册面同源）+ 全部
  // 已装载插件工具（plugin:<名>:<工具>，设计 §7.2）。MCP 工具连接期懒装载，
  // 不进全集（registry 侧豁免 mcp__<server>__<tool> 名字，执行侧过滤兜底）。
  // dispatcher 在函数调用期已赋值（discover 移到 buildDispatcher 之后）。
  function collectParentToolNames(): string[] {
    const names = new Set<string>()
    for (const domain of builtinToolDomains({
      backups,
      background,
      webSearch: { tool: webSearchTool },
      task: {
        dispatcher,
        parent: () => {
          throw new VolundError(
            'cli_internal',
            'dispatch parent handle is only available during a parent turn',
          )
        },
      },
    })) {
      if (builtinToolsDisabled.has(domain.id)) continue
      for (const tool of domain.tools) names.add(tool.name)
    }
    if (!builtinToolsDisabled.has('volund.orchestration')) {
      for (const tool of createMemoryTools(memory, memoryRecall)) names.add(tool.name)
      names.add(SKILL_TOOL_NAME)
      names.add(ASK_USER_QUESTION_TOOL_NAME)
    }
    for (const loaded of loadedPluginEntries) {
      if (!loaded.handle) continue
      for (const tool of loaded.handle.tools) names.add(tool.name)
    }
    return [...names]
  }
  // §2.7.1（r13-G3）：自定义 agent 定义两层装载（<home>/agents 与
  // <cwd>/.volund/agents，项目级同名覆盖全局）；失败文件跳过仅告警。
  const agentRegistry = new AgentDefinitionRegistry({
    volundHome: home,
    cwd: process.cwd(),
    parentToolNames: collectParentToolNames,
    onWarning: (message) => logger.warn(message),
  })
  // 记忆自动沉淀：进程收口时取最后一个活跃会话（end()/信号路径不经过这里）。
  let lastRunner: Runner | undefined
  let consolidationModel: MemoryConsolidationModel | undefined
  const createRunner: RunnerFactory = async (state, events, agent, overrides) => {
    const permissionSnapshot = permissionPolicy.snapshotFor(state)
    // A manager per Runner is intentional: child sessions cannot inherit parent permission cache.
    await permissionRules.ready()
    const permissionChain = createProductionToolPermissionChain({
      state,
      events,
      permissionSnapshot,
      logger,
      interactivePermissionPrompt: () => interactivePermissionPrompt,
      rules: permissionRules,
      // line 模式问询的无人应答兜底：默认 120s（config request_timeout_ms 可调/关）。
      promptTimeoutMs: configPromptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
      // P1-05：line 模式的 TTY 接缝显式注入（app-runtime 不再回退模块级 readline 默认）。
      terminalIsInteractive: isInteractiveTerminal,
      linePermissionPrompt: promptLineMaybe,
      // 权限卡 g 授权升级：回写会话级快照（同会话重建链不降档）并广播全端。
      ...(state.lineage.depth === 0
        ? {
            onFullAccessGranted: () => {
              permissionPolicy.escalateSessionMode(state.id, 'full')
              notifyPermissionMode('full')
            },
          }
        : {}),
    })
    // /mode 只挂顶层会话；子会话沿用其冻结快照里的模式。
    if (state.lineage.depth === 0) {
      activePermissionControl = {
        get: () => permissionChain.mode(),
        set: (mode) => permissionChain.setMode(mode),
      }
      activeSkillGrants = {
        grant: (rules) => permissionChain.grantEphemeral(rules),
        clear: () => permissionChain.clearEphemeral(),
      }
    }
    // 内核脊柱：每会话一棵 Context 树，先挂 bus/session；model/tools/sandbox
    // 在各自装配点以同形态服务挂载。第三方插件的贡献最终也注册进同一棵树。
    const kernel = createSessionKernel({ events, state })
    // skill allowed-tools 的回合边界：turn 终态即清空（业界语义=授权只活一轮）。
    kernel.bus.events.subscribe((event) => {
      if (event.type === 'turn.completed' || event.type === 'turn.aborted')
        permissionChain.clearEphemeral()
    })
    const { permissionRequests } = permissionChain
    // §15 T0: persisted values apply only after an explicit, typed boolean opt-in.
    const { config: userConfig, values: tuned } = await loadProductionContextTuning({
      home,
      persistence: evolution,
      logger,
    })
    // [auth] skipAuth = true（§8.4）：完全跳过凭据解析，请求不带 x-api-key
    // （企业网关 / 本地代理等带外认证场景）。设了就不再触碰任何 credential 层，
    // 也不会触发 enc 文件 passphrase 提示。
    const authSection = userConfig.auth
    const skipAuth = Boolean(
      authSection &&
      typeof authSection === 'object' &&
      !Array.isArray(authSection) &&
      authSection.skipAuth === true,
    )
    const providerSection = userConfig.provider
    const anthropicEntry =
      providerSection && typeof providerSection === 'object' && !Array.isArray(providerSection)
        ? providerSection.anthropic
        : undefined
    const configuredBaseUrl =
      anthropicEntry && typeof anthropicEntry === 'object' && !Array.isArray(anthropicEntry)
        ? anthropicEntry.baseUrl
        : undefined
    // provider.<name> 通用读取：openai / gemini 的 baseUrl、ollama 的 endpoint。
    // 仅当配置了对应条目时才实例化 client 并注册——未配置的 provider 不占资源、不报错。
    function readProviderEntry(
      name: 'openai' | 'gemini' | 'ollama',
    ): Record<string, unknown> | undefined {
      if (!providerSection || typeof providerSection !== 'object' || Array.isArray(providerSection))
        return undefined
      const entry = providerSection[name]
      return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : undefined
    }
    const openaiEntry = readProviderEntry('openai')
    const openaiBaseUrl =
      openaiEntry && typeof openaiEntry.baseUrl === 'string' && openaiEntry.baseUrl
        ? openaiEntry.baseUrl
        : undefined
    const geminiEntry = readProviderEntry('gemini')
    const geminiBaseUrl =
      geminiEntry && typeof geminiEntry.baseUrl === 'string' && geminiEntry.baseUrl
        ? geminiEntry.baseUrl
        : undefined
    const ollamaEntry = readProviderEntry('ollama')
    const ollamaEndpoint =
      ollamaEntry && typeof ollamaEntry.endpoint === 'string' && ollamaEntry.endpoint
        ? ollamaEntry.endpoint
        : undefined
    // 模型解析（§8.3）：preferences.model（TUI 状态面板选择，id 形如 'anthropic/<model>'，
    // 也接受 [models.aliases] 里的别名）→ provider.anthropic.model（静态配置）→
    // 调用方覆盖/默认值在 SingleProviderRouter 入参处收口
    const preferencesSection = userConfig.preferences
    const rawPreferredModel =
      preferencesSection &&
      typeof preferencesSection === 'object' &&
      !Array.isArray(preferencesSection) &&
      typeof preferencesSection.model === 'string' &&
      preferencesSection.model.trim().length > 0
        ? preferencesSection.model.trim()
        : undefined
    const aliasResolution =
      rawPreferredModel && Object.keys(configModelAliases).length > 0
        ? resolveModelAlias(rawPreferredModel, configModelAliases)
        : undefined
    if (aliasResolution && 'mismatch' in aliasResolution)
      logger.warn(
        `[models.aliases] alias '${rawPreferredModel}' targets provider '${aliasResolution.mismatch}'; only anthropic is active in this session — ignoring`,
      )
    const aliasModel =
      aliasResolution && 'model' in aliasResolution ? aliasResolution.model : undefined
    const preferencesModel =
      aliasModel ?? (rawPreferredModel ? rawPreferredModel.replace(/^anthropic\//, '') : undefined)
    const preferredLanguage =
      preferencesSection &&
      typeof preferencesSection === 'object' &&
      !Array.isArray(preferencesSection) &&
      typeof preferencesSection.language === 'string' &&
      preferencesSection.language.trim().length > 0
        ? preferencesSection.language.trim()
        : undefined
    const providerModel =
      anthropicEntry &&
      typeof anthropicEntry === 'object' &&
      !Array.isArray(anthropicEntry) &&
      typeof anthropicEntry.model === 'string'
        ? anthropicEntry.model
        : undefined
    const configuredModel = preferencesModel ?? providerModel
    const composer = new DefaultPromptComposer()
    composer.register(builtinPromptFragment)
    // H3：已激活插件的 prompt fragments 注册进本会话 composer（id 加插件命名
    // 空间防撞；priority 缺省 600，低于 skills/builtin）。中途卸载插件的
    // fragment 保留到会话结束（与插件工具同语义）。
    for (const loaded of loadedPluginEntries) {
      if (!loaded.handle) continue
      for (const prompt of loaded.handle.prompts)
        composer.register({
          id: `plugin:${loaded.name}:${prompt.id}`,
          source: `plugin:${loaded.name}`,
          priority: prompt.priority,
          text: prompt.content,
        })
    }
    // [preferences] language：显式配置才注入回复语言强制；不配则模型跟随输入语言。
    if (typeof preferredLanguage === 'string' && preferredLanguage !== 'system')
      composer.register(languagePromptFragment(preferredLanguage))
    registerRuntimeMemoryPrompts(composer, memory, state)
    const promptLoader = new PromptLoader({
      cwd: state.cwd,
      volundHome: home,
      permissions: permissionRequests,
    })
    await promptLoader.registerProject(composer)
    if (agent) {
      // §2.7.1：正文 = 该 agent 的 system prompt，独立槽位 priority=800（与 skill
      // 同级）；正文懒加载。project 级文件随 clone 进来属 untrusted 来源，必须包裹。
      composer.register({
        id: `agent-def:${agent.definition.name}`,
        source: `agent-def:${agent.path}`,
        priority: 800,
        text: async () => {
          const body = await agentRegistry.readBody(agent.path)
          return agent.trusted ? body : untrustedAgentBody(`agent-def:${agent.path}`, body)
        },
      })
    }
    // SKILLS-MCPS-r1：多作用域发现（project > user > .agents/skills 互操作），
    // disabled 名单跨 Runner 共享（面板切换即时生效）。每个 Runner 一个实例
    // （composer 是 per-session 的）；主会话最先创建，面板取 [...set][0]。
    await ensureSkillsConfig()
    const skills = new SkillsRuntime({
      // SM-08b：sources 惰性求值——插件捆绑 skills 的目录随安装/启停变化，
      // 每次 discover()（含面板 r 重扫）重新解析，优先级 project > plugin > user。
      sources: async () =>
        defaultSkillSources({
          volundHome: home,
          userHome: homedir(),
          cwd: state.cwd,
          pluginDirs: await collectPluginSkillDirs({
            builtinRoot: builtinPluginRoot(),
            stateEntries: await localPluginState.list().catch(() => []),
          }),
        }),
      volundVersion: options.identity.version,
      composer,
      disabled: skillsDisabled,
      onWarning: (message) => logger.warn(message),
      onEvent: (event, payload) => void telemetry.emit(event, 'skills', sanitize(payload)),
    })
    skillsRuntimes.add(skills)
    await skills.discover()
    await skills.registerIndex()
    await skills.activateAutomatic(state.cwd)
    syncSkillSlashCommands()
    const attachments = new AttachmentStore(
      join(home, 'sessions', state.id, 'attachments'),
      20 * 1024 * 1024,
      [state.cwd],
    )
    const anthropic = new AnthropicClient({
      credentials: {
        async getCredential() {
          if (skipAuth) {
            if (!skipAuthEmitted) {
              skipAuthEmitted = true
              await telemetry.emit(
                'auth.credential.skipped',
                'auth',
                sanitize({ provider: 'anthropic', source: 'auth.skipAuth' }),
              )
            }
            return undefined
          }
          const value = await auth.getCredential('anthropic')
          if (!value)
            throw new VolundError(
              'provider_credential_unavailable',
              'Anthropic credential unavailable',
            )
          return value
        },
      },
      http,
      attachments,
      ...(typeof configuredBaseUrl === 'string' && configuredBaseUrl
        ? { baseUrl: configuredBaseUrl }
        : {}),
    })
    const client = {
      ...anthropic,
      name: anthropic.name,
      capabilities: anthropic.capabilities,
      dispose: () => anthropic.dispose(),
      async *stream(request: Parameters<AnthropicClient['stream']>[0], signal: AbortSignal) {
        for await (const chunk of anthropic.stream(request, signal)) {
          if (streamToStdout && chunk.kind === 'text.delta') stdout.write(chunk.text)
          yield chunk
        }
        if (streamToStdout) stdout.write('\n')
      },
    }
    // 记忆自动沉淀（ADR-0015）：捕获本会话的 provider 接入与模型名——bin.ts
    // 进程收口时对最后一个活跃会话使用。per-session client 在这里才可见。
    consolidationModel = {
      // AnthropicClient 只有 stream（无 complete——compaction 的同款限制），
      // 聚合 text.delta 得到整段输出；不走 streamToStdout 的回显包装。
      complete: async ({ system, prompt, maxTokens, signal }) => {
        const resolvedModel = state.model ?? configuredModel
        if (!resolvedModel)
          throw new VolundError(
            'provider_model_unresolved',
            'No model configured for memory consolidation',
          )
        let text = ''
        for await (const chunk of anthropic.stream(
          {
            model: resolvedModel,
            system,
            maxTokens,
            messages: [
              {
                id: 'memory-consolidation',
                role: 'user',
                createdAt: Date.now(),
                content: [{ type: 'text', text: prompt }],
              },
            ],
          },
          signal,
        )) {
          if (chunk.kind === 'text.delta') text += chunk.text
        }
        return text
      },
    }
    // 上下文压缩：summary 策略（超过阈值摘要替换，ADR-0015 同款 stream 聚合；
    // AnthropicClient 无 complete）。模型调用失败回退滑动窗口（fallbackToSliding）。
    const contextPolicy = new SummaryPolicy(
      {
        compactionThreshold: tuned.compaction_threshold,
        targetRatio: tuned.target_ratio,
        keepRecent: tuned.keep_recent,
        fallbackToSliding: true,
      },
      {
        provider: {
          ...client,
          complete: async (request, signal) => {
            let text = ''
            for await (const chunk of anthropic.stream(request, signal)) {
              if (chunk.kind === 'text.delta') text += chunk.text
            }
            return {
              message: {
                id: 'summary-response',
                role: 'assistant' as const,
                createdAt: Date.now(),
                content: [{ type: 'text', text }],
              },
              usage: { input: 0, output: 0 },
            }
          },
        },
        countTokens: (text, model) => countTokens(text, model),
      },
    )
    // 内核脊柱：每会话一棵 Context 树；模型注册表以 `model` 服务提供——
    // tools/sandbox/session/events/ui 逐个迁为同形态服务，第三方插件的
    // 贡献也注册进同一棵树。
    const providers = kernel.model.registry
    providers.register(
      client,
      { kind: 'core' },
      { capabilities: client.capabilities, displayName: 'Anthropic' },
    )
    // ── 可选 provider 注册（openai / gemini / ollama）──────────────────────────
    // 仅当用户级 config.toml 配置了对应条目（baseUrl / endpoint）时才实例化并注册。
    // 配合 SingleProviderRouter 的 explicitModel（'openai/gpt-4o'）或 RoleRouter 使用。
    // Ollama 远程（非回环）endpoint 需交互确认——此处仅注册回环或已配置端点；
    // 非回环端点在 OllamaClient 构造时会因缺 approval 抛错，由调用方感知。
    if (openaiBaseUrl || (await auth.getCredential('openai'))) {
      const openai = new OpenAIClient({
        credentials: {
          async getCredential(): Promise<string> {
            if (skipAuth)
              throw new VolundError(
                'provider_credential_unavailable',
                'OpenAI credential unavailable (skipAuth)',
              )
            const value = await auth.getCredential('openai')
            if (!value)
              throw new VolundError(
                'provider_credential_unavailable',
                'OpenAI credential unavailable',
              )
            return value
          },
        },
        http: http,
        attachments,
        ...(openaiBaseUrl ? { baseUrl: openaiBaseUrl } : {}),
      })
      providers.register(
        openai,
        { kind: 'core' },
        { capabilities: openai.capabilities, displayName: 'OpenAI' },
      )
    }
    if (geminiBaseUrl || (await auth.getCredential('gemini'))) {
      const gemini = new GeminiClient({
        credentials: {
          async getCredential(): Promise<string> {
            if (skipAuth)
              throw new VolundError(
                'provider_credential_unavailable',
                'Gemini credential unavailable (skipAuth)',
              )
            const value = await auth.getCredential('gemini')
            if (!value)
              throw new VolundError(
                'provider_credential_unavailable',
                'Gemini credential unavailable',
              )
            return value
          },
        },
        http: http,
        model: 'gemini-2.0-flash',
        attachments,
        ...(geminiBaseUrl ? { baseUrl: geminiBaseUrl } : {}),
      })
      providers.register(
        gemini,
        { kind: 'core' },
        { capabilities: gemini.capabilities, displayName: 'Gemini' },
      )
    }
    if (ollamaEndpoint || ollamaEntry) {
      // Ollama 无凭据；回环 endpoint 免确认，非回环需 approval（此处仅注册回环）。
      const endpoint = ollamaEndpoint ?? 'http://127.0.0.1:11434'
      if (isLoopbackOllamaEndpoint(endpoint)) {
        const ollama = new OllamaClient({
          http: http as unknown as import('@volund/provider-ollama').HttpPort,
          endpoint,
          attachments,
        })
        providers.register(
          ollama,
          { kind: 'core' },
          { capabilities: ollama.capabilities, displayName: 'Ollama' },
        )
      }
    }
    let router: RouterPolicy = new SingleProviderRouter(
      client,
      options.model ?? configuredModel ?? 'claude-sonnet-4-20250514',
      undefined,
      providers,
    )
    const routerConfig = userConfig.router
    if (
      routerConfig &&
      typeof routerConfig === 'object' &&
      !Array.isArray(routerConfig) &&
      routerConfig.type === 'fallback'
    ) {
      // §3.8.2：按 config chain 构造 FallbackRouter（priority 高者优先，失败
      // provider 进入 cooldown_seconds 冷却）。chain 里未注册的 provider 跳过
      // 并告警；过滤后为空则维持 single 并告警，不让启动失败。
      const rawChain = Array.isArray(routerConfig.chain) ? routerConfig.chain : []
      const chain = rawChain.flatMap((entry) => {
        const route = entry as Record<string, JsonValue>
        const providerName = typeof route.provider === 'string' ? route.provider : ''
        const model = typeof route.model === 'string' ? route.model : ''
        const priority = typeof route.priority === 'number' ? route.priority : 0
        const registered = providerName ? providers.get(providerName) : undefined
        if (!registered) {
          logger.warn(
            `[router] fallback chain: provider '${providerName}' is not registered; skipping`,
          )
          return []
        }
        return [{ provider: registered, model, priority }]
      })
      if (chain.length > 0) {
        const cooldownSeconds =
          typeof routerConfig.cooldown_seconds === 'number' ? routerConfig.cooldown_seconds : 60
        router = new FallbackRouter(chain, { cooldownMs: cooldownSeconds * 1000 })
      } else {
        logger.warn('[router] type=fallback but no chain provider resolved; using single provider')
      }
    }
    if (
      routerConfig &&
      typeof routerConfig === 'object' &&
      !Array.isArray(routerConfig) &&
      routerConfig.type === 'role'
    )
      router = new RoleRouter(providers, parseRoleRouterConfig(routerConfig))
    // §2.7.1：agent 定义可指定 provider/model；目标 provider 未注册时继承父
    // router 并告警（不阻塞派发）。
    if (agent?.definition.model) {
      const registered = providers.get(agent.definition.model.provider)
      if (registered)
        router = new SingleProviderRouter(
          registered,
          agent.definition.model.model,
          undefined,
          providers,
        )
      else
        logger.warn(
          `agent '${agent.definition.name}': provider '${agent.definition.model.provider}' is not registered; inheriting the parent model`,
        )
    }
    // [tools] 段（§4.3.1 / r13-I11）在这里接线进 Bash 工具：shell 固定逻辑与
    // env 继承白名单；缺省时 BashTool 走内置默认（Unix /bin/bash；PATH/HOME/LANG/TZ）。
    const toolsSection = userConfig.tools
    const toolsConfig =
      toolsSection && typeof toolsSection === 'object' && !Array.isArray(toolsSection)
        ? (toolsSection as Record<string, JsonValue>)
        : {}
    const windowsShell =
      typeof toolsConfig.windows_shell === 'string' && toolsConfig.windows_shell
        ? toolsConfig.windows_shell
        : undefined
    const passThroughEnv = Array.isArray(toolsConfig.pass_through_env)
      ? toolsConfig.pass_through_env.filter(
          (name): name is string => typeof name === 'string' && name !== '',
        )
      : undefined
    // [tools] fs_read_roots / fs_write_roots / command_timeout_ms：沙箱面配置
    // （§4.3.1）。~ 展开 + resolve 绝对化；非绝对路径告警丢弃（Rust 侧 validate
    // 本就拒绝，提前拦下给配置者可读的错误）。
    const expandRoot = (value: string): string =>
      value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
    const sandboxRoots = (key: 'fs_read_roots' | 'fs_write_roots'): string[] | undefined => {
      const raw = toolsConfig[key]
      if (!Array.isArray(raw)) return undefined
      const roots: string[] = []
      for (const entry of raw) {
        if (typeof entry !== 'string' || entry.trim() === '') continue
        const resolved = resolve(expandRoot(entry))
        if (!isAbsolute(resolved)) {
          logger.warn(`ignoring non-absolute [tools] ${key} entry: ${entry}`)
          continue
        }
        roots.push(resolved)
      }
      return roots.length > 0 ? roots : undefined
    }
    const sandboxReadRoots = sandboxRoots('fs_read_roots')
    const sandboxWriteRoots = sandboxRoots('fs_write_roots')
    const commandTimeoutMs =
      typeof toolsConfig.command_timeout_ms === 'number' &&
      Number.isFinite(toolsConfig.command_timeout_ms) &&
      toolsConfig.command_timeout_ms > 0
        ? toolsConfig.command_timeout_ms
        : undefined
    // 内核 `tools` 服务：注册表从 Context 取（与 model 同形态，S1 批次 A）。
    kernel.plugin(ToolsService)
    liveToolServices.add(kernel.tools)
    kernel.bus.events.subscribe((event) => {
      if (event.type === 'session.ended') {
        liveToolServices.delete(kernel.tools)
        kernel.tools.unregisterAllPluginTools()
      }
      // H5：会话生命周期 + 任务运行终态（W-17 r1.5）事件广播给插件 hooks
      // （session.on / hooks.on 订阅）。
      broadcastPluginLifecycleHook(event, loadedPluginEntries, logger)
    })
    const registry = kernel.tools.registry
    await ensureBuiltinToolsConfig()
    // F1 插件一等公民：内置工具按域装配——[plugins] builtin_disabled 整域禁用；
    // memory/Skill 工具归 orchestration 域门控。工具名与注册顺序对既有会话零变化。
    for (const domain of builtinToolDomains({
      backups,
      background,
      webSearch: { tool: webSearchTool },
      bash: {
        ...(windowsShell ? { windowsShell } : {}),
        ...(passThroughEnv ? { passThroughEnv } : {}),
      },
      task: {
        dispatcher,
        parent: (signal) => ({
          state: runner.state,
          events,
          turnId: runner.state.activeTurn ?? '',
          signal,
        }),
      },
    })) {
      if (builtinToolsDisabled.has(domain.id)) continue
      for (const tool of domain.tools) registry.register(tool)
    }
    if (!builtinToolsDisabled.has('volund.orchestration')) {
      for (const tool of createMemoryTools(memory, memoryRecall)) registry.register(tool)
      registry.register(
        createSkillTool({
          skills,
          grantEphemeral: (rules) => permissionChain.grantEphemeral(rules),
          onWarn: (message) => logger.warn(message),
        }),
      )
      // AskUserQuestion：工具本体在 @volund/tools（零依赖，交互走 ToolUiPort
      // 的 requestChoice 通道）；这里的宿主接缝按本会话冻结的权限快照决定
      // 交互面——tui 进共享提问队列（TUI/Web/Mobile 任一端作答），line 终端
      // 数字问答，none 由工具降级为「用户不可达」。
      registry.register(createAskUserQuestionTool())
      // W-17：schedule_task 会话工具（写任务定义表；触发权仍归 daemon）。
      registry.register(
        createScheduleTaskTool({
          home,
          sessionCwd: state.cwd,
          status: async () => {
            const section = (userConfig.tasks ?? {}) as { enabled?: unknown }
            const daemon = await readDaemonStatus(home)
            return {
              enabled: section['enabled'] === true,
              daemonRunning: daemon.running,
              ...(daemon.pid ? { pid: daemon.pid } : {}),
            }
          },
        }),
      )
    }
    // G 插件一等公民：已激活插件的工具贡献注册进本会话注册表——
    // permissionSpec 收敛到 {custom:{pluginTool:{plugin,tool}}} 进统一权限决策链；
    // 输出按不可信内容包裹（与 MCP 工具同策略）。插件在会话中途卸载时，本会话
    // 已注册工具保留到会话结束（invoke 经已关闭的桥会以错误收场，不会静默）。
    for (const loaded of loadedPluginEntries) {
      if (!loaded.handle) continue
      for (const tool of loaded.handle.tools) {
        kernel.tools.registerPluginTool(loaded.name, {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, JsonValue>,
          permissionSpec: () => ({
            custom: { pluginTool: { plugin: loaded.name, tool: tool.name } },
          }),
          invoke: async (input) => {
            const started = Date.now()
            const raw = await tool.invoke(input)
            return {
              content: [
                {
                  type: 'text',
                  text: `<untrusted source="${escapeUntrustedText(tool.name)}">\n${escapeUntrustedText(JSON.stringify(raw ?? null))}\n</untrusted>`,
                },
              ],
              meta: { durationMs: Date.now() - started, costImpact: 'moderate' },
            }
          },
        })
      }
    }
    // SKILLS-MCPS-r1 §S3.5：共享 MCP 连接的工具（mcp__<server>__<tool>）挂进本
    // Runner 的 registry；invoke 走 runtime 级共享连接，子 agent 不重复 spawn。
    ;(await ensureMcpManager(state.cwd)).attach(registry)
    let runner: Runner
    const native = createSandboxNativeBridge({
      cwd: () => runner.state.cwd,
      ...(sandboxReadRoots ? { fsReadRoots: sandboxReadRoots } : {}),
      ...(sandboxWriteRoots ? { fsWriteRoots: sandboxWriteRoots } : {}),
      ...(commandTimeoutMs === undefined ? {} : { timeoutMs: commandTimeoutMs }),
      onViolation: async ({ tier, reason }) => {
        await telemetry.violation({
          mechanism: 'volund-sandbox',
          tier,
          operation: 'sandbox-exec',
          decision: 'deny',
          reason,
        })
      },
    })
    kernel.plugin(SandboxService, native)
    // H1：插件 hook 管线——已激活插件的 preToolUse/postToolUse 订阅按装载顺序
    // 执行，首个 HookResult（veto/rewrite）生效；handler 错误 fail-open（warn 后
    // 继续），回合中止即停止派发。builtin/project/user 域留待宿主 hook 注册面。
    const dispatchHook = createPluginHookDispatcher(loadedPluginEntries, logger)
    const executor = permissionChain.bindExecutor(
      (signal) => ({
        abortSignal: signal,
        // SAG-06 (spec §2.7bis.3 U1): rootSessionId 让子代理会话的文件备份归档到
        // lineage 根会话 manifest——/undo 与 Web changes 视图在根会话上覆盖全树。
        session: {
          id: state.id,
          cwd: state.cwd,
          turnId: runner.state.activeTurn ?? '',
          rootSessionId: lineageRootSessionId(state),
        },
        native,
        logger,
        ui: {
          requestInput: promptLine,
          requestChoice: createAskUserInteraction({
            prompts: askPrompts,
            mode: permissionSnapshot.interactionMode,
            linePrompt: promptLineMaybe,
          }),
        },
      }),
      dispatchHook,
    )
    // §2.7.1：agent 的 tools 白名单只能收紧——schemas 与 execute 两处同时过滤，
    // 白名单外的工具对模型不可见、调用即拒绝。W-17：会话启动 overrides
    // （任务约束）与 agent 定义白名单取交——两者同时在场时更严者胜。
    const sessionAllowed = overrides?.allowedTools
    const allowedTools = sessionAllowed
      ? agent?.definition.tools
        ? agent.definition.tools.filter((name) => sessionAllowed.includes(name))
        : sessionAllowed
      : agent?.definition.tools
    const tools: RunnerToolPort = {
      schemas: () => {
        const all = registry.forProvider()
        return allowedTools ? all.filter(({ name }) => allowedTools.includes(name)) : all
      },
      async execute(use, signal) {
        const tool = registry.get(use.name)
        if (!tool)
          return {
            toolUseId: use.id,
            isError: true,
            content: [{ type: 'text', text: `Unknown tool: ${use.name}` }],
          }
        if (allowedTools && !allowedTools.includes(use.name))
          return {
            toolUseId: use.id,
            isError: true,
            content: [
              {
                type: 'text',
                text: `Tool '${use.name}' is not in the tool whitelist of agent '${agent?.definition.name}'`,
              },
            ],
          }
        const result = await executor.execute(tool, use.input, signal, use.id)
        return {
          toolUseId: use.id,
          content: result.content,
          ...(result.isError === undefined ? {} : { isError: result.isError }),
          ...(result.meta?.linesAdded === undefined ? {} : { linesAdded: result.meta.linesAdded }),
          ...(result.meta?.linesRemoved === undefined
            ? {}
            : { linesRemoved: result.meta.linesRemoved }),
        }
      },
    }
    runner = new Runner(
      state,
      router,
      composer,
      tools,
      events,
      // §2.7.1：maxTurns 等价于该 agent 的 maxToolLoopsPerTurn；W-17 任务预算
      // （--budget，F1-02 frozen budget）随 RunnerOptions 注入，按回合计量。
      {
        ...(agent?.definition.maxTurns ? { maxToolLoopsPerTurn: agent.definition.maxTurns } : {}),
        ...(overrides?.budget ? { budget: overrides.budget } : {}),
        ...(overrides?.taskRun ? { taskRun: overrides.taskRun } : {}),
      },
      contextPolicy,
    )
    // 记忆自动沉淀的输入源：进程收口（bin.ts）时最后一个**根会话**的记录——
    // 子代理会话（SubagentDispatcher 同样经此工厂创建）不覆盖，否则沉淀会
    // 提炼子代理的任务转录而不是父会话的用户交互。
    if (!state.lineage?.parentSessionId) lastRunner = runner
    return runner
  }
  // [subagent] 限制（§2.7.2）：默认 3 / 4 / 固定预算，用户级 config 的
  // [subagent] 段覆盖；config 异步装载完成后整体替换 dispatcher。
  const buildDispatcher = () =>
    new SubagentDispatcher({
      runnerFactory: createRunner,
      agents: agentRegistry,
      maxDepth: configSubagentLimits.maxDepth ?? 3,
      maxConcurrency: configSubagentLimits.maxConcurrency ?? 4,
      defaultBudget: {
        costUSDMax: configSubagentLimits.defaultBudget?.costUSDMax ?? 1,
        tokenMax: configSubagentLimits.defaultBudget?.tokenMax ?? 200_000,
        timeMsMax: configSubagentLimits.defaultBudget?.timeMsMax ?? 10 * 60_000,
        toolCallMax: 100,
      },
    })
  dispatcher = buildDispatcher()
  // §2.7.1（G3）：discover 放在 dispatcher 装配之后——白名单校验全集里的 Task
  // 工具锚定 dispatcher 实例，此时 collectParentToolNames 才是完整父注册表全集。
  // 同步执行，先于任何会话创建（Task inputSchema 的 agentType 枚举依赖扫描结果）。
  agentRegistry.discover()
  // P1-03（§22.7.1）：会话控制器 = 应用级内核的 Cordis service（行为等价于原
  // RuntimeSessionPort；新增 turn mutex，终端接缝经 options.terminal 注入）。
  // cordis 的 Context 增强只能声明非泛型形态，这里按实际装配取回类型化实例。
  appKernel.plugin(SessionController, {
    sessionsDir: join(home, 'sessions'),
    uiLocale: () => configUiLocale,
    createRunner,
    onSecurity: (input) => permissionPolicy.configureSecurity(input),
    onPermissionInteraction: (input) => permissionPolicy.configureInteraction(input),
    onEnd: async (sessionId) => {
      permissionPolicy.releaseLineage(sessionId)
      await memory.flush()
    },
    // 删除会话档案后的备份清理（/undo、restore 的数据源一并回收）。
    onDelete: async (sessionId) => {
      await backups.purgeSession(sessionId)
    },
    onTerminalOutput: (input) => {
      streamToStdout = input.streamToStdout
    },
    onPermissionPromptHandler: () => {
      // 共享队列是唯一 prompt 源：set/clear 都重断言，端侧互不覆盖（W-07 多路）。
      interactivePermissionPrompt = (request, signal) => {
        const serverName = (
          request.spec as { value?: { custom?: { mcpServer?: unknown } } } | undefined
        )?.value?.custom?.mcpServer
        if (typeof serverName === 'string') {
          const deny = mcpFatigueGuard.check(serverName)
          if (deny) return Promise.resolve({ kind: 'deny', reason: deny.reason })
        }
        return permissionPrompts.request(request, signal)
      }
    },
    statusSnapshot: createStatusSnapshotAdapter({
      version: options.identity.version,
      dangerousPermissions: (state) =>
        permissionPolicy.snapshotForSession(state.id)?.dangerouslySkip ?? false,
      permissionMode: (state) =>
        activePermissionControl?.get() ??
        permissionPolicy.snapshotForSession(state.id)?.mode ??
        'ask',
      configAvailable: () =>
        access(join(home, 'config.toml')).then(
          () => true,
          () => false,
        ),
      async sandbox() {
        const value = await probeSandbox().catch(() => undefined)
        if (!value) return undefined
        const features = value.features
        return {
          tier: value.tier,
          mechanism: typeof features.mechanism === 'string' ? features.mechanism : 'volund-sandbox',
          features: {
            filesystem: Boolean(features.filesystem ?? value.tier !== 'none'),
            network: Boolean(features.network),
          },
          degradationReasons: value.known_limitations,
        }
      },
    }),
    background,
    terminal: { isInteractive: isInteractiveTerminal, promptLine: promptLineMaybe },
  })
  const session = appKernel.sessions as SessionController<StatusViewModel>
  // SAG-03 §2.7bis.4：会话激活（新建 / resume）后从父会话 JSONL 重放重建 dispatcher
  // 运行注册表——独立全扫（不经 resume replay 的尾部 20-turn 窗口；subagent.* 是会话级
  // 运行史事件，窗口语义不适用）。每会话每进程一次；live 条目优先，dispatched 无
  // settled → interrupted 合成标记（crash 残留行）。读取失败不影响会话激活。
  const rebuiltRegistries = new Set<string>()
  session.onActivate((active) => {
    if (rebuiltRegistries.has(active.id)) return
    rebuiltRegistries.add(active.id)
    void new SessionStore(join(home, 'sessions', `${active.id}.jsonl`))
      .load()
      .then((stored) => dispatcher.rebuildFromJournal(stored))
      .catch(() => {})
  })
  // P1-04e：auth/config/native 三域装配（app-runtime 工厂；凭据交互输入与
  // verify 网络调用经 options 注入，行为等价）。
  const authDomain = createAuthDomain({
    home,
    auth,
    promptCredential: (prompt) => promptSecret(prompt),
    verifyAnthropic: (credential, baseUrl) =>
      verifyAnthropicCredential(http, credential, undefined, baseUrl),
  })
  const configDomain = createConfigDomain({
    home,
    logger,
    statusRuntime: { ...options, webConsoleUrl: () => webConsoleUrl },
    localPluginHub,
  })
  const nativeDomain = createNativeDomain({
    version: options.identity.version,
    emitTelemetry: (name, category, payload) => telemetry.emit(name, category, payload),
  })
  const assembled: VolundPorts = {
    identity: options.identity,
    session,
    // §11.3.4 `volund history`：会话档案的只读检视 + 导入/清理；list 复用
    // session port 的 replay 派生，两个入口不会出现两份候选逻辑。
    history: createHistoryPort({
      sessionsDir: join(home, 'sessions'),
      listCandidates: () => session.list(),
    }),
    ui: {
      renderInteractiveApp: (input) =>
        renderInteractiveApp({
          history,
          slashCommandRegistry: slashCommands,
          // r13-G4 (spec 08-session-config.md §8.6.2): `/undo` single-step tool
          // rollback backed by the session backup store.
          // SAG-06 (spec §7.11): previewUndo 驱动 /undo 后的剩余 batch 预览。
          undo: {
            undoStep: (sessionId) => backups.undoStep(sessionId),
            previewUndo: (sessionId) => backups.previewUndoStep(sessionId),
          },
          // SKILLS-MCPS-r1：/skills 与 /mcp 面板控制器（经应用级内核面板收集器）
          skills: appKernel.ui.panel<SkillsPanelController>('skills'),
          mcp: appKernel.ui.panel<McpPanelController>('mcp'),
          // SUBAGENTS-UI-r1：/subagents 运行管理面板（dispatcher 运行注册表）
          subagents: appKernel.ui.panel<SubagentsPanelController>('subagents'),
          // /sessions 删除流：宿主 controller 直删（活动会话先 end 再冷启动并经
          // 激活推送换绑 TUI）；备份/附件清理在 controller.delete 内一并完成。
          sessions: {
            list: () => session.list(),
            delete: (id) => session.delete(id),
          },
          // W-08 对齐：/changes 会话变更面板（BackupStore 背书；含面板内按路径撤销）
          changes: {
            list: (sessionId) => backups.changes(sessionId),
            fileDiff: (sessionId, path) => backups.fileDiff(sessionId, path),
            previewUndo: (sessionId, path) => backups.previewUndoPath(sessionId, path),
            undoPath: (sessionId, path) => backups.undoPath(sessionId, path),
          },
          ...input,
        }),
      renderDirectoryTrustPrompt,
      renderSessionPicker,
    },
    trust,
    // W-08 SAG 条款：工作台写路径的 pre-write 备份源（web.ts 经 ports 消费）。
    backups,
    // SAG-13：subagent 运行注册表面（web Subagents 页 / 移动站运行行 / 网关腿）。
    subagents: subagentsPanelController,
    // §4.4 三档权限模式：current 供 /mode 与欢迎屏显示；set 对新会话生效并热切活动顶层会话。
    // §22 W-07：进程级共享审批队列（TUI/Web 多路订阅；权限链 prompt 源）。
    permissionPrompts,
    askPrompts,
    permissionMode: {
      current: () =>
        activePermissionControl?.get() ?? overridePermissionMode ?? configPermissionMode ?? 'ask',
      set: (mode) => {
        overridePermissionMode = mode
        permissionPolicy.configureMode({ mode })
        activePermissionControl?.set(mode)
        notifyPermissionMode(mode)
      },
      subscribe: (listener) => {
        permissionModeListeners.add(listener)
        return () => permissionModeListeners.delete(listener)
      },
    },
    restore: { restore: (sessionId, restoreOptions) => backups.restore(sessionId, restoreOptions) },
    changes: {
      list: (sessionId, opts) => backups.changes(sessionId, opts),
      fileDiff: (sessionId, path) => backups.fileDiff(sessionId, path),
      previewUndo: (sessionId) => backups.previewUndoStep(sessionId),
      undoStep: (sessionId) => backups.undoStep(sessionId),
    },
    evolution: {
      show: (showOptions) => evolution.audit(showOptions.namespace, showOptions.since),
      rollback: (rollbackOptions) =>
        evolution.rollback(rollbackOptions.namespace, rollbackOptions.to),
      health: async () => {
        const result = await evolution.health()
        return { valid: result.valid, detail: result.detail }
      },
    },
    memory,
    memoryRecall,
    memoryMaintenance,
    memoryTransfer,
    plugin: pluginDomain.legacyPluginPort,
    localPlugins,
    skill: skillPort,
    skillManagement: skillDomain.skillManagementPort,
    mcp: mcpPort,
    mcpManagement: mcpDomain.mcpManagementPort,
    auth: authDomain,
    config: configDomain.port,
    native: nativeDomain,
    telemetry: {
      securityEvent: (name, payload) => telemetry.emit(name, 'security', payload),
      // WEB-EXT-MANAGE-MARKET-r1 MG-16：管理动作采样走通用 emit（自由字符串事件）。
      event: (name, category, payload) => telemetry.emit(name, category, sanitize(payload)),
      summary: () => telemetryStore.summary(),
      export: (target) => telemetryStore.export(target),
      clear: () => telemetryStore.clear(),
      health: () => telemetryStore.health(),
      events: (limit) => telemetryStore.recent(limit),
    },
    confirmation: {
      confirmDangerousNoSandbox: async (sentence) =>
        (await promptLine(`Type "${sentence}" to continue: `)) === sentence,
    },
    /**
     * 进程收尾：插件宿主的 fd3 管道与 MCP stdio/SSE 连接都是 ref 住事件循环的
     * 长驻句柄——不主动关闭，waitUntilExit 之后进程永不退出（此前仅靠
     * process.on('exit') 兜底，而 'exit' 恰恰因这些句柄存在而永远不会触发）。
     * 幂等；单项失败不阻塞其他项（allSettled）。
     */
    async shutdown() {
      await Promise.allSettled([
        localPlugins.deactivateAll(),
        mcpDomain.closeManager(),
        // REM-r1：远程 uplink 是 ref 住事件循环的长驻 WS，一并收尾。
        Promise.resolve(assembled.remoteControl?.close()),
      ])
    },
    /**
     * 记忆自动沉淀（bin.ts 进程收口调用，ADR-0015）：从最后一个活跃会话提炼
     * 长期记忆。条件不满足/模型不可用/守卫否决一律静默——失败绝不拖住退出。
     */
    async consolidateMemory() {
      const runnerNow = lastRunner
      if (!runnerNow || !consolidationModel) return 0
      const transcript = (runnerNow.state.messages ?? []).map((message) => ({
        role: message.role,
        text: messageTextParts(message.content),
      }))
      // Gate 前置：无可沉淀的实质转录（memory list 等非会话命令/短会话）不提示。
      if (
        transcript.length < 2 ||
        transcript.reduce((total, item) => total + item.text.length, 0) < 200
      )
        return 0
      process.stderr.write('· consolidating session memory…\n')
      const env = process.env.VOLUND_MEMORY_AUTO_CONSOLIDATE
      const cwd = runnerNow.state.cwd
      // 现有记忆首行喂给提炼模型防重复（ADR-0015 的查重设计在生产不能空转）。
      const existingSummaries = (
        await Promise.all(
          [
            workspaceMemoryScope(),
            projectMemoryScope(cwd),
            sessionMemoryScope(cwd, runnerNow.state.id),
          ].map((scope) => memory.list(scope)),
        )
      )
        .flat()
        .filter((record) => !record.deletedAt)
        .map((record) => record.content.split('\n', 1)[0]?.trim().slice(0, 120) || record.id)
      const written = await consolidateSessionMemory({
        memory,
        workspaceScope: workspaceMemoryScope(),
        projectScope: projectMemoryScope(cwd),
        model: consolidationModel,
        transcript,
        existingSummaries,
        ...(env === undefined ? {} : { env }),
      })
      if (written > 0) void telemetry.emit('memory.consolidated', 'memory', { written })
      return written
    },
  }
  // §22 W-01：`volund web` 本地控制台端口（server 生命周期随进程信号收尾）；
  // onUrl 回填状态面板的 Web 行（嵌入式自启/显式 web 命令共用）。
  assembled.web = createWebPort(assembled, {
    onUrl: (url) => {
      webConsoleUrl = url
    },
  })
  // REM-r1：远程控制端口（/uplink 反向拨出；远程控制 tab 数据面，
  // [remote] enabled 时由 cli.ts 的 startup 自动拨出）。
  assembled.remoteControl = createRemoteControlPort(assembled)
  return assembled
}
