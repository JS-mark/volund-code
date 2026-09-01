import { execFile } from 'node:child_process'
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { parseTomlFile } from '@volund/config'
import {
  HttpSseTransport,
  McpClient,
  StdioTransport,
  mcpToolName,
  type McpToolDescription,
  type McpTransport,
} from '@volund/mcp-client'
import { productIdentity, type JsonValue } from '@volund/shared'
import type { Tool, ToolRegistry } from '@volund/tool-kit'

/**
 * SKILLS-MCPS-r1 §S3.5：MCP 配置装载 + 连接管理（原生实现，不经插件桥）。
 *
 * 配置来源（优先级高 → 低，同名整条覆盖、不合并字段）：
 * 1. `<cwd>/.volund/mcp.toml`（TOML，`[mcp_servers.<name>]` 表）
 * 2. `<cwd>/.mcp.json`（业界互操作，顶层 `mcpServers` 键；只读导入）
 * 3. `<volundHome>/mcp.toml`（用户级）
 *
 * 项目级目录的信任由会话级目录信任门兜底（cli.ts 在未信任目录上拒绝启动任何
 * 会话），因此此处不再单独设门。
 */

export interface McpStdioTransportConfig {
  kind: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
}
export interface McpHttpTransportConfig {
  kind: 'http'
  url: string
  headers: Record<string, string>
  /** sse = 旧 HTTP+SSE 传输（规范已废弃，兼容保留；Streamable HTTP 升级在 SM-08）。 */
  legacySse: boolean
}
export type McpTransportConfig = McpStdioTransportConfig | McpHttpTransportConfig
export interface McpServerConfig {
  name: string
  scope: 'user' | 'project'
  source: string
  transport: McpTransportConfig
}

export type McpLoadWarning = (message: string) => void

/** `${VAR}` / `${VAR:-default}` 展开：未定义且无默认 → 空串 + onUnresolved（§S3.5）。 */
export function expandMcpEnv(
  value: string,
  env: Record<string, string | undefined>,
  onUnresolved?: (name: string) => void,
): string {
  return value.replaceAll(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (raw, name, fallback) => {
      const resolved = env[name]
      if (resolved !== undefined) return resolved
      if (fallback !== undefined) return fallback
      onUnresolved?.(name)
      return ''
    },
  )
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined
}
function stringArray(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : undefined
}

/** 单来源的 server 表（TOML mcp_servers 段或 .mcp.json mcpServers 键）→ 规范化配置。 */
export function parseMcpServerEntries(
  section: Record<string, JsonValue>,
  options: { scope: 'user' | 'project'; source: string; onWarning?: McpLoadWarning },
): McpServerConfig[] {
  const env = process.env
  const out: McpServerConfig[] = []
  for (const [name, raw] of Object.entries(section)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      options.onWarning?.(`mcp: invalid server name '${name}' in ${options.source}; skipped`)
      continue
    }
    const entry = asRecord(raw)
    if (!entry) {
      options.onWarning?.(`mcp: server '${name}' in ${options.source} is not a table; skipped`)
      continue
    }
    const url = typeof entry.url === 'string' ? entry.url : undefined
    const command = typeof entry.command === 'string' ? entry.command : undefined
    if (url) {
      const type = typeof entry.type === 'string' ? entry.type : 'http'
      if (type !== 'http' && type !== 'streamable-http' && type !== 'sse') {
        options.onWarning?.(
          `mcp: server '${name}' has unsupported type '${type}' in ${options.source}; skipped`,
        )
        continue
      }
      const headers: Record<string, string> = {}
      const rawHeaders = asRecord(entry.headers)
      for (const [key, value] of Object.entries(rawHeaders ?? {}))
        if (typeof value === 'string')
          headers[key] = expandMcpEnv(value, env, report(options, name))
      out.push({
        name,
        scope: options.scope,
        source: options.source,
        transport: {
          kind: 'http',
          url: expandMcpEnv(url, env, report(options, name)),
          headers,
          legacySse: type === 'sse',
        },
      })
      continue
    }
    if (command) {
      const args = stringArray(entry.args)
      if (entry.args !== undefined && !args) {
        options.onWarning?.(`mcp: server '${name}' args must be a string array; skipped`)
        continue
      }
      const envVars: Record<string, string> = {}
      const rawEnv = asRecord(entry.env)
      for (const [key, value] of Object.entries(rawEnv ?? {})) {
        if (typeof value !== 'string') {
          options.onWarning?.(`mcp: server '${name}' env.${key} must be a string; skipped`)
          continue
        }
        envVars[key] = expandMcpEnv(value, env, report(options, name))
      }
      const cwd = typeof entry.cwd === 'string' ? entry.cwd : undefined
      if (cwd === '') {
        options.onWarning?.(`mcp: server '${name}' cwd must be non-empty; ignored`)
      }
      out.push({
        name,
        scope: options.scope,
        source: options.source,
        transport: {
          kind: 'stdio',
          command: expandMcpEnv(command, env, report(options, name)),
          args: (args ?? []).map((arg) => expandMcpEnv(arg, env, report(options, name))),
          env: envVars,
          ...(cwd && cwd !== '.' ? { cwd } : {}),
        },
      })
      continue
    }
    options.onWarning?.(
      `mcp: server '${name}' in ${options.source} needs 'command' (stdio) or 'url' (http); skipped`,
    )
  }
  return out
}

