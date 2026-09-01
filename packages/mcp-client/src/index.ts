import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'

import type { PermissionSpec } from '@volund/permission'
import type { JsonValue } from '@volund/shared'
import type { Tool, ToolContext, ToolRegistry, ToolResult } from '@volund/tool-kit'

export const MCP_PROTOCOL_VERSION = '2025-03-26'
const DEFAULT_LIMIT = 4 * 1024 * 1024

type Id = number
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
  constructor(readonly options: HttpSseOptions) {
    this.#endpoint = options.url
  }
  async start(onMessage: (message: unknown) => void, onClose: (error?: Error) => void) {
    if (this.#abort) throw new Error('MCP HTTP/SSE transport already started')
    this.#abort = new AbortController()
    // 规范回退（2025-06-18）：先 POST initialize 探测 Streamable HTTP 端点；
    // 4xx/405 → 回退旧 HTTP+SSE（GET 等 endpoint 事件）。探测结果告知 client，
    // client 会用对应协议模式完成握手。
    try {
      const probe = await this.#probeStreamable()
      this.options.onProbe?.(probe === 'streamable-http' ? 'streamable-http' : 'sse')
    } catch (error) {
      onClose(asError(error))
      return
    }
    this.#loop = this.#readLoop(onMessage).catch((error) => {
      if (!this.#abort?.signal.aborted) onClose(asError(error))
    })
  }
  /**
   * POST initialize 探测：200 → 这是 Streamable HTTP 端点（Mcp-Session-Id 由
   * client 后续请求携带）；4xx → 端点是旧 SSE。网络失败抛给 onClose。
   */
  async #probeStreamable(): Promise<'streamable-http' | 'sse'> {
    const response = await (this.options.fetch ?? fetch)(this.options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
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
    if (response.ok) return 'streamable-http'
    if (response.status === 404 || response.status === 405) return 'sse'
    if (response.status === 401 || response.status === 403) return 'sse'
    return 'sse'
  }
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
      const reader = response.body.getReader()
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
      if (attempt >= maxReconnects) throw new Error('MCP SSE reconnect limit exceeded')
      await delay(
        Math.min((this.options.reconnectBaseMs ?? 100) * 2 ** attempt, 5000),
        this.#abort!.signal,
      )
    }
  }
  async send(message: unknown, signal?: AbortSignal) {
    const response = await (this.options.fetch ?? fetch)(this.#endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.options.headers },
      body: JSON.stringify(message),
      ...(signal ? { signal } : {}),
    })
    if (!response.ok) throw new Error(`MCP HTTP request failed: HTTP ${response.status}`)
    const text = await response.text()
    if (Buffer.byteLength(text) > (this.options.maxMessageBytes ?? DEFAULT_LIMIT))
      throw new Error('MCP HTTP response exceeds size limit')
  }
  async close() {
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
  maxPending?: number
  /** 结构化诊断（stderr/异常面）——Manager 侧据此写 mcp.log。 */
  onDiagnostics?: (entry: { level: 'warn' | 'error'; code: string; message: string }) => void
  /** 传输层意外断开（区别于 client.close() 发起的正常关闭）时回调。 */
  onClose?: (error?: Error) => void
}

export class McpClient {
  #nextId = 1
  #pending = new Map<Id, { resolve(value: unknown): void; reject(error: Error): void }>()
  #unregister: Array<() => void> = []
  #started = false
  constructor(readonly options: McpClientOptions) {
    if (!/^[A-Za-z0-9._-]+$/.test(options.name)) throw new Error('Invalid MCP server name')
  }
  async initialize() {
    await this.options.transport.start(
      (message) => this.#receive(message),
      (error) => {
        this.options.onClose?.(error)
        this.#fail(error ?? new Error('MCP transport closed'))
      },
    )
    const result = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'volund-cli', version: '0.0.0' },
    })
    await this.notify('notifications/initialized')
    this.#started = true
    return result
  }
  async listTools(): Promise<McpToolDescription[]> {
    const result = asRecord(await this.request('tools/list', {}))
    if (!Array.isArray(result.tools)) throw new Error('Malformed MCP tools/list response')
    return result.tools.map((tool) => {
      const value = asRecord(tool)
      if (typeof value.name !== 'string') throw new Error('Malformed MCP tool definition')
      return {
        name: value.name,
        ...(typeof value.description === 'string' ? { description: value.description } : {}),
        ...(isRecord(value.inputSchema)
          ? { inputSchema: value.inputSchema as Record<string, JsonValue> }
          : {}),
        ...(isRecord(value.permissionSpec)
          ? { permissionSpec: value.permissionSpec as PermissionSpec }
          : {}),
      }
    })
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
      await this.request(
        'tools/call',
        { name, arguments: input as JsonValue },
        context?.abortSignal,
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
  async notify(method: string, params?: JsonValue) {
    await this.options.transport.send({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    })
  }
  async request(method: string, params?: JsonValue, signal?: AbortSignal): Promise<unknown> {
    if (this.#pending.size >= (this.options.maxPending ?? 64))
      throw new Error('MCP backpressure limit exceeded')
    const id = this.#nextId++
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.#pending.delete(id)
        void this.notify('notifications/cancelled', {
          requestId: id,
          reason: String(combined.reason ?? 'cancelled'),
        }).catch(() => {})
        reject(asError(combined.reason ?? new Error('MCP request aborted')))
      }
      combined.addEventListener('abort', abort, { once: true })
      this.#pending.set(id, {
        resolve: (value) => {
          combined.removeEventListener('abort', abort)
          resolve(value)
        },
        reject: (error) => {
          combined.removeEventListener('abort', abort)
          reject(error)
        },
      })
      this.options.transport
        .send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }, combined)
        .catch((error) => {
          this.#pending.delete(id)
          reject(asError(error))
        })
    })
  }
  #receive(message: unknown) {
    if (
      !isRecord(message) ||
      message.jsonrpc !== '2.0' ||
      (typeof message.id !== 'number' && typeof message.id !== 'string')
    )
      throw new Error('Malformed MCP response')
    if (typeof message.id !== 'number') return
    const pending = this.#pending.get(message.id)
    if (!pending) return
    this.#pending.delete(message.id)
    if (isRecord(message.error))
      pending.reject(
        new Error(`MCP error ${String(message.error.code)}: ${String(message.error.message)}`),
      )
    else if ('result' in message) pending.resolve(message.result)
    else pending.reject(new Error('Malformed MCP response'))
  }
  #fail(error: Error) {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }
  async close() {
    this.#unregister.splice(0).forEach((remove) => remove())
    this.#fail(new Error('MCP client closed'))
    await this.options.transport.close()
    this.#started = false
  }
  get started() {
    return this.#started
  }
}

export function mcpToolSetHash(tools: readonly McpToolDescription[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        tools
          .map(({ name, description, inputSchema, permissionSpec }) => ({
            name,
            description,
            inputSchema,
            permissionSpec,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ),
    )
    .digest('hex')
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
