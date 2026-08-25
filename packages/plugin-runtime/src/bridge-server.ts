/**
 * 沙箱插件宿主的 fd3 JSONRPC 桥（crates/apollo-sandbox/src/plugin_host.mjs 协议）
 * 的主进程侧实现。协议要点（v1）：
 *
 * - 每帧一行 NDJSON：`{ jsonrpc: '2.0', bridgeVersion: 1, ... }`
 * - 插件 → 宿主请求：`{ id, method: 'apollo.<path>', params }`；宿主回
 *   `{ id, result }` 或 `{ id, error: { code: -32000, message } }`
 * - 插件 → 宿主通知：`host.ready` / `host.activated` / `host.heartbeat`（无 id）
 * - 宿主 → 插件回调：`{ id, method: 'callback.invoke', params: { callbackId, args } }`，
 *   插件回 `{ id, result }`
 * - 函数值双向以 `{ $callback: '<id>' }` 占位符编解码；宿主侧落地为 PluginCallbackRef
 */

/** 插件侧函数的宿主侧句柄（经 callback.invoke 反向调用）。 */
export class PluginCallbackRef {
  constructor(readonly callbackId: string) {}
}

export interface PluginBridgeServerOptions {
  /** 单帧字节上限（与宿主侧 MAX_FRAME 对齐，默认 1 MiB）。 */
  frameBytes?: number
  /** callback.invoke 与握手等待的超时（默认 10s，与宿主侧 rpc 超时对齐）。 */
  callTimeoutMs?: number
}

interface BridgeFrame {
  jsonrpc?: string
  bridgeVersion?: number
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

const PROTOCOL_VERSION = 1
const DEFAULT_FRAME_BYTES = 1024 * 1024
const DEFAULT_CALL_TIMEOUT_MS = 10_000

export class PluginBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'PluginBridgeError'
  }
}