function report(options: { onWarning?: McpLoadWarning }, name: string) {
  return (variable: string) =>
    options.onWarning?.(
      `mcp: server '${name}' references unset variable ${variable}; expanded to ''`,
    )
}

export async function loadMcpServerConfigs(input: {
  volundHome: string
  cwd: string
  onWarning?: McpLoadWarning
}): Promise<McpServerConfig[]> {
  const layers: Array<{
    scope: 'user' | 'project'
    source: string
    section(): Promise<Record<string, JsonValue>>
  }> = [
    {
      scope: 'project',
      source: join(input.cwd, '.volund', 'mcp.toml'),
      section: async () => {
        const path = join(input.cwd, '.volund', 'mcp.toml')
        return mcpTomlSection(await parseTomlFile(path), path, input.onWarning)
      },
    },
    {
      scope: 'project',
      source: join(input.cwd, '.mcp.json'),
      section: async () => {
        const path = join(input.cwd, '.mcp.json')
        let parsed: Record<string, JsonValue>
        try {
          parsed = (JSON.parse(await readFile(path, 'utf8')) ?? {}) as Record<string, JsonValue>
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
          input.onWarning?.(`mcp: failed to parse ${path}: ${String(error)}`)
          return {}
        }
        if (parsed.mcpServers === undefined) {
          input.onWarning?.(`mcp: ${path} has no 'mcpServers' key; nothing imported`)
          return {}
        }
        return asRecord(parsed.mcpServers) ?? {}
      },
    },
    {
      scope: 'user',
      source: join(input.volundHome, 'mcp.toml'),
      section: async () => {
        const path = join(input.volundHome, 'mcp.toml')
        return mcpTomlSection(await parseTomlFile(path), path, input.onWarning)
      },
    },
  ]
  const byName = new Map<string, McpServerConfig>()
  for (const layer of layers) {
    let entries: McpServerConfig[]
    try {
      entries = parseMcpServerEntries(await layer.section(), {
        scope: layer.scope,
        source: layer.source,
        ...(input.onWarning ? { onWarning: input.onWarning } : {}),
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      input.onWarning?.(`mcp: failed to load ${layer.source}: ${String(error)}`)
      continue
    }
    for (const entry of entries) if (!byName.has(entry.name)) byName.set(entry.name, entry)
  }
  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name))
}

