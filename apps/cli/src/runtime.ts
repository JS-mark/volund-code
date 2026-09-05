import { createHash } from 'node:crypto'
import { constants as fsConstants, existsSync, readFileSync } from 'node:fs'
import {
  access,
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { connect as http2Connect, constants as http2Constants } from 'node:http2'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect, type Socket as NetSocket } from 'node:net'
import { homedir } from 'node:os'
import { basename, delimiter as pathDelimiter, dirname, join, resolve } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { connect as tlsConnect } from 'node:tls'

import {
  createAppKernel,
  createProductionToolPermissionChain,
  createSessionKernel,
  createMemoryStack,
  createSkillDomain,
  registerRuntimeMemoryPrompts,
  createStatusSnapshotAdapter,
  ProductionPermissionSessionPolicy,
  runtimeStatusData,
  SessionController,
} from '@volund/app-runtime'
import type { RunnerFactory } from '@volund/app-runtime'
import { AuthManager, EncryptedCredentialStore } from '@volund/auth'
import { McpOAuthClient, oauthCredentialKey, oauthHeaderKey } from '@volund/auth'
import { loadConfig, loadTomlFile, parseTomlFile } from '@volund/config'
import { SlidingWindowPolicy } from '@volund/context'
import {
  builtinPromptFragment,
  DefaultPromptComposer,
  type PromptFragment,
  EvolutionEngine,
  Runner,
} from '@volund/core'
import type { ContextTunableParam, EvolutionPersistence, RunnerToolPort } from '@volund/core'
import { SandboxService, ToolsService } from '@volund/kernel'
import {
  execSandbox,
  nativeProbes,
  probeSandbox,
  resolveBinary,
  standaloneArtifactDir,
} from '@volund/native-bridge'
import type { SandboxTier } from '@volund/native-bridge'
import type { PermissionSessionMode, PermissionSpec } from '@volund/permission'
import {
  LEGACY_PLUGIN_UNAVAILABLE,
  PluginError,
  PluginManager,
  activateLocalPlugin,
  validateManifest,
  satisfies,
} from '@volund/plugin-runtime'
import type {
  ActivatedLocalPlugin,
  CommandContribution,
  StatusTabContribution,
} from '@volund/plugin-runtime'
import type { HookPipelineSignal } from '@volund/plugin-runtime'
import type {
  EffectiveEnvEntry,
  PluginInstallResult,
  PluginInventory,
  PluginInventoryEntry,
} from '@volund/plugin-sdk'
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
import {
  VolundError,
  isProjectOverrideForbidden,
  productIdentity,
  sanitize,
  type JsonValue,
  type Logger,
} from '@volund/shared'
import { SkillsRuntime, defaultSkillSources } from '@volund/skills-runtime'
import { AttachmentStore, BackupStore, EvolutionStore, PromptLoader } from '@volund/storage'
import { AgentDefinitionRegistry, SubagentDispatcher, untrustedAgentBody } from '@volund/subagent'
import { LocalTelemetrySink, Telemetry, TelemetryLogger, TelemetryStore } from '@volund/telemetry'
import type { NativeBridge } from '@volund/tool-kit'
import { BackgroundShells, builtinToolDomains, MINIMAL_ENV_KEYS } from '@volund/tools'
import type { ToolHookDispatcher, ToolHookOutcome } from '@volund/tools'
import {
  renderDirectoryTrustPrompt,
  renderInteractiveApp,
  renderSessionPicker,
  isCommandListView,
  isCommandTabsView,
  MutableSlashCommandRegistry,
  validateStatusConfigValue,
} from '@volund/ui'
import type {
  InteractivePermissionDecision,
  InteractivePermissionRequest,
  StatusViewModel,
  StatusPanelData,
  McpPanelController,
  SubagentsPanelController,
  SkillsPanelController,
} from '@volund/ui'

