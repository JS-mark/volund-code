import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { PermissionSpec } from '@volund/permission'
import type { JsonValue } from '@volund/shared'
import type { Tool, ToolContext, ToolRegistry, ToolResult } from '@volund/tool-kit'

import { SdkTransportAdapter } from './sdk-transport'

export const MCP_PROTOCOL_VERSION = '2025-03-26'
const DEFAULT_LIMIT = 4 * 1024 * 1024

export interface McpTransport {
  start(onMessage: (message: unknown) => void, onClose: (error?: Error) => void): Promise<void>
  send(message: unknown, signal?: AbortSignal): Promise<void>
  close(): Promise<void>
}

export interface StdioOptions {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  maxMessageBytes?: number
  /** server stderr（规范允许非 MCP 日志）：逐行上报到 Manager 日志（追查超时/启动失败）。 */
  onStderrLine?: (line: string) => void
}

export class StdioTransport implements McpTransport {
  #child: ChildProcessWithoutNullStreams | undefined
  #buffer = Buffer.alloc(0)
  constructor(readonly options: StdioOptions) {}
  async start(onMessage: (message: unknown) => void, onClose: (error?: Error) => void) {
    if (this.#child) throw new Error('MCP stdio transport already started')
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#child = child
    let stderrBuffer = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf8')
      let newline: number
      while ((newline = stderrBuffer.indexOf('\n')) >= 0) {
        const line = stderrBuffer.slice(0, newline).trim()
        stderrBuffer = stderrBuffer.slice(newline + 1)
        if (line) this.options.onStderrLine?.(line)
      }
    })
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.#consume(chunk, onMessage)
      } catch (error) {
        child.kill()
        onClose(asError(error))
      }
    })
    child.once('error', onClose)
    child.once('exit', (code, signal) => {
      this.#child = undefined
      const tail = stderrBuffer.split('\n').filter(Boolean).slice(-5).join(' | ')
      onClose(
        code === 0
          ? undefined
          : new Error(
              `MCP server exited (${code ?? signal})${tail ? `; stderr tail: ${tail}` : ''}`,
            ),
      )
    })
  }
  #consume(chunk: Buffer, onMessage: (message: unknown) => void) {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    const limit = this.options.maxMessageBytes ?? DEFAULT_LIMIT
    if (this.#buffer.length > limit) throw new Error('MCP response exceeds size limit')
    while (true) {
      const newline = this.#buffer.indexOf(10)
      if (newline < 0) return
      const line = this.#buffer.subarray(0, newline).toString('utf8').trim()
      this.#buffer = this.#buffer.subarray(newline + 1)
      if (!line) continue
      if (Buffer.byteLength(line) > limit) throw new Error('MCP response exceeds size limit')
      onMessage(JSON.parse(line))
    }
  }
  async send(message: unknown, signal?: AbortSignal) {
    if (!this.#child) throw new Error('MCP stdio transport is not started')
    if (signal?.aborted) signal.throwIfAborted()
    const payload = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(payload) > (this.options.maxMessageBytes ?? DEFAULT_LIMIT))
      throw new Error('MCP request exceeds size limit')
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal?.reason ?? new Error('MCP request aborted'))
      signal?.addEventListener('abort', abort, { once: true })
      this.#child!.stdin.write(payload, (error) => {
        signal?.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve()
      })
    })
  }
  async close() {
    this.#child?.kill()
    this.#child = undefined
  }
}

export interface HttpSseOptions {
  url: string
  headers?: Record<string, string>
  maxMessageBytes?: number
  maxReconnects?: number
  reconnectBaseMs?: number
  fetch?: typeof fetch
  /** 协议探测结果（规范回退判定）。 */
  onProbe?: (transport: 'streamable-http' | 'sse') => void
}

