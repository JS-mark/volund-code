/**
 * 最小 RFC 6455 WebSocket 服务端（零依赖，node:http upgrade + node:crypto）。
 *
 * 覆盖面（网关通道所需子集）：
 * - 握手：GET + Upgrade/Connection/Sec-WebSocket-Key/Version=13 全校验；
 * - 帧解析：FIN/opcode/mask/16 位与 64 位扩展长度；客户端帧必须 masked（1002）；
 * - 分片重组（opcode 0 continuation），控制帧不可分片且 ≤125B（1002）；
 * - text 帧 UTF-8 fatal 校验（1007）；message 总量上限（1009）；
 * - ping → pong；close 握手回显；binary 帧不受理（1003）；
 * - 保活：定时 ping，连续两次未收到任何帧（含 pong）即 terminate。
 *
 * 不做：扩展协商（permessage-deflate 等）、子协议协商——网关只用 JSON 文本帧。
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export const WS_CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  unsupported: 1003,
  invalidPayload: 1007,
  policy: 1008,
  tooBig: 1009,
} as const

export interface WsConnectionOptions {
  /** 单条应用消息上限（分片重组后），默认 1 MiB。 */
  readonly maxMessageBytes?: number
  /** 保活 ping 间隔（默认 30s）；0 关闭。 */
  readonly pingIntervalMs?: number
}

const DEFAULT_MAX_MESSAGE = 1024 * 1024

/** 握手校验 + 101 响应；形状不符返回 false（调用方应已拒绝或销毁 socket）。 */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex): boolean {
  const upgrade = req.headers.upgrade?.toLowerCase()
  const connection = req.headers.connection?.toLowerCase() ?? ''
  const key = req.headers['sec-websocket-key']
  const version = req.headers['sec-websocket-version']
  if (
    req.method !== 'GET' ||
    upgrade !== 'websocket' ||
    !connection.split(',').some((part) => part.trim() === 'upgrade') ||
    typeof key !== 'string' ||
    key.trim() === '' ||
    version !== '13'
  )
    return false
  const accept = createHash('sha1')
    .update(key.trim() + WS_GUID)
    .digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  return true
}

/** 编码一帧服务端→客户端帧（不掩码）。文本消息 opcode 1。 */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

export class WsConnection {
  /** 应用消息回调（完整重组后的文本）。 */
  onMessage: ((text: string) => void) | undefined
  /** 连接关闭回调（code/reason 来自对端 close 帧或本地协议错误）。 */
  onClose: ((code: number, reason: string) => void) | undefined