async function mcpTomlSection(
  config: Record<string, JsonValue>,
  source: string,
  onWarning?: McpLoadWarning,
): Promise<Record<string, JsonValue>> {
  for (const key of Object.keys(config))
    if (key !== 'mcp_servers')
      onWarning?.(`mcp: unknown key '${key}' in ${source} ignored (expected [mcp_servers.<name>])`)
  return asRecord(config.mcp_servers) ?? {}
}

export type McpServerStateStatus = 'connected' | 'connecting' | 'needs-auth' | 'failed' | 'disabled'

interface ServerState {
  config: McpServerConfig
  status: McpServerStateStatus
  client?: McpClient | undefined
  tools: McpToolDescription[]
  detail?: string | undefined
  protocolVersion?: string | undefined
  /** §S3.7：已调度的自动重连次数（成功连接后清零）。 */
  reconnectAttempt: number
  reconnectTimer?: NodeJS.Timeout | undefined
  /** 我们主动 close（disconnect/reload/close）时置位——抑制 transport onClose 触发重连。 */
  closing: boolean
}

export interface McpManagerOptions {
  servers: readonly McpServerConfig[]
  /** config [mcp] disabled 名单（运行期共享引用：面板切换即时生效）。 */
  disabled: Set<string>
  onWarning?: (message: string) => void
  /** 状态迁移回调（面板订阅刷新）。 */
  onStateChange?: () => void
  /** 测试注入：transport 工厂。 */
  transportFactory?: (config: McpServerConfig) => McpTransport
  /** 结构化日志文件（JSONL；缺省不写）。启动/连接/断开/失败/stderr 都落。 */
  logPath?: string
  /** §S3.7 断线自动重连：指数退避基值（delay = base × 2^attempt）。 */
  reconnectBaseDelayMs?: number
  /** §S3.7 断线自动重连最大次数，超限置 failed（默认 3）。 */
  maxReconnects?: number
  /**
   * W7 keyref 解析：headers 值形如 `keyref://mcp.<name>.<field>` 时在连接期
   * 查 auth store 取真实凭据；返回 undefined → 连接失败（fail-closed，绝不把
   * keyref 字面量发上线）。
   */
  resolveKeyref?: (reference: string) => Promise<string | undefined>
}

export interface McpManagerEntry {
  name: string
  scope: 'user' | 'project'
  transport: string
  status: McpServerStateStatus
  tools?: number
  detail?: string
  protocolVersion?: string
}

/**
 * MCP 连接管理器（runtime 级单例）：持有全部 server 连接，向每个新 Runner 的
 * ToolRegistry 注册 `mcp__<server>__<tool>` 工具（invoke 走共享连接，子 agent
 * 复用同一 stdio/http 进程，不重复 spawn）。
 */