import {
  assignConfigValue,
  assertConfigKeyValue,
  deleteConfigValue,
  builtinDisabledFrom,
  disabledNamesFrom,
  updateConfigBuiltinDisabled,
  readConfigFileOrEmpty,
  updateConfigDisabledList,
  writeConfigFile,
} from './config-edit'
import { createHistoryPort } from './history'
import { loadMcpServerConfigs, McpManager, removeMcpServerToml, upsertMcpServerToml } from './mcp'
import { createMemoryTools } from './memory-tools'
import { PermissionRuleStore } from './permissions-store'
import {
  fetchMarketIndex,
  installFromMarket,
  isLocalMarketSource,
  marketInstallRoot,
  normalizePluginName,
  readMarketIntegrity,
  readMarketSource,
  uninstallMarketDir,
  type MarketIndex,
} from './plugin-market'
import { isPluginApproved, LocalPluginStateStore } from './plugin-state'
import type { LocalPluginStateEntry } from './plugin-state'
import type { McpPort } from './ports'
import type { VolundPorts, PluginCompatibilityDiagnostic } from './ports'
import type { AppIdentity } from './shared/app-identity'
import { createSkillTool } from './skill-tool'
import { DirectoryTrustStore } from './trust'

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
  servername: string
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
    throw new Error('proxy_tunnel_aborted')
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
          reject(new Error(`proxy_tunnel_rejected: ${statusLine}`))
        }
      }
      socket.on('data', onData)
    })
    socket.once('error', (cause) => {
      if (settled) return
      settled = true
      reject(new Error(`proxy_tunnel_failed: ${cause.message}`))
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
      ? openProxyTunnel(proxyUrl, url, input.signal).then((tunneled) => {
          // ALPN 列 h2 优先、http/1.1 兜底：抓包代理（mitmproxy/Charles）通常只讲 h1，
          // h2 协商失败时 NodeHttpPort.request 回退 requestHttp1，仍经同一隧道。
          const tlsSocket = tlsConnect({
            socket: tunneled,
            ...proxyTlsOptions(url.hostname),
            ALPNProtocols: ['h2', 'http/1.1'],
          })
          return new Promise<NetSocket>((res, rej) => {
            tlsSocket.once('secureConnect', () => {
              // ALPN 未选 h2 → 目标/代理只讲 h1，立即拒绝让上层回退 requestHttp1。
              // 必须销毁 tlsSocket + 底层隧道 socket，否则代理连接不释放、close() 挂起。
              if ((tlsSocket.alpnProtocol ?? 'http/1.1') !== 'h2') {
                tlsSocket.destroy()
                tunneled.destroy()
                rej(new Error('proxy_alpn_not_h2'))
                return
              }
              res(tlsSocket)
            })
            tlsSocket.once('error', rej)
          })
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
        if (byte === 3) return finish(new Error('Credential input was cancelled'))
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
export function resolveModelAlias(
  raw: string,
  aliases: Record<string, { provider: string; model: string }>,
  activeProvider = 'anthropic',
): { model: string } | { mismatch: string } | undefined {
  const entry = aliases[raw.replace(new RegExp(`^${activeProvider}/`), '')]
  if (!entry) return undefined
  if (entry.provider !== activeProvider) return { mismatch: entry.provider }
  return { model: entry.model.replace(new RegExp(`^${activeProvider}/`), '') }
}

/**
 * [preferences] language 的回复语言强制片段（§6b）：显式配置才注册——不配则模型
 * 跟随输入语言，中英混杂；配置后即使输入是英文也按配置语言回复。
 */
export function languagePromptFragment(language: string): PromptFragment {
  return {
    id: 'preferences:language',
    source: 'preferences:language',
    priority: 900,
    text: `## Language\nAlways respond in ${language}, regardless of the language of the user's message, tool output, or any other content. Keep code, identifiers, and file paths as-is.`,
  }
}

export interface ProductionOptions {
  volundHome?: string
  identity: Readonly<AppIdentity>
  model?: string
}

function diagnosticRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
const LEGACY_PLUGIN_NAME = /^volund-plugin-[a-z0-9][a-z0-9._-]{0,127}$/
function assertLegacyPluginName(name: string): void {
  if (!LEGACY_PLUGIN_NAME.test(name))
    throw new PluginError('plugin_path_escape', 'invalid plugin target')
}

async function readContainedPluginDiagnostic(
  pluginRoot: string,
  name: string,
  storedVersion: string,
  volundVersion: string,
): Promise<{
  version: string
  permissions: readonly string[]
  compatibility: PluginCompatibilityDiagnostic
}> {
  const manifestLimit = 1024 * 1024
  const permissionLimit = 64
  const permissionLengthLimit = 128
  const safeStoredVersion =
    storedVersion.length <= 128 && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(storedVersion)
      ? storedVersion
      : 'unknown'
  const invalid = (detail: string) => ({
    version: safeStoredVersion,
    permissions: [] as readonly string[],
    compatibility: { status: 'invalid' as const, detail },
  })
  assertLegacyPluginName(name)
  let manifest: unknown
  try {
    const canonicalRoot = await realpath(pluginRoot)
    const expectedDirectory = join(canonicalRoot, name)
    const canonicalDirectory = await realpath(expectedDirectory)
    if (canonicalDirectory !== expectedDirectory)
      return invalid('Plugin directory is not canonical; legacy activation remains unavailable.')
    const expectedManifest = join(canonicalDirectory, 'manifest.json')
    const canonicalManifest = await realpath(expectedManifest)
    if (canonicalManifest !== expectedManifest)
      return invalid('Manifest path is not canonical; legacy activation remains unavailable.')
    const handle = await open(canonicalManifest, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > manifestLimit)
        return invalid(
          'Manifest metadata exceeds diagnostic limits; legacy activation remains unavailable.',
        )
      const buffer = Buffer.alloc(manifestLimit + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > manifestLimit)
        return invalid(
          'Manifest metadata exceeds diagnostic limits; legacy activation remains unavailable.',
        )
      manifest = JSON.parse(buffer.toString('utf8', 0, bytesRead))
    } finally {
      await handle.close()
    }
  } catch {
    return invalid('Manifest metadata is unreadable; legacy activation remains unavailable.')
  }
  if (!diagnosticRecord(manifest))
    return invalid('Manifest metadata is invalid; legacy activation remains unavailable.')
  const permissionsRecord = diagnosticRecord(manifest.permissions)
    ? manifest.permissions
    : undefined
  const rawPermissions = permissionsRecord?.volund
  if (Array.isArray(rawPermissions) && rawPermissions.length > permissionLimit)
    return invalid(
      'Manifest permissions exceed diagnostic limits; legacy activation remains unavailable.',
    )
  const permissions: string[] = []
  if (Array.isArray(rawPermissions)) {
    for (const permission of rawPermissions) {
      if (
        typeof permission !== 'string' ||
        permission.length > permissionLengthLimit ||
        !/^[a-z][a-z0-9.:-]*$/.test(permission)
      )
        return invalid('Manifest permissions are invalid; legacy activation remains unavailable.')
      permissions.push(permission)
    }
  }
  const engines = diagnosticRecord(manifest.engines) ? manifest.engines : undefined
  const range =
    typeof engines?.volund === 'string' && engines.volund.length <= 256 ? engines.volund : undefined
  const compatibility: PluginCompatibilityDiagnostic = range
    ? satisfies(volundVersion, range)
      ? {
          status: 'compatible',
          detail: `Declared legacy volund engine range is compatible with ${volundVersion}.`,
        }
      : {
          status: 'incompatible',
          detail: `Declared legacy volund engine range is incompatible with ${volundVersion}; legacy activation remains unavailable.`,
        }
    : {
        status: 'invalid',
        detail: 'Manifest engine metadata is invalid; legacy activation remains unavailable.',
      }
  return {
    version:
      typeof manifest.version === 'string' &&
      manifest.version.length <= 128 &&
      /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(manifest.version)
        ? manifest.version
        : safeStoredVersion,
    permissions,
    compatibility,
  }
}

/**
 * Resolve the legacy context-tuning compatibility switch for a production Runner.
 * A missing file is the documented default-off case. Unreadable, invalid, or non-boolean
 * configuration fails closed by propagating the configuration error before tuning is read.
 * Only an own-property boolean `true` is authority; an inherited/prototype value never counts.
 */
export async function loadProductionContextTuning(options: {
  readonly home: string
  readonly persistence: EvolutionPersistence
  readonly logger: Pick<Logger, 'warn'>
}): Promise<{
  readonly config: Record<string, JsonValue>
  readonly values: Record<ContextTunableParam, number>
}> {
  let enabled = false
  let config: Record<string, JsonValue> = {}
  try {
    config = await loadTomlFile(join(options.home, 'config.toml'), {
      onWarning: (message) => options.logger.warn(message),
    })
    const section = config.evolution
    enabled = Boolean(
      section &&
      typeof section === 'object' &&
      !Array.isArray(section) &&
      Object.hasOwn(section, 'enabled') &&
      section.enabled === true,
    )
  } catch (error) {
    // A missing file means the documented default-off posture. Syntax, type, and I/O
    // failures are configuration failures and must stop Runner construction (§8.3/C.1).
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return {
    config,
    values: await new EvolutionEngine(options.persistence, { enabled }).values(),
  }
}

/**
 * 插件命令贡献 → 斜杠命令注册表（UI 经 subscribe 热更新）。handler 在插件沙箱里
 * 经桥执行，返回字符串即作为系统消息进 transcript。撞内置名 / 撞已注册命令时
 * warn + 跳过该命令（不拖累插件其余贡献）；返回注销函数集（deactivate 时摘除）。
 */
export function registerPluginCommands(
  registry: MutableSlashCommandRegistry,
  plugin: string,
  commands: readonly CommandContribution[],
  onWarn: (message: string) => void,
): Array<() => void> {
  const unsubscribes: Array<() => void> = []
  for (const command of commands) {
    try {
      unsubscribes.push(
        registry.register(
          {
            name: command.name,
            description: command.description || `/${command.name} (plugin command)`,
            ...(command.order !== undefined ? { order: command.order } : {}),
            run: async ({ args }) => {
              const result = await command.run(args)
              if (typeof result === 'string' && result) return result
              // 列表 / 页签视图（纯数据描述符）原样透传：UI 渲染成可搜索面板
              if (isCommandListView(result)) return result
              if (isCommandTabsView(result)) return result
              return undefined
            },
          },
          { kind: 'plugin', plugin },
        ),
      )
    } catch (error) {
      onWarn(
        `Plugin command /${command.name} from ${plugin} not registered: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  return unsubscribes
}

/**
 * [env] 值的前置解析（applyEnv 写入 process.env 之前）：
 * - 开头 `~` / `~/...` → 用户主目录；
 * - `${VAR}` 与裸 `$VAR` → source 里已有的环境变量。**只有名字已设置才展开**：
 *   未设置的引用一律保持字面（值里的 `$` 常见于凭据/正则，撞不到真实环境变量名
 *   就不会被误伤）；`${VAR}` 形式未设置时额外回调 onUnresolved（显式意图，值得
 *   fail-visible），裸 `$VAR` 未设置则静默保持字面。
 * 单趟展开不递归；同段 key 互引用不支持——source 取应用前的环境快照。
 */
export function expandEnvValue(
  value: string,
  source: Record<string, string | undefined>,
  onUnresolved?: (name: string) => void,
): string {
  const tildeExpanded =
    value === '~' ? homedir() : value.startsWith('~/') ? `${homedir()}${value.slice(1)}` : value
  return tildeExpanded.replaceAll(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (raw, braced: string | undefined, bare: string | undefined) => {
      const name = (braced ?? bare)!
      const resolved = source[name]
      if (resolved === undefined) {
        if (braced) onUnresolved?.(name)
        return raw
      }
      return resolved
    },
  )
}

/**
 * [env] 段的生效快照（/env 内置插件的数据源）：每次调用重读用户级 config.toml，
 * 与当前 process.env 对比出 effective / pending / overridden；sandboxPassthrough
 * 标出该名字是否经最小继承集（PATH/HOME/LANG/TZ）或 [tools] pass_through_env
 * 白名单进入沙箱。缺配置文件 → 空列表；类型错按 C.1 传播 config_invalid。
 *
 * 配置值先经前置解析（`~` / `${VAR}`，见 expandEnvValue）再与 process.env 比较：
 * `applied`（applyEnv 记录的应用值）在本进程跑过 applyEnv 时是精确基准；否则
 * （一次性子命令）按「扣除本段 key 的当前环境」就地展开，展示"应用后会是这个值"。
 */
export async function readEffectiveEnv(
  home: string,
  applied?: Record<string, string>,
): Promise<EffectiveEnvEntry[]> {
  let config: Record<string, JsonValue> = {}
  try {
    config = await loadTomlFile(join(home, 'config.toml'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const envSection =
    config.env && typeof config.env === 'object' && !Array.isArray(config.env)
      ? (config.env as Record<string, JsonValue>)
      : {}
  const toolsSection =
    config.tools && typeof config.tools === 'object' && !Array.isArray(config.tools)
      ? (config.tools as Record<string, JsonValue>)
      : {}
  const passThrough = new Set(MINIMAL_ENV_KEYS)
  if (Array.isArray(toolsSection.pass_through_env))
    for (const name of toolsSection.pass_through_env)
      if (typeof name === 'string' && name) passThrough.add(name)
  // 就地展开的基准要扣除本段 key：applyEnv 跑过的进程里这些名字的值来自配置
  // 本身，拿它们当引用基准会把自引用误判成已解析。
  const basis = { ...process.env }
  for (const key of Object.keys(envSection)) delete basis[key]
  const entries: EffectiveEnvEntry[] = []
  for (const [key, value] of Object.entries(envSection)) {
    if (typeof value !== 'string') continue
    const expected = applied?.[key] ?? expandEnvValue(value, basis)
    const actual = process.env[key] ?? null
    entries.push({
      key,
      configured: expected,
      actual,
      status: actual === null ? 'pending' : actual === expected ? 'effective' : 'overridden',
      sandboxPassthrough: passThrough.has(key),
    })
  }
  return entries
}

/**
 * 内置插件根目录（随产物分发的 apps/cli/plugins/<name>/）。与 native 资产同一
 * 解析惯例（resolver.ts standaloneArtifactDir）：standalone 先看
 * VOLUND_STANDALONE_ASSET_DIR，否则取产物旁——bun --compile 后是 execPath 旁，
 * dist 单文件布局是 dist/plugins/，源码布局（vitest）是 apps/cli/plugins/。
 * 取第一个存在的候选，不存在 → undefined（无内置插件）。
 */
export function builtinPluginRoot(): string | undefined {
  const here = standaloneArtifactDir(import.meta.url, process.execPath)
  const candidates = [
    process.env.VOLUND_STANDALONE_ASSET_DIR
      ? join(process.env.VOLUND_STANDALONE_ASSET_DIR, 'plugins')
      : undefined,
    join(here, 'plugins'),
    join(here, '..', 'plugins'),
  ]
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate
  return undefined
}

/**
 * SM-08b：收集插件捆绑 skills 目录（`<pluginDir>/skills/`，随插件信任）。
 * builtin 无条件收录（产物自带，与二进制同信任级）；dev/market 以
 * plugin-state.v2 的 enabled 为门——禁用的插件不进 skills 发现面。
 */
export async function collectPluginSkillDirs(input: {
  builtinRoot: string | undefined
  stateEntries: readonly { dir: string; enabled: boolean }[]
}): Promise<string[]> {
  const dirs: string[] = []
  if (input.builtinRoot) {
    try {
      for (const entry of await readdir(input.builtinRoot, { withFileTypes: true }))
        if (entry.isDirectory()) dirs.push(join(input.builtinRoot, entry.name, 'skills'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  for (const entry of input.stateEntries) if (entry.enabled) dirs.push(join(entry.dir, 'skills'))
  return dirs
}

/**
 * Bash 工具的生产 native 桥（spec 04-tools-permissions.md §4.3.1 / r13-I11）：
 * 把工具算好的最小 env（PATH/HOME/LANG/TZ + [tools] pass_through_env 白名单，
 * 值可含 [env] 段写入 process.env 的配置）透传进 volund-sandbox——Rust 侧
 * env_clear 后只注入 permissions.env.read 白名单内的名字，宿主其余环境不进沙箱。
 * `env` 绝不与宿主全量环境合并（tool-kit NativeBridge 契约）。
 */
export function createSandboxNativeBridge(options: {
  readonly cwd: () => string
  readonly onViolation: (input: { tier: SandboxTier; reason: string }) => Promise<void>
}): NativeBridge {
  return {
    async execute(command, args, signal, env) {
      const cwd = options.cwd()
      const result = await execSandbox(
        {
          command: [command, ...args].join(' '),
          cwd,
          permissions: {
            fs: { read: [cwd], write: [cwd] },
            net: false,
            env: { read: Object.keys(env ?? {}) },
          },
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
  const pluginRoot = join(home, 'plugins')
  const plugins = new PluginManager(pluginRoot, options.identity.version, async () => false)
  const pluginsReady = plugins.init()
  void pluginsReady.catch(() => undefined)
  // 唯一的本地插件 v2 生命周期状态源。legacy plugins/plugins.json 继续 deny-only，
  // 不参与安装/批准/启用/装载决策。
  const localPluginState = new LocalPluginStateStore(home)
  const localPluginStateReady = localPluginState.init()
  void localPluginStateReady.catch(() => undefined)
  // PLUGIN-STATUS-UI-r1 / PLUGIN-MANAGER-r1 本地插件路径：内置（apps/cli/plugins/，
  // 随产物分发）、dev（~/.volund/plugins-dev + VOLUND_DEV_PLUGINS）、市场
  // （[plugins] market 下载到 ~/.volund/plugins/<name>/）三个发现源、同一条链路——
  // 经 volund-sandbox --run-plugin 子进程激活，代码全程不出沙箱；主进程只见到经
  // 权限 guard 的桥方法。贡献的 /status 页签汇入 runtimeStatusData。
  // legacy plugins/plugins.json 继续 deny-only；本地三源只由同级
  // plugin-state.v2.json 决定 approved/enabled，绝不从安装目录推断为可执行。
  interface LoadedPluginEntry {
    readonly source: 'builtin' | 'dev' | 'market'
    readonly name: string
    readonly version: string
    readonly dir: string
    readonly handle: ActivatedLocalPlugin
    readonly unsubscribes: readonly (() => void)[]
  }
  const loadedPluginEntries: LoadedPluginEntry[] = []
  // applyEnv 应用过的 [env] 键值（前置解析后）：readEffectiveEnv 的精确比较基准，
  // 保证 /env 的 effective 判定与启动时实际写入 process.env 的值一致。
  let appliedEnvEntries: Record<string, string> | undefined
  // 插件 render 回调里 volund.session.getUsage() 读到的值：最近一次 /status 组装的
  // 会话用量（同一轮 refresh 内先算 usage 再调 render，数据同源）。
  let lastSessionUsage: StatusPanelData['usage']
  const localPluginHub = {
    get tabs(): readonly StatusTabContribution[] {
      return loadedPluginEntries.flatMap((entry) => [...entry.handle.statusTabs])
    },
    onUsage(usage: StatusPanelData['usage']): void {
      lastSessionUsage = usage
    },
  }
  // 市场索引缓存（/plugins 反复打开不重复拉取；install/uninstall 后失效）。
  let marketIndexCache: { source: string; fetchedAt: number; index: MarketIndex } | undefined
  const MARKET_INDEX_TTL_MS = 60_000
  // 桥 RPC 10s 超时（plugin_host.mjs）：安装整体 deadline 控制在 9s 内，
  // 保证宿主先给出明确结果，而不是插件侧先报 bridge call timed out。
  const MARKET_INSTALL_DEADLINE_MS = 9_000
  async function cachedMarketIndex(
    source: string,
    fresh = false,
    signal?: AbortSignal,
  ): Promise<MarketIndex> {
    if (
      !fresh &&
      marketIndexCache &&
      marketIndexCache.source === source &&
      Date.now() - marketIndexCache.fetchedAt < MARKET_INDEX_TTL_MS
    )
      return marketIndexCache.index
    const index = await fetchMarketIndex(source, signal)
    marketIndexCache = { source, fetchedAt: Date.now(), index }
    return index
  }
  async function activateLocal(
    dir: string,
    source: LoadedPluginEntry['source'],
    integrity?: Record<string, string>,
  ) {
    const resolved = resolve(dir)
    const manifest = validateManifest(
      JSON.parse(await readFile(join(resolved, 'manifest.json'), 'utf8')),
      options.identity.version,
    )
    const lifecycle = await localPluginState.discover(manifest, source, resolved)
    if (!isPluginApproved(lifecycle))
      throw new PluginError(
        'plugin_approval_required',
        `${manifest.name} requires approval for ${manifest.version} / ${lifecycle.permissionHash}`,
      )
    if (!lifecycle.enabled)
      throw new PluginError('plugin_disabled', `${manifest.name} is installed but disabled`)
    const activated = await activateLocalPlugin({
      dir: resolved,
      volundVersion: options.identity.version,
      dataDirRoot: join(home, source === 'market' ? 'plugins-data' : 'plugins-dev-data'),
      ...(integrity ? { integrity } : {}),
      services: {
        log: (level, message) => void telemetry.emit('plugin.log', 'plugin', { level, message }),
        getSessionUsage: () =>
          lastSessionUsage
            ? {
                inputTokens: lastSessionUsage.tokens.input,
                outputTokens: lastSessionUsage.tokens.output,
                cost: lastSessionUsage.costUSD,
              }
            : null,
        // /env 等内置插件的数据源：宿主侧重读 config.toml [env] 段并与
        // process.env 对比（沙箱内读不到主进程环境）。
        getEffectiveEnv: () => readEffectiveEnv(home, appliedEnvEntries),
        // /plugins 内置插件的数据源与动作（宿主侧；沙箱内无网络）。
        listPlugins: () => pluginInventory(),
        inspectPlugin: (name: string) => inspectPlugin(name),
        installMarketPlugin: (name: string) => installMarketPlugin(name),
        approvePlugin: (name: string, hash: string) => approvePlugin(name, hash),
        enablePlugin: (name: string) => enablePlugin(name),
        disablePlugin: (name: string) => disablePlugin(name),
        uninstallMarketPlugin: (name: string) => uninstallMarketPlugin(name),
      },
    })
    loadedPluginEntries.push({
      source,
      name: activated.manifest.name,
      version: activated.manifest.version,
      dir: resolved,
      handle: activated,
      // 插件贡献的斜杠命令进 MutableSlashCommandRegistry（UI 经 subscribe 热更新）。
      unsubscribes: registerPluginCommands(
        slashCommands,
        activated.manifest.name,
        activated.commands,
        (message) => logger.warn(message),
      ),
    })
    return { name: activated.manifest.name, statusTabs: activated.statusTabs.length }
  }
  /** 停用并摘除单个已装载插件（uninstall / 同名重装换新版时用）。 */
  async function unloadPlugin(name: string): Promise<LoadedPluginEntry | undefined> {
    const index = loadedPluginEntries.findIndex((entry) => entry.name === name)
    if (index < 0) return undefined
    const [entry] = loadedPluginEntries.splice(index, 1)
    for (const unsubscribe of entry?.unsubscribes || []) unsubscribe()
    await entry?.handle?.deactivate()
    // H2：对每个活会话内核摘除该插件的贡献工具（下会话自然不再注册）。
    if (entry) for (const tools of liveToolServices) tools.unregisterPlugin(entry.name)
    return entry
  }
  async function inventoryEntry(entry: LocalPluginStateEntry): Promise<PluginInventoryEntry> {
    const loaded = loadedPluginEntries.find((candidate) => candidate.name === entry.name)
    let permissions: PluginInventoryEntry['permissions']
    try {
      permissions = validateManifest(
        JSON.parse(await readFile(join(entry.dir, 'manifest.json'), 'utf8')),
        options.identity.version,
      ).permissions
    } catch {
      permissions = undefined
    }
    return {
      name: entry.name,
      version: entry.version,
      dir: entry.dir,
      source: entry.source,
      commands: loaded?.handle.commands.length ?? 0,
      statusTabs: loaded?.handle.statusTabs.length ?? 0,
      lifecycle: {
        permissionHash: entry.permissionHash,
        approved: isPluginApproved(entry),
        enabled: entry.enabled,
        loaded: Boolean(loaded),
      },
      ...(permissions ? { permissions } : {}),
    }
  }
  async function inventorySnapshot(
    source: LoadedPluginEntry['source'],
  ): Promise<PluginInventoryEntry[]> {
    const state = await localPluginState.list()
    return Promise.all(
      state.filter((entry) => entry.source === source).map((entry) => inventoryEntry(entry)),
    )
  }
  async function inspectPlugin(input: string): Promise<PluginInventoryEntry> {
    const name = normalizePluginName(input)
    const current = await localPluginState.get(name)
    if (!current) throw new PluginError('plugin_not_installed', name)
    const manifest = validateManifest(
      JSON.parse(await readFile(join(current.dir, 'manifest.json'), 'utf8')),
      options.identity.version,
    )
    return inventoryEntry(await localPluginState.discover(manifest, current.source, current.dir))
  }
  /** volund.plugins.list 的宿主实现：三源快照 + 市场索引（未配置/失败给 error）。 */
  async function pluginInventory(): Promise<PluginInventory> {
    let registry: PluginInventory['market']['registry']
    try {
      const source = await readMarketSource(home)
      if (!source)
        registry = {
          error:
            'no market configured — add `[plugins] market = "https://…/index.json"` to ~/.volund/config.toml',
        }
      else {
        const index = await cachedMarketIndex(source)
        registry = {
          source,
          plugins: index.plugins.map(({ name, version, description, publisher }) => ({
            name,
            version,
            ...(description ? { description } : {}),
            ...(publisher ? { publisher } : {}),
          })),
        }
      }
    } catch (error) {
      registry = { error: error instanceof Error ? error.message : String(error) }
    }
    return {
      domains: localPlugins ? await localPlugins.builtinDomains() : [],
      builtin: await inventorySnapshot('builtin'),
      dev: await inventorySnapshot('dev'),
      market: { installed: await inventorySnapshot('market'), registry },
    }
  }
  /** volund.plugins.install：只下载、校验、登记。批准与启用必须由后续显式命令完成。 */
  async function installMarketPlugin(input: string): Promise<PluginInstallResult> {
    const name = normalizePluginName(input)
    const source = await readMarketSource(home)
    if (!source)
      throw new Error('no market configured — set [plugins] market in ~/.volund/config.toml')
    if (!isLocalMarketSource(source))
      throw new PluginError(
        'plugin_registry_signature_required',
        'remote market installs require a verified publisher signature and trusted key',
      )
    // 整个安装（索引 + 全部文件）共享一个 9s deadline（见 MARKET_INSTALL_DEADLINE_MS）。
    const deadline = AbortSignal.timeout(MARKET_INSTALL_DEADLINE_MS)
    const index = await cachedMarketIndex(source, true, deadline)
    const entry = index.plugins.find((candidate) => candidate.name === name)
    if (!entry) throw new Error(`${name} not found in market index (${source})`)
    // 同名已装载（旧版本）先停用；换新版后必须重新批准，绝不自动重启。
    await unloadPlugin(name)
    const installed = await installFromMarket({
      home,
      source,
      entry,
      volundVersion: options.identity.version,
      signal: deadline,
    })
    const lifecycle = await localPluginState.discover(installed.manifest, 'market', installed.dir)
    marketIndexCache = undefined
    void telemetry.emit('plugin.market_installed', 'plugin', {
      name,
      version: installed.version,
    })
    return {
      name: installed.name,
      version: installed.version,
      dir: installed.dir,
      permissionHash: lifecycle.permissionHash,
      approvalRequired: true,
      permissions: installed.manifest.permissions,
    }
  }
  async function approvePlugin(input: string, expectedHash: string): Promise<PluginInventoryEntry> {
    const inspected = await inspectPlugin(input)
    const approved = await localPluginState.approve(inspected.name, expectedHash)
    return inventoryEntry(approved)
  }
  async function enablePlugin(input: string): Promise<PluginInventoryEntry> {
    const inspected = await inspectPlugin(input)
    const enabled = await localPluginState.setEnabled(inspected.name, true)
    if (!loadedPluginEntries.some((entry) => entry.name === enabled.name))
      await activateLocal(
        enabled.dir,
        enabled.source,
        enabled.source === 'market' ? await readMarketIntegrity(enabled.dir) : undefined,
      )
    return inventoryEntry((await localPluginState.get(enabled.name)) ?? enabled)
  }
  async function disablePlugin(input: string): Promise<PluginInventoryEntry> {
    const inspected = await inspectPlugin(input)
    await unloadPlugin(inspected.name)
    return inventoryEntry(await localPluginState.setEnabled(inspected.name, false))
  }
  /**
   * volund.plugins.uninstall / 端口卸载的宿主实现：停用（热——命令与页签当场
   * 摘除）+ 删除 ~/.volund/plugins/<name>/。仅市场插件可卸载：内置随产物分发、
   * dev 目录归开发者管理，命中这两类时给出明确拒绝而不是裸 plugin_not_installed。
   */
  async function uninstallMarketPlugin(input: string): Promise<{ name: string }> {
    const name = normalizePluginName(input)
    const state = await localPluginState.get(name)
    const loaded = loadedPluginEntries.find((entry) => entry.name === name)
    const source = loaded?.source ?? state?.source
    if (source === 'builtin')
      throw new Error(
        `${name} is a builtin plugin shipped with the ${productIdentity.shortName} artifact; it cannot be uninstalled`,
      )
    if (source === 'dev')
      throw new Error(
        `${name} is a dev plugin (from ~/.volund/plugins-dev/ or VOLUND_DEV_PLUGINS); remove its directory and restart the REPL to unload it`,
      )
    await unloadPlugin(name)
    await uninstallMarketDir(home, name)
    await localPluginState.remove(name)
    marketIndexCache = undefined
    return { name }
  }
  // 本地插件装载端口（PLUGIN-STATUS-UI-r1 / PLUGIN-MANAGER-r1）：内置插件发现源是
  // 产物自带的 apps/cli/plugins/<name>/；dev 插件发现源是正式约定目录
  // ~/.volund/plugins-dev/<name>/ 自动发现（含 manifest.json 的子目录才激活，单个
  // 失败不阻塞启动），VOLUND_DEV_PLUGINS=<dir>[,<dir>...] 仅用于仓库内插件开发的
  // 额外路径；市场插件装在 ~/.volund/plugins/<name>/（带 volund-market.json 完整性
  // 映射，激活期重验）。数据目录在 ~/.volund/plugins-dev-data/<name>/（市场插件为
  // ~/.volund/plugins-data/<name>/），与插件代码目录分离（沙箱内代码只读）。
  const localPlugins = {
    async activateLocal(dir: string) {
      return activateLocal(dir, 'dev')
    },
    async loadDevPlugins(extraDirs: readonly string[] = []) {
      const candidates: string[] = []
      // 约定目录：plugins-dev 下每个含 manifest.json 的子目录
      try {
        for (const entry of await readdir(join(home, 'plugins-dev'), { withFileTypes: true }))
          if (entry.isDirectory() || entry.isSymbolicLink())
            candidates.push(join(home, 'plugins-dev', entry.name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      candidates.push(...extraDirs)
      return this.loadLocalPluginsFrom(candidates, 'dev')
    },
    /**
     * 内置插件（apps/cli/plugins/<name>/，随产物分发）：与 dev 插件同一条
     * 沙箱/桥链路，差异仅在目录来源。内置插件只信产物本身，manifest 校验、
     * bundle 完整性检查、权限 guard 一样不少。
     */
    /** F1：第一方工具域清单（enabled = 未列入 [plugins] builtin_disabled）。 */
    async builtinDomains() {
      await ensureBuiltinToolsConfig()
      return builtinToolDomains().map((domain) => ({
        id: domain.id,
        label: domain.label,
        description: domain.description,
        enabled: !builtinToolsDisabled.has(domain.id),
      }))
    },
    async setBuiltinDomain(id: string, enabled: boolean) {
      if (!/^volund\.(core-tools|exec|orchestration)$/.test(id))
        throw new Error(`Unknown builtin tool domain: ${id}`)
      await updateConfigBuiltinDisabled({ home, domain: id, disable: !enabled })
      if (enabled) builtinToolsDisabled.delete(id)
      else builtinToolsDisabled.add(id)
    },
    async loadBuiltinPlugins() {
      const root = builtinPluginRoot()
      if (!root) return { loaded: [], failed: [] }
      const candidates: string[] = []
      try {
        for (const entry of await readdir(root, { withFileTypes: true }))
          if (entry.isDirectory()) candidates.push(join(root, entry.name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return this.loadLocalPluginsFrom(candidates, 'builtin')
    },
    /**
     * 市场插件：~/.volund/plugins/<name>/ 自动发现（dot 目录
     * 跳过——staging 与 legacy 状态文件不在此列，但防御性排除；无 manifest.json
     * 的目录跳过）。发现只登记；approved + enabled 后才逐文件重验并激活。
     */
    async loadMarketPlugins() {
      const root = marketInstallRoot(home)
      const candidates: string[] = []
      try {
        for (const entry of await readdir(root, { withFileTypes: true }))
          if (
            (entry.isDirectory() || entry.isSymbolicLink()) &&
            !entry.name.startsWith('.') &&
            entry.name !== 'plugins.json'
          )
            candidates.push(join(root, entry.name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const loaded: { name: string; statusTabs: number }[] = []
      const failed: { dir: string; error: string }[] = []
      for (const candidate of candidates) {
        try {
          await access(join(candidate, 'manifest.json'))
        } catch {
          continue // 无 manifest 的目录不视为插件（legacy 状态文件等）
        }
        try {
          const manifest = validateManifest(
            JSON.parse(await readFile(join(candidate, 'manifest.json'), 'utf8')),
            options.identity.version,
          )
          const lifecycle = await localPluginState.discover(manifest, 'market', resolve(candidate))
          if (!isPluginApproved(lifecycle) || !lifecycle.enabled) continue
          loaded.push(
            await activateLocal(candidate, 'market', await readMarketIntegrity(candidate)),
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          failed.push({ dir: candidate, error: message })
          void telemetry.emit('plugin.local_load_failed', 'plugin', {
            dir: basename(candidate),
            error: message,
          })
        }
      }
      return { loaded, failed }
    },
    async inspectPlugin(input: string) {
      return inspectPlugin(input)
    },
    async approvePlugin(input: string, hash: string) {
      return approvePlugin(input, hash)
    },
    async enablePlugin(input: string) {
      return enablePlugin(input)
    },
    async disablePlugin(input: string) {
      return disablePlugin(input)
    },
    async loadLocalPluginsFrom(candidates: readonly string[], source: LoadedPluginEntry['source']) {
      const loaded: { name: string; statusTabs: number }[] = []
      const failed: { dir: string; error: string }[] = []
      for (const candidate of candidates) {
        try {
          await access(join(candidate, 'manifest.json'))
        } catch {
          continue // 无 manifest 的目录不视为插件
        }
        try {
          loaded.push(await activateLocal(candidate, source))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          failed.push({ dir: candidate, error: message })
          void telemetry.emit('plugin.local_load_failed', 'plugin', {
            dir: basename(candidate),
            error: message,
          })
        }
      }
      return { loaded, failed }
    },
    /**
     * 卸载市场插件（端口面，管理命令/未来 CLI 子命令用；桥上经
     * volund.plugins.uninstall 走同一实现）：热生效——停用、摘命令与页签、
     * 删目录，当前会话立即可见。内置/dev 插件明确拒绝（见实现内说明）。
     */
    async uninstallMarketPlugin(input: string) {
      return uninstallMarketPlugin(input)
    },
    async deactivateAll() {
      const entries = loadedPluginEntries.splice(0)
      await Promise.allSettled(
        entries.map(async (entry) => {
          for (const unsubscribe of entry.unsubscribes) unsubscribe()
          await entry.handle.deactivate()
        }),
      )
    },
  }
  // P1-04b：Memory 四件套的单一组合点在 app-runtime（createMemoryStack）。
  const memoryStack = createMemoryStack(home)
  const memory = memoryStack.memory
  const memoryRecall = memoryStack.memoryRecall
  const memoryMaintenance = memoryStack.memoryMaintenance
  const memoryTransfer = memoryStack.memoryTransfer
  const slashCommands = new MutableSlashCommandRegistry()
  let cachedPassphrase: string | undefined
  const passphrase = async () => {
    if (cachedPassphrase) return cachedPassphrase
    const value = await promptSecret('Credential-store passphrase: ')
    if (!value) throw new Error('A credential-store passphrase is required')
    cachedPassphrase = value
    return value
  }
  const encrypted = new EncryptedCredentialStore(
    join(home, 'credentials.enc'),
    passphrase,
    join(home, 'auth.state.json'),
  )
  /**
   * 用户级 config.toml 的 [auth] 段（§8.4 Layer 4 / skipAuth）。
   * 项目级 config 到不了这里：§8.3.1 数据流向门把整段标为 forbidden。
   */
  const readAuthSection = async (): Promise<Record<string, JsonValue>> => {
    let config: Record<string, JsonValue>
    try {
      config = await loadTomlFile(join(home, 'config.toml'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
    const section = config.auth
    return section && typeof section === 'object' && !Array.isArray(section) ? section : {}
  }
  /** login 的 verify 请求要打向配置的网关（§8.3 provider.<name>.baseUrl），否则网关 key 在官方端点上必然 4xx。 */
  const readAnthropicBaseUrl = async (): Promise<string | undefined> => {
    let config: Record<string, JsonValue>
    try {
      config = await loadTomlFile(join(home, 'config.toml'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const provider = config.provider
    const entry =
      provider && typeof provider === 'object' && !Array.isArray(provider)
        ? (provider as Record<string, JsonValue>).anthropic
        : undefined
    const baseUrl =
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry as Record<string, JsonValue>).baseUrl
        : undefined
    return typeof baseUrl === 'string' && baseUrl ? baseUrl : undefined
  }
  const auth = new AuthManager({
    encrypted,
    env: process.env,
    telemetry,
    configKeys: async (provider) => {
      const value = (await readAuthSection())[`${provider}_api_key`]
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
  // 启动期一次性装载的用户级 config 会话默认值：[subagent] 限制与 [models.aliases]。
  // config 是异步读的；dispatcher 在装载完成后整体替换（启动期必然没有在跑的 subagent）。
  let configSubagentLimits: {
    maxDepth?: number
    maxConcurrency?: number
    defaultBudget?: { costUSDMax?: number; tokenMax?: number; timeMsMax?: number }
  } = {}
  let configModelAliases: Record<string, { provider: string; model: string }> = {}
  void readConfigFileOrEmpty(join(home, 'config.toml'))
    .then((config) => {
      const permissions = config.permissions
      if (permissions && typeof permissions === 'object' && !Array.isArray(permissions)) {
        const mode = (permissions as Record<string, JsonValue>).mode
        if (mode === 'ask' || mode === 'auto' || mode === 'full') {
          configPermissionMode = mode
          if (!overridePermissionMode) permissionPolicy.configureMode({ mode })
        }
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
          if (dispatcher && dispatcher.activeCount === 0) dispatcher = buildDispatcher()
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
  const builtinToolsDisabled = new Set<string>()
  let builtinToolsConfigLoaded = false
  async function ensureBuiltinToolsConfig(): Promise<void> {
    if (builtinToolsConfigLoaded) return
    builtinToolsConfigLoaded = true
    try {
      const config = await loadTomlFile(join(home, 'config.toml'), {
        onWarning: (message) => logger.warn(message),
      })
      for (const domain of builtinDisabledFrom(config.plugins)) builtinToolsDisabled.add(domain)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
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
  // mcp：runtime 级单例 manager（首会话 cwd 已知时初始化；项目级 mcp.toml /
  // .mcp.json 的信任由会话目录信任门兜底——cli.ts 在未信任目录上拒绝启动）。
  const mcpDisabled = new Set<string>()
  let mcpManager: McpManager | undefined
  async function ensureMcpManager(cwd: string): Promise<McpManager> {
    if (mcpManager) return mcpManager
    try {
      const config = await loadTomlFile(join(home, 'config.toml'), {
        onWarning: (message) => logger.warn(message),
      })
      for (const name of disabledNamesFrom(config.mcp)) mcpDisabled.add(name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const servers = await loadMcpServerConfigs({
      volundHome: home,
      cwd,
      onWarning: (message) => logger.warn(message),
      onEvent: (event, fields) => void telemetry.emit(event, 'mcp', sanitize(fields)),
    })
    const previousStatuses = new Map<string, string>()
    mcpManager = new McpManager({
      servers,
      disabled: mcpDisabled,
      onWarning: (message) => logger.warn(message),
      // SKILLS-MCPS-r1 §S3.6：结构化诊断 JSONL（启动/连接/失败/stderr 尾），
      // 与 telemetry 同目录。追加写、失败静默（不阻塞主链路）。
      logPath: join(home, 'mcp.log'),
      // W7：headers 的 keyref:// 占位在连接期经 auth store 解析。
      resolveKeyref: (reference) => auth.getCredential(reference),
      // §S3.8：状态迁移采样；server 名 sha256 前 8 位（不落明文名字）。
      onStateChange: () => {
        if (!mcpManager) return
        for (const entry of mcpManager.snapshot()) {
          const from = previousStatuses.get(entry.name)
          if (from !== undefined && from !== entry.status)
            void telemetry.emit(
              'mcp.server_state_changed',
              'mcp',
              sanitize({
                name_kind: createHash('sha256').update(entry.name).digest('hex').slice(0, 8),
                from,
                to: entry.status,
              }),
            )
          previousStatuses.set(entry.name, entry.status)
        }
      },
    })
    void mcpManager.connect()
    return mcpManager
  }
  const mcpPort: McpPort = {
    async login(serverName) {
      // SM-07：浏览器 OAuth 2.1 + PKCE + DCR。token 存 auth（`mcp.<name>.oauth`
      // + `Bearer` 头快照 `mcp.<name>.Authorization`），连接期经 resolveKeyref
      // / 无 header 自动注入消费。
      const servers = await loadMcpServerConfigs({
        volundHome: home,
        cwd: process.cwd(),
        onWarning: (message) => logger.warn(message),
      })
      const server = servers.find((entry) => entry.name === serverName)
      if (!server) throw new Error(`Unknown MCP server: ${serverName}`)
      if (server.transport.kind !== 'http')
        throw new Error(`mcp login applies to http servers only: '${serverName}' is stdio`)
      const oauth = new McpOAuthClient({
        serverName,
        serverUrl: server.transport.url,
        store: encrypted,
      })
      await oauth.login()
      return { server: serverName }
    },
    async logout(serverName) {
      const oauth = new McpOAuthClient({
        serverName,
        serverUrl: `https://${serverName}.invalid`,
        store: encrypted,
      })
      await oauth.logout()
      // AuthManager 进程内缓存不在 oauth client 的视野里：显式逐 key 失效，
      // 否则同进程的 keyref 解析会继续命中已删除的旧 token。
      await auth.logout(oauthCredentialKey(serverName))
      await auth.logout(oauthHeaderKey(serverName))
    },
    async list() {
      const manager = await ensureMcpManager(process.cwd())
      // 有界等待连接轮完成（CLI 场景无 REPL 轮询；超时按当前状态快照返回）。
      await Promise.race([manager.connect(), new Promise((resolve) => setTimeout(resolve, 4000))])
      const snapshot = manager.snapshot().map((entry) => ({
        name: entry.name,
        transport: entry.transport,
        scope: entry.scope,
        status: entry.status,
        ...(entry.tools !== undefined ? { tools: entry.tools } : {}),
        ...(entry.protocolVersion ? { protocolVersion: entry.protocolVersion } : {}),
      }))
      await manager.close()
      return snapshot
    },
    async test(name) {
      const manager = await ensureMcpManager(process.cwd())
      await Promise.race([manager.connect(), new Promise((resolve) => setTimeout(resolve, 4000))])
      try {
        const { entry } = await manager.inspect(name)
        if (entry.status !== 'connected')
          throw new Error(
            `mcp server '${name}' is ${entry.status}${entry.detail ? `: ${entry.detail}` : ''}`,
          )
        return { protocolVersion: entry.protocolVersion ?? 'unknown' }
      } finally {
        await manager.close()
      }
    },
    async inspect(name) {
      const manager = await ensureMcpManager(process.cwd())
      await Promise.race([manager.connect(), new Promise((resolve) => setTimeout(resolve, 4000))])
      try {
        const { tools } = await manager.inspect(name)
        return {
          tools: tools.map((tool) => ({
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
          })),
        }
      } finally {
        await manager.close()
      }
    },
    async add(input) {
      const file =
        input.scope === 'project'
          ? join(process.cwd(), '.volund', 'mcp.toml')
          : join(home, 'mcp.toml')
      await upsertMcpServerToml({
        file,
        name: input.name,
        transport:
          input.transport.kind === 'stdio'
            ? {
                kind: 'stdio',
                command: input.transport.command,
                args: input.transport.args,
                env: input.transport.env,
              }
            : {
                kind: 'http',
                url: input.transport.url,
                headers: input.transport.headers,
                legacySse: input.transport.legacySse ?? false,
              },
      })
      return { file }
    },
    async remove(name, scope) {
      const files =
        scope === 'project'
          ? [join(process.cwd(), '.volund', 'mcp.toml')]
          : scope === 'user'
            ? [join(home, 'mcp.toml')]
            : [join(process.cwd(), '.volund', 'mcp.toml'), join(home, 'mcp.toml')]
      for (const file of files) if (await removeMcpServerToml({ file, name })) return { file }
      throw new Error(`MCP server not configured: ${name}`)
    },
    async setEnabled(name, enabled) {
      const manager = await ensureMcpManager(process.cwd())
      if (enabled) mcpDisabled.delete(name)
      else mcpDisabled.add(name)
      await updateConfigDisabledList({ home, section: 'mcp', name, add: !enabled })
      // CLI 一次性进程：ensure 触发的后台连接要收尾，否则 stdio 子进程挂住事件循环。
      await manager.close()
    },
  }
  const mcpPanelController: McpPanelController = {
    async list() {
      // §S3.8：面板数据加载采样（打开/刷新）。
      const snapshot = mcpManager?.snapshot() ?? []
      void telemetry.emit(
        'mcp.panel_opened',
        'mcp',
        sanitize({
          count: snapshot.length,
          connected: snapshot.filter((entry) => entry.status === 'connected').length,
          failed: snapshot.filter((entry) => entry.status === 'failed').length,
          needs_auth: snapshot.filter((entry) => entry.status === 'needs-auth').length,
        }),
      )
      return snapshot
    },
    async reload() {
      if (!mcpManager) return []
      await mcpManager.reload()
      return mcpManager.snapshot()
    },
    async setEnabled(name, enabled) {
      if (!mcpManager) throw new Error('MCP is not available in this session')
      if (enabled) mcpDisabled.delete(name)
      else mcpDisabled.add(name)
      await mcpManager.setEnabled(name, enabled)
      await updateConfigDisabledList({ home, section: 'mcp', name, add: !enabled })
      return `mcp server ${name} ${enabled ? 'enabled' : 'disabled'}`
    },
    async inspect(name) {
      if (!mcpManager) throw new Error('MCP is not available in this session')
      const { entry, tools } = await mcpManager.inspect(name)
      return {
        entry: entry,
        tools: tools.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
        })),
      }
    },
  }

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
      if (!dispatcher.cancel(sessionId)) throw new Error(`Subagent ${sessionId} is not running`)
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
    | ((request: InteractivePermissionRequest) => Promise<InteractivePermissionDecision>)
    | undefined
  let streamToStdout = true
  let dispatcher: SubagentDispatcher
  // §2.7.1（r13-G3）：自定义 agent 定义两层装载（<home>/agents 与
  // <cwd>/.volund/agents，项目级同名覆盖全局）；失败文件跳过仅告警。
  const agentRegistry = new AgentDefinitionRegistry({
    volundHome: home,
    cwd: process.cwd(),
    onWarning: (message) => logger.warn(message),
  })
  agentRegistry.discover()
  // r13-G2：后台 shell 注册表（跨 session 共享一个实例；事件在 SessionController
  // activate() 里挂到当前 session 的 EventBus，session.ended 统一 kill）
  const background = new BackgroundShells()
  const createRunner: RunnerFactory = async (state, events, agent) => {
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
      // P1-05：line 模式的 TTY 接缝显式注入（app-runtime 不再回退模块级 readline 默认）。
      terminalIsInteractive: isInteractiveTerminal,
      linePermissionPrompt: promptLineMaybe,
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
    const contextPolicy = new SlidingWindowPolicy({
      compactionThreshold: tuned.compaction_threshold,
      targetRatio: tuned.target_ratio,
      keepRecent: tuned.keep_recent,
    })
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
          if (!value) throw new Error('Anthropic credential unavailable')
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
            if (skipAuth) throw new Error('OpenAI credential unavailable (skipAuth)')
            const value = await auth.getCredential('openai')
            if (!value) throw new Error('OpenAI credential unavailable')
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
            if (skipAuth) throw new Error('Gemini credential unavailable (skipAuth)')
            const value = await auth.getCredential('gemini')
            if (!value) throw new Error('Gemini credential unavailable')
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
    // 内核 `tools` 服务：注册表从 Context 取（与 model 同形态，S1 批次 A）。
    kernel.plugin(ToolsService)
    liveToolServices.add(kernel.tools)
    kernel.bus.events.subscribe((event) => {
      if (event.type === 'session.ended') {
        liveToolServices.delete(kernel.tools)
        kernel.tools.unregisterAllPluginTools()
      }
      // H5：会话生命周期事件广播给插件 hooks（session.on / hooks.on 订阅）。
      const pluginEvent =
        event.type === 'session.started'
          ? 'sessionStart'
          : event.type === 'session.ended'
            ? 'sessionEnd'
            : undefined
      if (!pluginEvent) return
      for (const loaded of loadedPluginEntries) {
        if (!loaded.handle) continue
        for (const hook of loaded.handle.hooks) {
          if (hook.event !== pluginEvent) continue
          void hook
            .invoke({ schemaVersion: 1, sessionId: event.sessionId })
            .catch((error) =>
              logger.warn(
                `plugin hook ${pluginEvent} from ${loaded.name} failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
            )
        }
      }
    })
    const registry = kernel.tools.registry
    await ensureBuiltinToolsConfig()
    // F1 插件一等公民：内置工具按域装配——[plugins] builtin_disabled 整域禁用；
    // memory/Skill 工具归 orchestration 域门控。工具名与注册顺序对既有会话零变化。
    for (const domain of builtinToolDomains({
      backups,
      background,
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
      for (const tool of createMemoryTools(memory)) registry.register(tool)
      registry.register(
        createSkillTool({
          skills,
          grantEphemeral: (rules) => permissionChain.grantEphemeral(rules),
          onWarn: (message) => logger.warn(message),
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
        session: { id: state.id, cwd: state.cwd, turnId: runner.state.activeTurn ?? '' },
        native,
        logger,
        ui: { requestInput: promptLine },
      }),
      dispatchHook,
    )
    // §2.7.1：agent 的 tools 白名单只能收紧——schemas 与 execute 两处同时过滤，
    // 白名单外的工具对模型不可见、调用即拒绝。
    const allowedTools = agent?.definition.tools
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
      // §2.7.1：maxTurns 等价于该 agent 的 maxToolLoopsPerTurn。
      agent?.definition.maxTurns ? { maxToolLoopsPerTurn: agent.definition.maxTurns } : {},
      contextPolicy,
    )
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
  // P1-03（§22.7.1）：会话控制器 = 应用级内核的 Cordis service（行为等价于原
  // RuntimeSessionPort；新增 turn mutex，终端接缝经 options.terminal 注入）。
  // cordis 的 Context 增强只能声明非泛型形态，这里按实际装配取回类型化实例。
  appKernel.plugin(SessionController, {
    sessionsDir: join(home, 'sessions'),
    createRunner,
    onSecurity: (input) => permissionPolicy.configureSecurity(input),
    onPermissionInteraction: (input) => permissionPolicy.configureInteraction(input),
    onEnd: async (sessionId) => {
      permissionPolicy.releaseLineage(sessionId)
      await memory.flush()
    },
    onTerminalOutput: (input) => {
      streamToStdout = input.streamToStdout
    },
    onPermissionPromptHandler: (handler) => {
      interactivePermissionPrompt = handler
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
  return {
    identity: options.identity,
    version: options.identity.version,
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
          undo: { undoStep: (sessionId) => backups.undoStep(sessionId) },
          // SKILLS-MCPS-r1：/skills 与 /mcp 面板控制器（经应用级内核面板收集器）
          skills: appKernel.ui.panel<SkillsPanelController>('skills'),
          mcp: appKernel.ui.panel<McpPanelController>('mcp'),
          // SUBAGENTS-UI-r1：/subagents 运行管理面板（dispatcher 运行注册表）
          subagents: appKernel.ui.panel<SubagentsPanelController>('subagents'),
          ...input,
        }),
      renderDirectoryTrustPrompt,
      renderSessionPicker,
    },
    trust,
    // §4.4 三档权限模式：current 供 /mode 与欢迎屏显示；set 对新会话生效并热切活动顶层会话。
    permissionMode: {
      current: () =>
        activePermissionControl?.get() ?? overridePermissionMode ?? configPermissionMode ?? 'ask',
      set: (mode) => {
        overridePermissionMode = mode
        permissionPolicy.configureMode({ mode })
        activePermissionControl?.set(mode)
      },
    },
    restore: { restore: (sessionId, restoreOptions) => backups.restore(sessionId, restoreOptions) },
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
    plugin: {
      async install(_source) {
        throw new PluginError(
          LEGACY_PLUGIN_UNAVAILABLE.code,
          `${LEGACY_PLUGIN_UNAVAILABLE.detail} Reopen requires ${LEGACY_PLUGIN_UNAVAILABLE.reopenCondition}.`,
        )
      },
      async uninstall(name) {
        assertLegacyPluginName(name)
        if (await localPluginState.get(name))
          throw new PluginError(
            'plugin_lifecycle_authority_mismatch',
            `${name} is managed by plugin-state.v2.json; use /plugins uninstall ${name.replace(/^volund-plugin-/, '')}`,
          )
        await pluginsReady
        await plugins.uninstall(name)
      },
      async list() {
        await pluginsReady
        return plugins.list()
      },
      async setEnabled(name, enabled) {
        assertLegacyPluginName(name)
        if (enabled)
          throw new PluginError(
            LEGACY_PLUGIN_UNAVAILABLE.code,
            `${LEGACY_PLUGIN_UNAVAILABLE.detail} Reopen requires ${LEGACY_PLUGIN_UNAVAILABLE.reopenCondition}.`,
          )
        await pluginsReady
        await plugins.setEnabled(name, enabled)
      },
      async availability() {
        return LEGACY_PLUGIN_UNAVAILABLE
      },
      async doctor(name) {
        assertLegacyPluginName(name)
        await pluginsReady
        const approvals = plugins.list()
        const state = Object.hasOwn(approvals, name) ? approvals[name] : undefined
        if (!state) throw new PluginError('plugin_not_installed', name)
        const diagnostic = await readContainedPluginDiagnostic(
          pluginRoot,
          name,
          state.version,
          options.identity.version,
        )
        return {
          name,
          version: diagnostic.version,
          permissions: diagnostic.permissions,
          compatibility: diagnostic.compatibility,
          availability: LEGACY_PLUGIN_UNAVAILABLE,
        }
      },
    },
    localPlugins,
    skill: skillPort,
    mcp: mcpPort,
    telemetry: {
      securityEvent: (name, payload) => telemetry.emit(name, 'security', payload),
      summary: () => telemetryStore.summary(),
      export: (target) => telemetryStore.export(target),
      clear: () => telemetryStore.clear(),
      health: () => telemetryStore.health(),
    },
    confirmation: {
      confirmDangerousNoSandbox: async (sentence) =>
        (await promptLine(`Type "${sentence}" to continue: `)) === sentence,
    },
    auth: {
      async health() {
        const section = await readAuthSection()
        if (section.skipAuth === true) {
          const keyIgnored =
            typeof section.anthropic_api_key === 'string' && section.anthropic_api_key !== ''
          return {
            configured: true,
            detail: `anthropic credential skipped by config (auth.skipAuth)${keyIgnored ? '; auth.anthropic_api_key is set but ignored while skipAuth=true' : ''}`,
          }
        }
        const configured = Boolean(await auth.getCredential('anthropic'))
        return {
          configured,
          detail: configured
            ? 'anthropic credential available'
            : 'anthropic credential unavailable',
        }
      },
      async login(input) {
        const section = await readAuthSection()
        // §8.4：skipAuth / config Layer 4 已覆盖时，交互登录是 no-op——
        // 不弹输入、不发 verify；显式 --api-key-stdin 仍可落盘
        if (input.credential === undefined) {
          if (section.skipAuth === true)
            return {
              detail: `${input.provider} authentication is skipped by config (auth.skipAuth=true); nothing to store`,
            }
          const configured = section[`${input.provider}_api_key`]
          if (typeof configured === 'string' && configured)
            return {
              detail: `${input.provider} credential already provided by config (auth.${input.provider}_api_key); login is unnecessary`,
            }
        }
        const credential = input.credential ?? (await promptSecret('Anthropic API key: ')).trim()
        if (!credential) throw new Error('Credential input was cancelled')
        const verifyBaseUrl = await readAnthropicBaseUrl()
        await auth.login(
          input.provider,
          credential,
          (value) => verifyAnthropicCredential(http, value, undefined, verifyBaseUrl),
          { flow: input.flow, dangerouslySkipVerify: input.dangerouslySkipVerify },
        )
        const skipNote =
          section.skipAuth === true
            ? ' (note: auth.skipAuth=true in config; the stored credential stays unused until it is removed)'
            : ''
        return {
          detail: `${input.provider} credential stored in encrypted credential store${skipNote}`,
        }
      },
      async logout(provider) {
        await auth.logout(provider)
        return { detail: `${provider} credential removed` }
      },
    },
    config: {
      /**
       * [env] 段（§8.3 / 附录 C）：会话启动时把用户级 config.toml 的显式环境变量
       * 写入 process.env——之后 spawn 的子进程（native worker / 插件宿主 / MCP
       * stdio）随之继承；沙箱内 Bash 走 env_clear 白名单模型，仅 [tools]
       * pass_through_env 列出的名字进入（值可来自这里写入的 process.env）。
       * 值先经 expandEnvValue 前置解析（`~` / `${VAR}`）；解析后的应用值记入
       * appliedEnvEntries，作为 /env 生效判定的精确基准。
       * 缺文件是 no-op；类型错按 C.1 传播 config_invalid（启动 fail）。
       */
      async applyEnv() {
        let config: Record<string, JsonValue>
        try {
          config = await loadTomlFile(join(home, 'config.toml'), {
            onWarning: (message) => logger.warn(message),
          })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
          throw error
        }
        const section = config.env
        if (!section || typeof section !== 'object' || Array.isArray(section)) return
        // 展开基准 = 写入前的环境快照：${PATH} 这类"在已有值上追加"的写法拿到的
        // 是启动时已有的值；同段 key 互引用不支持（快照里还没有它们）。
        const basis = { ...process.env }
        const applied: Record<string, string> = {}
        for (const [key, value] of Object.entries(section)) {
          if (typeof value !== 'string') continue
          const resolvedValue = expandEnvValue(value, basis, (name) =>
            logger.warn(
              `[env] ${key}: referenced variable ${name} is not set; kept the placeholder literal`,
            ),
          )
          process.env[key] = resolvedValue
          applied[key] = resolvedValue
        }
        appliedEnvEntries = applied
      },
      async health(cwd) {
        try {
          const warnings: string[] = []
          for (const path of [join(home, 'config.toml'), join(cwd, '.volund', 'config.toml')]) {
            try {
              await access(path)
              // r13-I4 §8.3：未知 key warn + 忽略；已知 key 类型错 → fail（file + key + 期望类型）
              await loadTomlFile(path, {
                onWarning: (message) => warnings.push(message),
              })
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
          }
          return warnings.length > 0
            ? { valid: true, detail: warnings.join('; ') }
            : { valid: true, detail: 'valid' }
        } catch (error) {
          return { valid: false, detail: error instanceof Error ? error.message : String(error) }
        }
      },
      async status(input) {
        return runtimeStatusData(home, options, input, localPluginHub)
      },
      async updatePreference(id, value, input) {
        const data = await runtimeStatusData(
          home,
          options,
          { ...input, includeStats: true },
          localPluginHub,
        )
        const item = data.config.find((candidate) => candidate.id === id)
        if (!item) throw new Error(`Unknown configuration item: ${id}`)
        validateStatusConfigValue(item, value)
        const path = join(home, 'config.toml')
        let config: Record<string, JsonValue> = {}
        try {
          config = await parseTomlFile(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        const preferences = config.preferences
        const target =
          preferences && typeof preferences === 'object' && !Array.isArray(preferences)
            ? (preferences as Record<string, JsonValue>)
            : ((config.preferences = {}) as Record<string, JsonValue>)
        target[id] = value
        await mkdir(home, { recursive: true })
        const temporary = `${path}.${process.pid}.tmp`
        await writeFile(temporary, serializeConfig(config), { encoding: 'utf8', mode: 0o600 })
        await rename(temporary, path)
        return runtimeStatusData(home, options, { ...input, includeStats: true }, localPluginHub)
      },
      /**
       * §11.3.3 `volund config list` 的合并视图：user + project 两层文件经
       * loadConfig 的层合并与 projectOverride forbidden 过滤。这是只读检视
       * （同 health 的 parse-only），不等于会话生效语义——会话还叠加 defaults
       * /env/flags 与项目配置信任门。
       */
      async listMerged({ cwd }: { cwd: string }) {
        const warnings: string[] = []
        const user = await loadTomlFile(join(home, 'config.toml'), {
          onWarning: (message) => warnings.push(message),
        }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
          throw error
        })
        const project = await loadTomlFile(join(cwd, '.volund', 'config.toml'), {
          onWarning: (message) => warnings.push(message),
        }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
          throw error
        })
        const forbidden: string[] = []
        const { config: merged } = await loadConfig({
          defaults: {},
          global: user,
          project,
          trustProjectConfig: true,
          warning: (key) =>
            forbidden.push(`project override of '${key}' is forbidden (§8.3.1); ignored`),
        })
        return { config: merged, warnings: [...warnings, ...forbidden] }
      },
      async setValue({ cwd, key, value, project }) {
        if (project && isProjectOverrideForbidden(key))
          throw new VolundError(
            'config_project_forbidden',
            `'${key}' cannot be set in project config (data-flow gate, §8.3.1)`,
          )
        assertConfigKeyValue(key, value)
        const file = project ? join(cwd, '.volund', 'config.toml') : join(home, 'config.toml')
        const config = await readConfigFileOrEmpty(file)
        assignConfigValue(config, key, value)
        await writeConfigFile(file, config)
        return { file }
      },
      async unsetValue({ cwd, key, project }) {
        // unset 不做 forbidden 门：从 project 配置里移除 forbidden key 是清理，应当允许。
        const file = project ? join(cwd, '.volund', 'config.toml') : join(home, 'config.toml')
        const config = await readConfigFileOrEmpty(file)
        const removed = deleteConfigValue(config, key)
        if (removed) await writeConfigFile(file, config)
        return { file, removed }
      },
      filePaths({ cwd }: { cwd: string }) {
        return {
          user: join(home, 'config.toml'),
          project: join(cwd, '.volund', 'config.toml'),
        }
      },
    },
    native: {
      /** Tri-state availability snapshot (r13-P1): 'probing' until backfill. */
      available() {
        const availability = nativeProbes.available
        return {
          sandbox: availability.sandbox,
          search: availability.search,
          fs: availability.fs,
        }
      },
      /**
       * r13-P1 startup contract (spec 05-rust-sidecar.md §5.8): fires every
       * native probe (sandbox --probe + search/fs worker handshakes) in
       * parallel. The REPL never awaits them — `available.*` starts as
       * 'probing' and backfills asynchronously; side-effect waits are
       * budget-bounded instead.
       */
      startProbes() {
        nativeProbes.start()
      },
      /** Resolves when every probe settled or its budget expired (probe.ts contract). */
      settled() {
        return nativeProbes.settled()
      },
      async probe() {
        const info = await probeSandbox()
        const features = info.features as Record<string, unknown>
        const mechanism =
          typeof features.mechanism === 'string' ? features.mechanism : 'volund-sandbox'
        const abi = typeof features.abi === 'string' ? features.abi : 'unknown'
        const disclosure = {
          tier: info.tier,
          mechanism,
          features: {
            filesystem: Boolean(features.filesystem ?? info.tier !== 'none'),
            network: Boolean(features.network),
          },
          degradationReasons: info.known_limitations,
        }
        await telemetry.emit('sandbox.probe', 'sandbox', {
          tier: disclosure.tier,
          mechanism: disclosure.mechanism,
          abi,
          version: options.identity.version,
          probedAt: new Date().toISOString(),
        })
        return disclosure
      },
      async health() {
        const [probe, search, fs] = await Promise.all([
          probeSandbox(),
          resolveBinary('search'),
          resolveBinary('fs'),
        ])
        return { sandbox: probe.tier !== 'none', search: search !== null, fs: fs !== null }
      },
    },
    /**
     * 进程收尾：插件宿主的 fd3 管道与 MCP stdio/SSE 连接都是 ref 住事件循环的
     * 长驻句柄——不主动关闭，waitUntilExit 之后进程永不退出（此前仅靠
     * process.on('exit') 兜底，而 'exit' 恰恰因这些句柄存在而永远不会触发）。
     * 幂等；单项失败不阻塞其他项（allSettled）。
     */
    async shutdown() {
      const manager = mcpManager
      await Promise.allSettled([
        localPlugins.deactivateAll(),
        manager ? manager.close().then(() => manager.logsFlushed()) : undefined,
      ])
    },
  }
}

/** 插件工具输出的不可信包裹转义（与 MCP 工具同策略）。 */
function escapeUntrustedText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * H1：插件 hook 派发器——已激活插件的 hook 订阅按装载顺序执行，首个 HookResult
 * （veto/rewrite）生效；handler 错误 fail-open（warn 后继续），回合中止即停止
 * 派发。独立导出以便沙箱 e2e 正测（veto 必须真的拦下工具调用）。
 */
export function createPluginHookDispatcher(
  entries: readonly {
    name: string
    handle?: Pick<ActivatedLocalPlugin, 'hooks'> | undefined
  }[],
  logger: { warn(message: string): void },
): ToolHookDispatcher {
  return (event, payload, options) => {
    const run = async (): Promise<ToolHookOutcome | undefined> => {
      for (const loaded of entries) {
        if (!loaded.handle) continue
        if (options?.signal?.aborted) return undefined
        for (const hook of loaded.handle.hooks) {
          if (hook.event !== event) continue
          try {
            const result = (await hook.invoke(payload)) as
              | { veto?: unknown; reason?: unknown; value?: unknown }
              | undefined
            if (result && typeof result === 'object') {
              return {
                ...(result.veto === true
                  ? {
                      veto: true,
                      ...(typeof result.reason === 'string' ? { reason: result.reason } : {}),
                    }
                  : {}),
                ...('value' in result ? { value: result.value } : {}),
              }
            }
          } catch (error) {
            logger.warn(
              `plugin hook ${event} from ${loaded.name} failed (fail-open): ${
                error instanceof Error ? error.message : String(error)
              }`,
            )
          }
        }
      }
      return undefined
    }
    return run()
  }
}

function serializeConfig(config: Record<string, JsonValue>) {
  const lines: string[] = []
  for (const [section, raw] of Object.entries(config)) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      lines.push(`[${section}]`)
      for (const [key, value] of Object.entries(raw))
        lines.push(`${key} = ${JSON.stringify(value)}`)
      lines.push('')
    } else lines.push(`${section} = ${JSON.stringify(raw)}`)
  }
  return `${lines.join('\n').trim()}\n`
}