export class HttpSseTransport implements McpTransport {
  #abort: AbortController | undefined
  #endpoint: string
  #lastEventId?: string
  #loop?: Promise<void>
  #onMessage?: (message: unknown) => void
  #onClose?: (error?: Error) => void
  /** SM-08：探测后的协议模式（streamable-http = POST+SSE 混合；sse = 旧 HTTP+SSE）。 */
  #mode: 'streamable-http' | 'sse' = 'sse'
  /** 服务器在 initialize 响应头分配的 Mcp-Session-Id（streamable 模式回传）。 */
  #sessionId: string | undefined = undefined
  /** streamable 模式下服务器对 GET 监听流返回 405/404 时置位：静默降级为 POST-only。 */
  #listenStreamDisabled = false
  constructor(readonly options: HttpSseOptions) {
    this.#endpoint = options.url
  }
  async start(onMessage: (message: unknown) => void, onClose: (error?: Error) => void) {
    if (this.#abort) throw new Error('MCP HTTP/SSE transport already started')
    this.#abort = new AbortController()
    this.#onMessage = onMessage
    this.#onClose = onClose
    // 规范回退（2025-06-18）：先 POST initialize 探测 Streamable HTTP 端点；
    // 4xx/405 → 回退旧 HTTP+SSE（GET 等 endpoint 事件）。
    try {
      this.#mode = await this.#probeStreamable()
      this.options.onProbe?.(this.#mode)
    } catch (error) {
      onClose(asError(error))
      return
    }
    this.#loop =
      this.#mode === 'sse'
        ? this.#readLoop(onMessage).catch((error) => {
            if (!this.#abort?.signal.aborted) onClose(asError(error))
          })
        : this.#listenLoop(onMessage).catch((error) => {
            // 服务器不提供 GET 监听流（405/404）是规范内降级，不算断线。
            if (!this.#listenStreamDisabled && !this.#abort?.signal.aborted) onClose(asError(error))
          })
  }
  /**
   * POST initialize 探测：200 → Streamable HTTP 端点（响应头的
   * Mcp-Session-Id 记为当前会话）；4xx → 旧 SSE 端点。网络失败抛给 onClose。
   */
  async #probeStreamable(): Promise<'streamable-http' | 'sse'> {
    const response = await (this.options.fetch ?? fetch)(this.options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...this.options.headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'volund-cli', version: '0.0.0' },
        },
      }),
      signal: this.#abort!.signal,
    })
    if (response.ok) {
      const session = response.headers.get('mcp-session-id')
      if (session) this.#sessionId = session
      // 探测只看状态码：不消费响应体会让连接滞留在 undici 池里。
      void response.body?.cancel().catch(() => undefined)
      return 'streamable-http'
    }
    void response.body?.cancel().catch(() => undefined)
    return 'sse'
  }
  /** 旧 HTTP+SSE：GET 流既是服务端→客户端通道，也承载 endpoint 事件。 */
  async #readLoop(onMessage: (message: unknown) => void) {
    const fetcher = this.options.fetch ?? fetch
    const maxReconnects = this.options.maxReconnects ?? 5
    for (let attempt = 0; ; attempt++) {
      const response = await fetcher(this.options.url, {
        headers: {
          accept: 'text/event-stream',
          ...this.options.headers,
          ...(this.#lastEventId ? { 'Last-Event-ID': this.#lastEventId } : {}),
        },
        signal: this.#abort!.signal,
      })
      if (!response.ok || !response.body) throw new Error(`MCP SSE failed: HTTP ${response.status}`)
      await this.#consumeSse(response, onMessage)
      if (this.#abort!.signal.aborted) return
      if (attempt >= maxReconnects) throw new Error('MCP SSE reconnect limit exceeded')
      await delay(
        Math.min((this.options.reconnectBaseMs ?? 100) * 2 ** attempt, 5000),
        this.#abort!.signal,
      )
    }
  }
  /**
   * Streamable HTTP 的可选 GET 监听流（服务端→客户端通知/请求）。
   * 会话建立（拿到 Mcp-Session-Id）后才发起；405/404 → 规范内降级，静默退出。
   */
  async #listenLoop(onMessage: (message: unknown) => void) {
    const fetcher = this.options.fetch ?? fetch
    for (let attempt = 0; ; attempt++) {
      while (!this.#sessionId) {
        if (this.#abort!.signal.aborted) return
        await delay(25, this.#abort!.signal)
      }
      const response = await fetcher(this.options.url, {
        headers: {
          accept: 'text/event-stream',
          ...this.options.headers,
          'mcp-session-id': this.#sessionId,
          ...(this.#lastEventId ? { 'Last-Event-ID': this.#lastEventId } : {}),
        },
        signal: this.#abort!.signal,
      })
      if (response.status === 405 || response.status === 404) {
        this.#listenStreamDisabled = true
        return
      }
      if (!response.ok || !response.body) throw new Error(`MCP SSE failed: HTTP ${response.status}`)
      await this.#consumeSse(response, onMessage)
      if (this.#abort!.signal.aborted) return
      if (attempt >= (this.options.maxReconnects ?? 5))
        throw new Error('MCP SSE reconnect limit exceeded')
      await delay(
        Math.min((this.options.reconnectBaseMs ?? 100) * 2 ** attempt, 5000),
        this.#abort!.signal,
      )
    }
  }
  /** 读一个 SSE 响应体到流结束（POST SSE 应答与 GET 监听流共用）。 */
  async #consumeSse(response: Response, onMessage: (message: unknown) => void): Promise<void> {
    const reader = response.body!.getReader()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += new TextDecoder().decode(value, { stream: true })
      if (Buffer.byteLength(buffer) > (this.options.maxMessageBytes ?? DEFAULT_LIMIT))
        throw new Error('MCP SSE event exceeds size limit')
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, boundary).replace(/\r/g, '')
        buffer = buffer.slice(boundary + 2)
        let type = 'message',
          data = ''
        for (const line of event.split('\n')) {
          if (line.startsWith('id:')) this.#lastEventId = line.slice(3).trim()
          else if (line.startsWith('event:')) type = line.slice(6).trim()
          else if (line.startsWith('data:')) data += `${line.slice(5).trim()}\n`
        }
        data = data.trimEnd()
        if (type === 'endpoint') this.#endpoint = new URL(data, this.options.url).toString()
        else if (data) onMessage(JSON.parse(data))
      }
    }
  }
  async send(message: unknown, signal?: AbortSignal) {
    const fetcher = this.options.fetch ?? fetch
    const streamable = this.#mode === 'streamable-http'
    const response = await fetcher(this.#endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(streamable ? { accept: 'application/json, text/event-stream' } : {}),
        ...this.options.headers,
        ...(streamable && this.#sessionId ? { 'mcp-session-id': this.#sessionId } : {}),
        // 2025-06-18 规范修订：握手后的请求带 MCP-Protocol-Version 头。
        ...(streamable ? { 'mcp-protocol-version': MCP_PROTOCOL_VERSION } : {}),
      },
      body: JSON.stringify(message),
      ...(signal ? { signal } : {}),
    })
    const session = response.headers.get('mcp-session-id')
    if (session) this.#sessionId = session
    if (streamable && response.status === 404) {
      // 服务器不认识当前会话：清 sid 并断开，交由上层重连（新 initialize 建新会话）。
      this.#sessionId = undefined
      this.#onClose?.(new Error('MCP session expired: HTTP 404'))
    }
    if (!response.ok) throw new Error(`MCP HTTP request failed: HTTP ${response.status}`)
    if (response.status === 202) return
    const contentType = response.headers.get('content-type') ?? ''
    if (streamable && contentType.includes('text/event-stream') && response.body) {
      // POST 应答以 SSE 流返回：逐事件投递后等流关闭。
      await this.#consumeSse(response, (message_) => this.#onMessage?.(message_))
      return
    }
    const text = await response.text()
    if (Buffer.byteLength(text) > (this.options.maxMessageBytes ?? DEFAULT_LIMIT))
      throw new Error('MCP HTTP response exceeds size limit')
    if (streamable && text.trim()) {
      try {
        this.#onMessage?.(JSON.parse(text))
      } catch {
        throw new Error('Malformed MCP HTTP response')
      }
    }
  }
  async close() {
    const sessionId = this.#sessionId
    // 规范建议显式终止会话；fire-and-forget，不阻塞本地关闭。
    if (this.#mode === 'streamable-http' && sessionId)
      void (this.options.fetch ?? fetch)(this.#endpoint, {
        method: 'DELETE',
        headers: { ...this.options.headers, 'mcp-session-id': sessionId },
      }).catch(() => undefined)
    this.#abort?.abort()
    await this.#loop?.catch(() => {})
    this.#abort = undefined
  }
}