export class McpManager {
  readonly #states = new Map<string, ServerState>()
  /** registry → (server → 注销函数列表)：断开单个 server 时只摘自己的工具。 */
  readonly #registries = new Map<ToolRegistry, Map<string, Array<() => void>>>()
  #connectRun: Promise<void> | undefined
  /** close() 后拒绝新连接完成落位：进行中的 initialize 完成即拆连接（CLI 一次性进程收尾）。 */
  #closed = false
  readonly #options: McpManagerOptions
  constructor(options: McpManagerOptions) {
    this.#options = options
    for (const server of options.servers) {
      this.#states.set(server.name, {
        config: server,
        status: options.disabled.has(server.name) ? 'disabled' : 'connecting',
        tools: [],
        reconnectAttempt: 0,
        closing: false,
      })
    }
    this.#log('manager.init', { servers: options.servers.length })
  }
  /** 追加一行 JSONL 诊断（启动/迁移/失败/stderr 尾），失败静默（不阻塞主链路）。 */
  #logQueue: Promise<void> = Promise.resolve()
  #log(event: string, fields: Record<string, JsonValue> = {}): void {
    if (!this.#options.logPath) return
    const line = `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`
    this.#logQueue = this.#logQueue.then(() =>
      appendFile(this.#options.logPath!, line).catch(() => undefined),
    )
  }
  /** 测试/收尾用：等日志落盘。 */
  async logsFlushed(): Promise<void> {
    await this.#logQueue
  }
  /** 连接全部未禁用 server（并行；失败单点降级为 failed/needs-auth，不拖累其他）。 */
  /**
   * 连接全部未禁用 server（并行；失败单点降级为 failed/needs-auth，不拖累其他）。
   * 可重入去重：并发调用共享同一次连接轮（CLI `mcp list` 的有界等待依赖此语义）。
   */
  async connect(): Promise<void> {
    this.#connectRun ??= this.#connectAll().finally(() => {
      this.#connectRun = undefined
    })
    return this.#connectRun
  }
  async #connectAll(): Promise<void> {
    await Promise.all(
      [...this.#states.values()]
        .filter((state) => state.status !== 'disabled' && state.status !== 'connected')
        .map((state) => this.#connectState(state)),
    )
  }
  /** 断开全部并按当前配置重连（/mcp reload 语义）。 */
  async reload(): Promise<void> {
    this.#closed = true
    await Promise.all([...this.#states.values()].map((state) => this.#disconnectState(state)))
    this.#closed = false
    for (const state of this.#states.values()) {
      state.status = this.#options.disabled.has(state.config.name) ? 'disabled' : 'connecting'
      state.reconnectAttempt = 0
    }
    this.#options.onStateChange?.()
    await this.connect()
  }
  /** 向一个 Runner registry 注册全部已连接 server 的工具；返回注销函数。 */
  attach(registry: ToolRegistry): () => void {
    // 先登记 registry（即使当前没有已连接 server）：后续连接完成时会补注册。
    if (!this.#registries.has(registry)) this.#registries.set(registry, new Map())
    for (const state of this.#states.values())
      if (state.status === 'connected') this.#registerStateTools(state, registry)
    return () => {
      const servers = this.#registries.get(registry)
      if (!servers) return
      for (const unsubscribers of servers.values()) for (const remove of unsubscribers) remove()
      this.#registries.delete(registry)
    }
  }
  /** 启停一个 server（连接侧；持久化由调用方写 config）。 */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const state = this.#states.get(name)
    if (!state) throw new Error(`Unknown MCP server: ${name}`)
    if (enabled) {
      if (state.status === 'connected' || state.status === 'connecting') return
      await this.#connectState(state)
      return
    }
    await this.#disconnectState(state)
    state.status = 'disabled'
    this.#options.onStateChange?.()
  }
  snapshot(): McpManagerEntry[] {
    return [...this.#states.values()]
      .map((state) => ({
        name: state.config.name,
        scope: state.config.scope,
        transport: transportSummary(state.config),
        status: state.status,
        ...(state.status === 'connected' ? { tools: state.tools.length } : {}),
        ...(state.detail ? { detail: state.detail } : {}),
        ...(state.protocolVersion ? { protocolVersion: state.protocolVersion } : {}),
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name))
  }
  async inspect(name: string): Promise<{ entry: McpManagerEntry; tools: McpToolDescription[] }> {
    const state = this.#states.get(name)
    if (!state) throw new Error(`Unknown MCP server: ${name}`)
    if (state.status === 'connecting') await this.#settled(name)
    const entry = this.snapshot().find((item) => item.name === name)!
    return { entry, tools: state.tools }
  }
  async close(): Promise<void> {
    this.#closed = true
    await Promise.all([...this.#states.values()].map((state) => this.#disconnectState(state)))
  }
  async #settled(name: string): Promise<void> {
    for (
      let attempt = 0;
      attempt < 100 && this.#states.get(name)?.status === 'connecting';
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 50))
  }
  async #connectState(state: ServerState, isReconnect = false): Promise<void> {
    if (state.status === 'connected' || this.#closed) return
    await this.#disconnectState(state)
    if (this.#closed) return
    state.status = 'connecting'
    state.detail = undefined
    this.#log('connect.start', {
      server: state.config.name,
      scope: state.config.scope,
      transport: transportSummary(state.config),
      ...(isReconnect ? { reconnectAttempt: state.reconnectAttempt } : {}),
    })
    this.#options.onStateChange?.()
    try {
      const resolvedConfig = await this.#resolveKeyrefHeaders(state.config)
      const transport = this.#options.transportFactory
        ? this.#options.transportFactory(resolvedConfig)
        : createTransport(resolvedConfig, (event, fields) => this.#log(event, fields))
      const client = new McpClient({
        name: state.config.name,
        transport,
        onClose: (error) => this.#handleTransportClosed(state, error),
      })
      const init = (await client.initialize()) as { protocolVersion?: unknown }
      if (this.#closed) {
        await client.close().catch(() => undefined)
        return
      }
      state.client = client
      state.protocolVersion =
        typeof init.protocolVersion === 'string' ? init.protocolVersion : undefined
      state.tools = await client.listTools()
      state.status = 'connected'
      state.reconnectAttempt = 0
      this.#log('connect.ok', {
        server: state.config.name,
        ...(state.protocolVersion ? { protocol: state.protocolVersion } : {}),
        tools: state.tools.length,
      })
      for (const [registry] of this.#registries) this.#registerStateTools(state, registry)
      this.#options.onStateChange?.()
    } catch (error) {
      state.client = undefined
      state.tools = []
      const message = error instanceof Error ? error.message : String(error)
      // HTTP 401/403 → needs-auth（OAuth 流程在 SM-07；当前可引导手动 header 配置）。
      if (/\bHTTP 40[13]\b/.test(message)) {
        state.status = 'needs-auth'
        state.detail = `authentication required (configure headers or use ${productIdentity.commandName} mcp login once SM-07 lands)`
        state.reconnectAttempt = 0
        this.#log('connect.needs-auth', { server: state.config.name, error: message })
        this.#options.onWarning?.(`mcp: server '${state.config.name}' failed: ${message}`)
        this.#options.onStateChange?.()
        return
      }
      // §S3.7：自动重连轮里的失败继续指数退避（×maxReconnects 次后置 failed）；
      // 首连失败维持立即 failed（不自动重试，/mcp reload 手动兜底）。
      if (isReconnect) {
        this.#scheduleReconnect(state, message)
        return
      }
      state.status = 'failed'
      state.detail = message
      this.#log('connect.failed', { server: state.config.name, error: message })
      this.#options.onWarning?.(`mcp: server '${state.config.name}' failed: ${message}`)
      this.#options.onStateChange?.()
    }
  }
  /** §S3.7：连接成功后意外断线 → 指数退避重连（×3 次），超限置 failed。 */
  #handleTransportClosed(state: ServerState, error?: Error): void {
    if (this.#closed || state.closing) return
    if (state.status !== 'connected') return
    const message = error?.message ?? 'transport closed'
    this.#log('disconnect', { server: state.config.name, reason: message })
    this.#teardownTools(state)
    this.#scheduleReconnect(state, message)
  }
  #scheduleReconnect(state: ServerState, cause: string): void {
    const max = this.#options.maxReconnects ?? 3
    if (state.reconnectAttempt >= max) {
      state.status = 'failed'
      state.detail = `connection lost (${cause}); gave up after ${max} reconnect attempts`
      this.#log('reconnect.gave-up', {
        server: state.config.name,
        attempts: max,
        error: cause,
      })
      this.#options.onWarning?.(`mcp: server '${state.config.name}' ${state.detail}`)
      this.#options.onStateChange?.()
      return
    }
    state.reconnectAttempt += 1
    const delayMs = (this.#options.reconnectBaseDelayMs ?? 1000) * 2 ** (state.reconnectAttempt - 1)
    state.status = 'connecting'
    state.detail = `connection lost (${cause}); reconnect ${state.reconnectAttempt}/${max} in ${delayMs}ms`
    this.#log('reconnect.scheduled', {
      server: state.config.name,
      attempt: state.reconnectAttempt,
      delayMs,
    })
    this.#options.onStateChange?.()
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = undefined
      void this.#connectState(state, true)
    }, delayMs)
    state.reconnectTimer.unref?.()
  }
  /** 摘掉该 server 在全部 registry 的工具（不关 client）。 */
  #teardownTools(state: ServerState): void {
    state.client = undefined
    state.tools = []
    for (const servers of this.#registries.values()) {
      const unsubscribers = servers.get(state.config.name)
      if (unsubscribers) {
        for (const remove of unsubscribers) remove()
        servers.delete(state.config.name)
      }
    }
  }
  /**
   * W7：http headers 里的 `keyref://<reference>` 在连接期解析为真实凭据。
   * 解析失败抛错 → 连接失败；keyref 字面量不会到达 transport。
   */
  async #resolveKeyrefHeaders(config: McpServerConfig): Promise<McpServerConfig> {
    const resolve = this.#options.resolveKeyref
    if (!resolve || config.transport.kind !== 'http') return config
    const headers = config.transport.headers
    if (!Object.values(headers).some((value) => value.startsWith('keyref://'))) return config
    const resolved: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
      const match = /^keyref:\/\/(.+)$/.exec(value)
      if (!match) {
        resolved[key] = value
        continue
      }
      const credential = await resolve(match[1]!)
      if (credential === undefined)
        throw new Error(
          `keyref://${match[1]} not found in the auth store (store the credential or use ${productIdentity.commandName} mcp login)`,
        )
      resolved[key] = credential
    }
    return { ...config, transport: { ...config.transport, headers: resolved } }
  }
  async #disconnectState(state: ServerState): Promise<void> {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = undefined
    }
    const client = state.client
    state.closing = true
    this.#teardownTools(state)
    try {
      if (!client) return
      this.#log('disconnect', { server: state.config.name })
      await client.close().catch(() => undefined)
    } finally {
      state.closing = false
    }
  }
  #registerStateTools(state: ServerState, registry: ToolRegistry): void {
    const unsubscribers: Array<() => void> = []
    for (const descriptor of state.tools) {
      const tool: Tool = {
        name: mcpToolName(state.config.name, descriptor.name),
        description: descriptor.description ?? '',
        inputSchema: descriptor.inputSchema ?? { type: 'object' },
        permissionSpec: () =>
          descriptor.permissionSpec ?? {
            custom: { mcpServer: state.config.name, mcpTool: descriptor.name },
          },
        invoke: (input, context) => {
          const client = state.client
          if (!client) {
            return Promise.resolve({
              content: [
                { type: 'text', text: `MCP server '${state.config.name}' is not connected` },
              ],
              isError: true,
            })
          }
          return client.callTool(descriptor.name, input, context)
        },
      }
      unsubscribers.push(registry.register(tool, { kind: 'mcp', server: state.config.name }))
    }
    let servers = this.#registries.get(registry)
    if (!servers) {
      servers = new Map()
      this.#registries.set(registry, servers)
    }
    servers.set(state.config.name, unsubscribers)
  }
}