export class PluginBridgeServer {
  /** 插件请求的宿主侧分发入口；返回值的函数属性编码为 $callback。 */
  onRequest: ((method: string, params: unknown) => unknown) | undefined

  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void; timeout: NodeJS.Timeout }
  >()
  readonly #notifications = new Map<string, (params: unknown) => void>()
  #buffer = ''
  #nextId = 1
  #closed = false

  constructor(
    readonly stream: NodeJS.ReadWriteStream,
    readonly options: PluginBridgeServerOptions = {},
  ) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => this.#onData(chunk))
    stream.on('close', () =>
      this.close(new PluginBridgeError('plugin_bridge_closed', 'bridge closed')),
    )
    stream.on('error', (error) => this.close(error))
  }

  /** 等待一次性通知（host.ready / host.activated）；重复到达的 heartbeat 用 waitFor 会泄漏，请用 onHeartbeat。 */
  waitFor(method: string, timeoutMs = this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS) {
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#notifications.delete(method)
        reject(new PluginBridgeError('plugin_bridge_timeout', `timed out waiting for ${method}`))
      }, timeoutMs)
      this.#notifications.set(method, (params) => {
        clearTimeout(timeout)
        this.#notifications.delete(method)
        resolve(params)
      })
    })
  }

  /** 反向调用插件注册的回调（如 ui.status registerTab 的 render）。 */
  invokeCallback(
    ref: PluginCallbackRef,
    args: readonly unknown[] = [],
    timeoutMs = this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.#closed)
      return Promise.reject(new PluginBridgeError('plugin_bridge_closed', 'bridge closed'))
    const id = this.#nextId++
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id)
        reject(
          new PluginBridgeError('plugin_bridge_timeout', `callback ${ref.callbackId} timed out`),
        )
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timeout })
    })
    this.#write({
      id,
      method: 'callback.invoke',
      params: { callbackId: ref.callbackId, args: args.map(encodeValue) },
    })
    return result
  }

  close(reason?: Error): void {
    if (this.#closed) return
    this.#closed = true
    const error = reason ?? new PluginBridgeError('plugin_bridge_closed', 'bridge closed')
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.#pending.clear()
    this.#notifications.clear()
  }

  #onData(chunk: string): void {
    this.#buffer += chunk
    const frameBytes = this.options.frameBytes ?? DEFAULT_FRAME_BYTES
    if (Buffer.byteLength(this.#buffer) > frameBytes && !this.#buffer.includes('\n')) {
      this.close(
        new PluginBridgeError('plugin_bridge_frame_too_large', 'bridge frame exceeds limit'),
      )
      return
    }
    for (;;) {
      const newline = this.#buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      if (!line) continue
      if (Buffer.byteLength(line) > frameBytes) {
        this.close(
          new PluginBridgeError('plugin_bridge_frame_too_large', 'bridge frame exceeds limit'),
        )
        return
      }
      let frame: BridgeFrame
      try {
        frame = JSON.parse(line) as BridgeFrame
      } catch {
        this.close(new PluginBridgeError('plugin_bridge_invalid_json', 'invalid bridge JSON'))
        return
      }
      if (frame.jsonrpc !== '2.0' || frame.bridgeVersion !== PROTOCOL_VERSION) {
        this.close(new PluginBridgeError('plugin_bridge_protocol', 'unsupported bridge protocol'))
        return
      }
      this.#onFrame(frame)
    }
  }

  #onFrame(frame: BridgeFrame): void {
    // 响应帧：有 id 无 method
    if (typeof frame.id === 'number' && !frame.method) {
      const pending = this.#pending.get(frame.id)
      if (!pending) return
      this.#pending.delete(frame.id)
      clearTimeout(pending.timeout)
      if (frame.error)
        pending.reject(
          new PluginBridgeError('plugin_bridge_remote', frame.error.message ?? 'RPC failed'),
        )
      else pending.resolve(decodeValue(frame.result))
      return
    }
    if (typeof frame.method !== 'string') return
    // 通知帧：有 method 无 id
    if (typeof frame.id !== 'number') {
      this.#notifications.get(frame.method)?.(frame.params)
      return
    }
    // 请求帧：插件调用宿主
    const id = frame.id
    const method = frame.method
    const reply = (body: { result?: unknown; error?: { code: number; message: string } }) =>
      this.#write({ id, ...body })
    void Promise.resolve()
      .then(() => {
        if (!this.onRequest) throw new PluginBridgeError('plugin_bridge_no_handler', method)
        return this.onRequest(method, decodeValue(frame.params))
      })
      .then(
        (result) => reply({ result: encodeValue(result) }),
        (error: unknown) =>
          reply({
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
      )
  }

  #write(frame: {
    id?: number
    method?: string
    params?: unknown
    result?: unknown
    error?: unknown
  }): void {
    if (this.#closed) return
    const line = `${JSON.stringify({ jsonrpc: '2.0', bridgeVersion: PROTOCOL_VERSION, ...frame })}\n`
    if (Buffer.byteLength(line) > (this.options.frameBytes ?? DEFAULT_FRAME_BYTES))
      throw new PluginBridgeError('plugin_bridge_frame_too_large', 'bridge frame exceeds limit')
    this.stream.write(line)
  }
}

/** 宿主 → 插件方向编码：函数落地为 $callback 占位（当前仅用于对称完整，宿主侧不注册回调）。 */
export function encodeValue(value: unknown): unknown {
  if (typeof value === 'function') return { $callback: 'host-callback-unsupported' }
  if (Array.isArray(value)) return value.map(encodeValue)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, encodeValue(entry)]),
    )
  return value
}

/** 插件 → 宿主方向解码：`{ $callback }` 占位还原为 PluginCallbackRef。 */
export function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.$callback === 'string' && Object.keys(record).length === 1)
      return new PluginCallbackRef(record.$callback)
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [key, decodeValue(entry)]),
    )
  }
  return value
}
