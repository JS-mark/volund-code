import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

import type { McpTransport } from './index'

/**
 * 自研 McpTransport（字节面：stdio 行分帧 / HTTP SSE / 代理栈）→ SDK Transport 桥。
 * 协议收发（握手/翻页/超时/取消）交给 SDK Client，本类只搬运消息。
 *
 * SDK Protocol.connect 会覆写 `onclose`，底层断线错误（stdio 退出码 / HTTP 状态）
 * 由 `onUnderlyingClose` 独立上报；服务器的 protocolVersion 不经 SDK 对外暴露，
 * 在 onmessage 里从 initialize 响应截获（`initializeProtocolVersion`）。
 */
export class SdkTransportAdapter implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  initializeProtocolVersion: string | undefined
  onUnderlyingClose?: (error?: Error) => void
  readonly #inner: McpTransport
  #started = false
  constructor(inner: McpTransport) {
    this.#inner = inner
  }
  async start(): Promise<void> {
    if (this.#started) throw new Error('MCP transport already started')
    this.#started = true
    await this.#inner.start(
      (message) => {
        const result = (message as { result?: { protocolVersion?: unknown } }).result
        if (result && typeof result === 'object' && typeof result.protocolVersion === 'string')
          this.initializeProtocolVersion = result.protocolVersion
        this.onmessage?.(message as JSONRPCMessage)
      },
      (error) => {
        this.onUnderlyingClose?.(error)
        this.onclose?.()
      },
    )
  }
  send(message: JSONRPCMessage): Promise<void> {
    return this.#inner.send(message)
  }
  async close(): Promise<void> {
    this.#started = false
    await this.#inner.close()
  }
}