function createTransport(
  config: McpServerConfig,
  log: (event: string, fields: Record<string, JsonValue>) => void,
): McpTransport {
  if (config.transport.kind === 'stdio')
    return new StdioTransport({
      command: config.transport.command,
      args: config.transport.args,
      ...(Object.keys(config.transport.env).length ? { env: config.transport.env } : {}),
      ...(config.transport.cwd ? { cwd: config.transport.cwd } : {}),
      onStderrLine: (line) => log('server.stderr', { server: config.name, line }),
    })
  return new HttpSseTransport({
    url: config.transport.url,
    ...(Object.keys(config.transport.headers).length ? { headers: config.transport.headers } : {}),
    onProbe: (transport) => log('connect.protocol', { server: config.name, transport }),
  })
}
export function transportSummary(config: McpServerConfig): string {
  if (config.transport.kind === 'stdio') {
    const head = [config.transport.command, ...config.transport.args.slice(0, 2)].join(' ')
    return `stdio: ${head}`
  }
  try {
    return `http: ${new URL(config.transport.url).host}`
  } catch {
    return `http: ${config.transport.url}`
  }
}

// ── mcp.toml 写入面（§S3.7 `volund mcp add/remove`）───────────────────────────

const execFileAsync = promisify(execFile)

/**
 * 通用 TOML 序列化（与 parseTomlFile 的 JSON 值方言配对）：标量/数组以
 * `key = <JSON>` 输出，嵌套对象递归为 `[section.sub]` 表；顶层标量先行。
 * 只覆盖 volund 产出的配置形状（字符串/数字/布尔/数组/嵌套 record）。
 */