  private buffer = Buffer.alloc(0)
  private fragments: Buffer[] = []
  private fragmentBytes = 0
  private fragmentOpcode = 0
  private closed = false
  private alive = true
  private readonly maxMessageBytes: number
  private readonly pingTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly socket: Duplex,
    options: WsConnectionOptions = {},
  ) {
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE
    socket.on('data', (chunk: Buffer) => this.consume(chunk))
    socket.on('error', () => this.terminate())
    socket.on('close', () => this.terminate())
    const interval = options.pingIntervalMs ?? 30_000
    if (interval > 0) {
      this.pingTimer = setInterval(() => {
        if (this.closed) return
        if (!this.alive) return this.terminate()
        this.alive = false
        this.ping()
      }, interval)
      this.pingTimer.unref?.()
    }
  }

  send(text: string): void {
    if (this.closed) return
    this.socket.write(encodeFrame(1, Buffer.from(text, 'utf8')))
  }

  ping(payload: Buffer = Buffer.alloc(0)): void {
    if (this.closed) return
    this.socket.write(encodeFrame(9, payload))
  }

  /** 礼貌关闭：发 close 帧后结束 TCP；对端已关闭时幂等。 */
  close(code: number = WS_CLOSE.normal, reason: string = ''): void {
    if (this.closed) return
    const reasonBytes = Buffer.from(reason, 'utf8')
    const payload = Buffer.alloc(2 + reasonBytes.length)
    payload.writeUInt16BE(code, 0)
    reasonBytes.copy(payload, 2)
    try {
      this.socket.write(encodeFrame(8, payload))
      this.socket.end()
    } catch {
      // 对端已断——terminate 收尾
    }
    this.terminate(code, reason)
  }

  private terminate(code: number = WS_CLOSE.normal, reason: string = ''): void {
    if (this.closed) return
    this.closed = true
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.socket.destroy()
    this.onClose?.(code, reason)
  }

  private fail(code: number, reason: string): void {
    // 协议错误：发 close 帧通知对端（best effort），随即 terminate。
    if (!this.closed) {
      try {
        const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 123)
        const payload = Buffer.alloc(2 + reasonBytes.length)
        payload.writeUInt16BE(code, 0)
        reasonBytes.copy(payload, 2)
        this.socket.write(encodeFrame(8, payload))
      } catch {
        // ignore
      }
    }
    this.terminate(code, reason)
  }

  private consume(chunk: Buffer): void {
    if (this.closed) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    // 单趟解析尽量多的完整帧；buffer 只保留不足一帧的尾巴。
    for (;;) {
      const frame = this.parseFrame()
      if (!frame) return
      this.alive = true
      this.dispatch(frame)
      if (this.closed) return
    }
  }

  private parseFrame(): { fin: boolean; opcode: number; payload: Buffer } | undefined {
    const buffer = this.buffer
    if (buffer.length < 2) return undefined
    const b0 = buffer[0]!
    const b1 = buffer[1]!
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let length = b1 & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < offset + 2) return undefined
      length = buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buffer.length < offset + 8) return undefined
      const big = buffer.readBigUInt64BE(offset)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.fail(WS_CLOSE.tooBig, 'frame too large')
        return undefined
      }
      length = Number(big)
      offset += 8
    }
    // 客户端→服务端帧必须掩码（RFC 6455 §5.3）。
    if (!masked) {
      this.fail(WS_CLOSE.protocolError, 'client frames must be masked')
      return undefined
    }
    if (buffer.length < offset + 4 + length) return undefined
    const mask = buffer.subarray(offset, offset + 4)
    offset += 4
    const payload = Buffer.from(buffer.subarray(offset, offset + length))
    for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!
    this.buffer = buffer.subarray(offset + length)
    return { fin, opcode, payload }
  }

  private dispatch(frame: { fin: boolean; opcode: number; payload: Buffer }): void {
    const { fin, opcode, payload } = frame
    // 控制帧：不可分片、≤125B。
    if (opcode >= 8) {
      if (!fin || payload.length > 125)
        return this.fail(WS_CLOSE.protocolError, 'malformed control frame')
      if (opcode === 8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : WS_CLOSE.normal
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
        // close 握手回显后即终止。
        try {
          if (!this.closed) this.socket.write(encodeFrame(8, payload))
          this.socket.end()
        } catch {
          // ignore
        }
        return this.terminate(code, reason)
      }
      if (opcode === 9) return void this.socket.write(encodeFrame(10, payload))
      // opcode 10 (pong)：alive 已在 consume 里刷新，无需处理。
      return
    }
    if (opcode === 2) return this.fail(WS_CLOSE.unsupported, 'binary frames are not accepted')
    if (opcode === 1) {
      if (this.fragments.length > 0)
        return this.fail(WS_CLOSE.protocolError, 'new message before continuation finished')
      if (payload.length > this.maxMessageBytes)
        return this.fail(WS_CLOSE.tooBig, 'message too large')
      if (fin) return this.emitMessage(payload)
      this.fragmentOpcode = 1
      this.fragments = [payload]
      this.fragmentBytes = payload.length
      return
    }
    if (opcode === 0) {
      if (this.fragments.length === 0 || this.fragmentOpcode !== 1)
        return this.fail(WS_CLOSE.protocolError, 'unexpected continuation frame')
      this.fragments.push(payload)
      this.fragmentBytes += payload.length
      if (this.fragmentBytes > this.maxMessageBytes)
        return this.fail(WS_CLOSE.tooBig, 'message too large')
      if (fin) {
        const whole = Buffer.concat(this.fragments)
        this.fragments = []
        this.fragmentBytes = 0
        this.emitMessage(whole)
      }
      return
    }
    this.fail(WS_CLOSE.protocolError, `unknown opcode ${opcode}`)
  }

  private emitMessage(payload: Buffer): void {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let text: string
    try {
      text = decoder.decode(payload)
    } catch {
      return this.fail(WS_CLOSE.invalidPayload, 'message is not valid UTF-8')
    }
    this.onMessage?.(text)
  }
}