export interface McpToolDescription {
  name: string
  description?: string
  inputSchema?: Record<string, JsonValue>
  permissionSpec?: PermissionSpec
}
export interface McpClientOptions {
  name: string
  transport: McpTransport
  timeoutMs?: number
  /** 结构化诊断（stderr/异常面）——Manager 侧据此写 mcp.log。 */
  onDiagnostics?: (entry: { level: 'warn' | 'error'; code: string; message: string }) => void
  /** 传输层意外断开（区别于 client.close() 发起的正常关闭）时回调。 */
  onClose?: (error?: Error) => void
}

/**
 * 协议层薄包装：握手/翻页/超时/取消交给官方 SDK Client，字节面走注入的自研
 * McpTransport（stdio 行分帧 / HTTP SSE 探测回退 / 代理栈）。SDK 之外的自研
 * 行为只剩两处——callTool 的 <untrusted> 包裹，与 permissionSpec 透传
 * （服务器经 Tool._meta.permissionSpec 携带，spec 内的自定义元数据位）。
 */
export class McpClient {
  readonly #adapter: SdkTransportAdapter
  readonly #client: Client
  readonly #unregister: Array<() => void> = []
  #started = false
  constructor(readonly options: McpClientOptions) {
    if (!/^[A-Za-z0-9._-]+$/.test(options.name)) throw new Error('Invalid MCP server name')
    this.#adapter = new SdkTransportAdapter(options.transport)
    this.#adapter.onUnderlyingClose = (error) => this.options.onClose?.(error)
    this.#adapter.onerror = (error) =>
      this.options.onDiagnostics?.({ level: 'error', code: 'transport', message: error.message })
    this.#client = new Client({ name: 'volund-cli', version: '0.0.0' })
  }
  async initialize(): Promise<{ protocolVersion?: string; serverInfo?: unknown }> {
    await this.#client.connect(this.#adapter)
    this.#started = true
    const protocolVersion = this.#adapter.initializeProtocolVersion
    const serverInfo = this.#client.getServerVersion()
    return {
      ...(protocolVersion === undefined ? {} : { protocolVersion }),
      ...(serverInfo ? { serverInfo } : {}),
    }
  }
  /** 全量工具清单：循环 nextCursor 翻页聚合（大 server 不再静默截断）。 */
  async listTools(): Promise<McpToolDescription[]> {
    const tools: McpToolDescription[] = []
    let cursor: string | undefined
    do {
      const page = await this.#client.listTools(cursor === undefined ? undefined : { cursor })
      for (const tool of page.tools) {
        const meta = isRecord(tool._meta) ? tool._meta : undefined
        tools.push({
          name: tool.name,
          ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
          ...(isRecord(tool.inputSchema)
            ? { inputSchema: tool.inputSchema as Record<string, JsonValue> }
            : {}),
          ...(meta && isRecord(meta.permissionSpec)
            ? { permissionSpec: meta.permissionSpec as PermissionSpec }
            : {}),
        })
      }
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined
    } while (cursor !== undefined)
    return tools
  }
  async registerTools(registry: ToolRegistry) {
    const tools = await this.listTools()
    for (const descriptor of tools) {
      const tool: Tool = {
        name: mcpToolName(this.options.name, descriptor.name),
        description: descriptor.description ?? '',
        inputSchema: descriptor.inputSchema ?? { type: 'object' },
        permissionSpec: () =>
          descriptor.permissionSpec ?? {
            custom: { mcpServer: this.options.name, mcpTool: descriptor.name },
          },
        invoke: (input, context) => this.callTool(descriptor.name, input, context),
      }
      this.#unregister.push(registry.register(tool, { kind: 'mcp', server: this.options.name }))
    }
    return tools
  }
  async callTool(
    name: string,
    input: unknown,
    context?: Pick<ToolContext, 'abortSignal'>,
  ): Promise<ToolResult> {
    const result = asRecord(
      await this.#client.callTool(
        { name, arguments: input as Record<string, unknown> },
        undefined,
        {
          ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
          ...(this.options.timeoutMs === undefined ? {} : { timeout: this.options.timeoutMs }),
        },
      ),
    )
    const text = escapeUntrusted(JSON.stringify(result.content ?? result))
    return {
      content: [
        {
          type: 'text',
          text: `<untrusted source="${escapeAttribute(mcpToolName(this.options.name, name))}">\n${text}\n</untrusted>`,
        },
      ],
      ...(result.isError === true ? { isError: true } : {}),
    }
  }
  async close() {
    this.#unregister.splice(0).forEach((remove) => remove())
    await this.#client.close()
    this.#started = false
  }
  get started() {
    return this.#started
  }
}
/**
 * SKILLS-MCPS-r1 §S3.5：工具命名对齐业界 `mcp__<server>__<tool>`（双下划线），
 * server/tool 名内非法字符替换为 `_`（与 Claude Code 一致）。
 */
export function mcpToolName(server: string, tool: string): string {
  const sanitize = (value: string) => value.replaceAll(/[^A-Za-z0-9._-]/g, '_')
  return `mcp__${sanitize(server)}__${sanitize(tool)}`
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Malformed MCP response')
  return value
}
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
function escapeUntrusted(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
function escapeAttribute(value: string) {
  return escapeUntrusted(value).replaceAll('"', '&quot;')
}
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}