export function serializeToml(config: Record<string, JsonValue>): string {
  const lines: string[] = []
  const tables: Array<{ path: string; value: Record<string, JsonValue> }> = []
  for (const [key, value] of Object.entries(config)) {
    if (value && typeof value === 'object' && !Array.isArray(value))
      tables.push({ path: key, value: value as Record<string, JsonValue> })
    else lines.push(`${tomlKey(key)} = ${JSON.stringify(value)}`)
  }
  const emitTable = (path: string, table: Record<string, JsonValue>) => {
    const scalars = Object.entries(table).filter(
      ([, value]) => !(value && typeof value === 'object' && !Array.isArray(value)),
    )
    const nested = Object.entries(table).filter(
      ([, value]) => value && typeof value === 'object' && !Array.isArray(value),
    ) as Array<[string, Record<string, JsonValue>]>
    if (scalars.length > 0 || nested.length === 0) lines.push('', `[${tomlSectionPath(path)}]`)
    for (const [key, value] of scalars) lines.push(`${tomlKey(key)} = ${JSON.stringify(value)}`)
    for (const [key, value] of nested) emitTable(`${path}.${key}`, value)
  }
  for (const table of tables) emitTable(table.path, table.value)
  return `${lines.join('\n').replace(/^\n+/, '')}\n`
}
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)
}
/** 表路径按段校验：`mcp_servers.demo.env` 合法（点号是段分隔符，不是 key 字符）。 */
function tomlSectionPath(path: string): string {
  return path.split('.').every((segment) => /^[A-Za-z0-9_-]+$/.test(segment))
    ? path
    : path
        .split('.')
        .map((segment) => (/^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment)))
        .join('.')
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

async function readTomlOrEmpty(path: string): Promise<Record<string, JsonValue>> {
  try {
    return await parseTomlFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

function serverTomlEntry(transport: McpTransportConfig): Record<string, JsonValue> {
  if (transport.kind === 'stdio') {
    const entry: Record<string, JsonValue> = { command: transport.command, args: transport.args }
    if (Object.keys(transport.env).length > 0) entry.env = transport.env
    if (transport.cwd) entry.cwd = transport.cwd
    return entry
  }
  const entry: Record<string, JsonValue> = {
    type: transport.legacySse ? 'sse' : 'http',
    url: transport.url,
  }
  if (Object.keys(transport.headers).length > 0) entry.headers = transport.headers
  return entry
}

/** `volund mcp add`：upsert 到目标 scope 的 mcp.toml（同名整条覆盖）。 */
export async function upsertMcpServerToml(input: {
  file: string
  name: string
  transport: McpTransportConfig
}): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.name))
    throw new Error(`Invalid MCP server name: ${input.name}`)
  const config = await readTomlOrEmpty(input.file)
  const servers =
    config.mcp_servers &&
    typeof config.mcp_servers === 'object' &&
    !Array.isArray(config.mcp_servers)
      ? (config.mcp_servers as Record<string, JsonValue>)
      : ((config.mcp_servers = {}) as Record<string, JsonValue>)
  servers[input.name] = serverTomlEntry(input.transport)
  await atomicWrite(input.file, serializeToml(config))
}

/** `volund mcp remove`：删除条目；不存在返回 false。 */
export async function removeMcpServerToml(input: { file: string; name: string }): Promise<boolean> {
  const config = await readTomlOrEmpty(input.file)
  const servers = config.mcp_servers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return false
  const table = servers as Record<string, JsonValue>
  if (!Object.hasOwn(table, input.name)) return false
  delete table[input.name]
  if (Object.keys(table).length === 0) delete config.mcp_servers
  await atomicWrite(input.file, serializeToml(config))
  return true
}

/**
 * `volund skill install`：spec 解析为待安装目录（git URL → 临时 clone；
 * 根有 SKILL.md 装 root，否则装一层子目录里所有带 SKILL.md 的——skills 仓库
 * 惯例是一个 repo 捆多个 skill）。支持 `<path>`、`github:owner/repo`、
 * `owner/repo`（GitHub 简写）、完整 git URL。临时目录由调用方负责清理。
 */
/**
 * 递归收集含 SKILL.md 的目录（任意深度）。跳过常见干扰：node_modules、.git、
 * vendor、dist/build/out、测试夹具；目录名以 . 开头的隐藏层也跳过。
 * 覆盖 anthropic/skills、claude-plugins-official 的 `plugins/<name>/skills/…`
 * 等嵌套结构。
 */
async function collectSkillDirectories(root: string): Promise<string[]> {
  const SKIP = new Set([
    'node_modules',
    'vendor',
    'dist',
    'build',
    'out',
    'target',
    'coverage',
    '__pycache__',
  ])
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    // 目录里先有 SKILL.md 就收（不再深入——skill 目录是叶子，内部 resources/ 不再扫描）
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'SKILL.md') {
        found.push(dir)
        return
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue
      await walk(join(dir, entry.name))
    }
  }
  await walk(root)
  return found.sort((a, b) => a.localeCompare(b))
}

export async function resolveSkillSpecToDirectories(
  spec: string,
  options: { onInfo?: (message: string) => void } = {},
): Promise<{ directories: string[]; cleanup: () => Promise<void> }> {
  const isGitSpec =
    spec.startsWith('https://') ||
    spec.startsWith('git@') ||
    spec.startsWith('github:') ||
    spec.startsWith('file://') ||
    /^\w[\w.-]*\/\w[\w.-]*$/.test(spec)
  if (!isGitSpec) return { directories: [spec], cleanup: async () => {} }
  let url = spec
  if (spec.startsWith('github:')) url = `https://github.com/${spec.slice('github:'.length)}.git`
  else if (!spec.startsWith('https://') && !spec.startsWith('git@') && !spec.startsWith('file://'))
    url = `https://github.com/${spec}.git`
  options.onInfo?.(`cloning ${url}`)
  const temporary = await mkdtemp(join(tmpdir(), 'volund-skill-'))
  const cleanup = () => rm(temporary, { recursive: true, force: true })
  try {
    await execFileAsync('git', ['clone', '--quiet', '--depth', '1', url, temporary], {
      timeout: 120_000,
    })
    // 根有 SKILL.md → 装 root;否则递归扫描（任意深度,装全部命中目录）
    try {
      await readFile(join(temporary, 'SKILL.md'), 'utf8')
      return { directories: [temporary], cleanup }
    } catch {
      const withSkill = await collectSkillDirectories(temporary)
      if (withSkill.length === 0) throw new Error(`No SKILL.md found in ${spec}`)
      return { directories: withSkill, cleanup }
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
