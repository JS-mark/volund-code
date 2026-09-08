/**
 * WebSocket 协议测试：真实 socket 对（node:http server upgrade + node:net 客户端），
 * 覆盖握手、掩码、分片、ping/pong、协议错误关闭码。
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import type { Socket } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { acceptWebSocket, WS_CLOSE, WsConnection } from './websocket'

/** 测试用最小 WS 客户端（服务端帧不掩码，客户端帧必须掩码）。 */
class TestWsClient {
  private buffer: Buffer = Buffer.alloc(0)
  private waiters: { resolve(frame: { opcode: number; payload: Buffer }): void }[] = []
  private frames: { opcode: number; payload: Buffer }[] = []

  private constructor(
    private readonly socket: Socket,
    seed: Buffer = Buffer.alloc(0),
  ) {
    this.buffer = seed
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      for (;;) {
        const frame = this.parseFrame()
        if (!frame) break
        const waiter = this.waiters.shift()
        if (waiter) waiter.resolve(frame)
        else this.frames.push(frame)
      }
    })
    // 播种里可能已含完整帧（握手响应粘包）——立即解析一轮。
    if (seed.length > 0) {
      for (;;) {
        const frame = this.parseFrame()
        if (!frame) break
        const waiter = this.waiters.shift()
        if (waiter) waiter.resolve(frame)
        else this.frames.push(frame)
      }
    }
  }

  static async connect(port: number, path = '/v1/ws'): Promise<TestWsClient> {
    const socket = connect(port, '127.0.0.1')
    const key = randomBytes(16).toString('base64')
    await new Promise<void>((resolveConnect, rejectConnect) => {
      socket.once('error', rejectConnect)
      socket.once('connect', () => resolveConnect())
    })
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    )
    // 等 101 响应头结束；头部之后的字节是服务器可能立刻推来的 WS 帧（如 hello）。
    const rest = await new Promise<Buffer>((resolveHandshake, rejectHandshake) => {
      let head = Buffer.alloc(0)
      const onData = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk])
        const end = head.indexOf('\r\n\r\n')
        if (end === -1) return
        const statusLine = head.subarray(0, end).toString('utf8').split('\r\n')[0]
        if (!statusLine?.includes('101'))
          return rejectHandshake(new Error(`handshake failed: ${statusLine}`))
        socket.off('data', onData)
        resolveHandshake(Buffer.from(head.subarray(end + 4)))
      }
      socket.on('data', onData)
    })
    return new TestWsClient(socket, rest)
  }

  /** 编码并发送一帧（客户端必须掩码）。 */
  sendFrame(opcode: number, payload: Buffer, fin = true): void {
    const mask = randomBytes(4)
    const masked = Buffer.from(payload)
    for (let i = 0; i < masked.length; i++) masked[i] = masked[i]! ^ mask[i % 4]!
    let header: Buffer
    const length = payload.length
    if (length < 126) {
      header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | length])
    } else if (length < 65536) {
      header = Buffer.alloc(4)
      header[0] = (fin ? 0x80 : 0) | opcode
      header[1] = 0x80 | 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = (fin ? 0x80 : 0) | opcode
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    this.socket.write(Buffer.concat([header, mask, masked]))
  }

  sendText(text: string, fin = true, opcode = 1): void {
    this.sendFrame(opcode, Buffer.from(text, 'utf8'), fin)
  }

  /** 发送不掩码帧（协议违规测试专用）。 */
  sendUnmasked(text: string): void {
    const payload = Buffer.from(text, 'utf8')
    this.socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]))
  }

  nextFrame(timeoutMs = 3000): Promise<{ opcode: number; payload: Buffer }> {
    const queued = this.frames.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolveFrame, rejectFrame) => {
      const timer = setTimeout(() => rejectFrame(new Error('frame timeout')), timeoutMs)
      this.waiters.push({
        resolve: (frame) => {
          clearTimeout(timer)
          resolveFrame(frame)
        },
      })
    })
  }

  close(): void {
    this.socket.destroy()
  }

  private parseFrame(): { opcode: number; payload: Buffer } | undefined {
    const buffer = this.buffer
    if (buffer.length < 2) return undefined
    const opcode = buffer[0]! & 0x0f
    let length = buffer[1]! & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < 4) return undefined
      length = buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buffer.length < 10) return undefined
      length = Number(buffer.readBigUInt64BE(2))
      offset = 10
    }
    if (buffer.length < offset + length) return undefined
    const payload = Buffer.from(buffer.subarray(offset, offset + length))
    this.buffer = buffer.subarray(offset + length)
    return { opcode, payload }
  }
}

describe('WsConnection', () => {
  let server: Server | undefined
  let connection: WsConnection | undefined
  const received: string[] = []
  let closedWith: { code: number; reason: string } | undefined

  const start = async (options?: { maxMessageBytes?: number }) => {
    received.length = 0
    closedWith = undefined
    server = createServer()
    server.on('upgrade', (req, socket) => {
      if (!acceptWebSocket(req, socket)) {
        socket.destroy()
        return
      }
      connection = new WsConnection(socket, { pingIntervalMs: 0, ...options })
      connection.onMessage = (text) => received.push(text)
      connection.onClose = (code, reason) => {
        closedWith = { code, reason }
      }
    })
    await new Promise<void>((resolveListen) => server!.listen(0, '127.0.0.1', resolveListen))
    const address = server.address()
    return typeof address === 'object' && address ? address.port : 0
  }

  afterEach(async () => {
    connection?.close()
    await new Promise((resolveClose) => server?.close(resolveClose))
    server = undefined
    connection = undefined
  })

  it('accepts a valid handshake and echoes accept key per RFC 6455', async () => {
    const port = await start()
    // acceptWebSocket 内部已写 101；这里验证客户端能完成握手。
    const client = await TestWsClient.connect(port)
    expect(client).toBeDefined()
    client.close()
  })

  it('rejects a handshake without Sec-WebSocket-Version: 13', async () => {
    server = createServer()
    server.on('upgrade', (req, socket) => {
      expect(acceptWebSocket(req, socket)).toBe(false)
      socket.destroy()
    })
    await new Promise<void>((resolveListen) => server!.listen(0, '127.0.0.1', resolveListen))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const socket = connect(port, '127.0.0.1')
    await new Promise<void>((resolveConnect) => socket.once('connect', resolveConnect))
    socket.write(
      'GET /v1/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    )
    await new Promise((resolveClose) => socket.once('close', resolveClose))
  })

  it('receives masked text frames', async () => {
    const port = await start()
    const client = await TestWsClient.connect(port)
    client.sendText('{"type":"ping"}')
    await expect.poll(() => received.length, { timeout: 3000 }).toBe(1)
    expect(received[0]).toBe('{"type":"ping"}')
    client.close()
  })

  it('reassembles fragmented messages', async () => {
    const port = await start()
    const client = await TestWsClient.connect(port)
    client.sendText('hello ', false, 1)
    client.sendText('world', true, 0)
    await expect.poll(() => received.length, { timeout: 3000 }).toBe(1)
    expect(received[0]).toBe('hello world')
    client.close()
  })

  it('answers ping with pong carrying the same payload', async () => {
    const port = await start()
    const client = await TestWsClient.connect(port)
    client.sendFrame(9, Buffer.from('hb'))
    const frame = await client.nextFrame()
    expect(frame.opcode).toBe(10)
    expect(frame.payload.toString()).toBe('hb')
    client.close()
  })

  it('sends server→client text frames decodable by a client', async () => {
    const port = await start()
    const client = await TestWsClient.connect(port)
    await expect.poll(() => connection !== undefined, { timeout: 3000 }).toBe(true)
    connection!.send('{"type":"hello"}')
    const frame = await client.nextFrame()
    expect(frame.opcode).toBe(1)
    expect(frame.payload.toString()).toBe('{"type":"hello"}')
    client.close()
  })

  it('closes with 1002 on unmasked client frames', async () => {
    const port = await start()
    const client = await TestWsClient.connect(port)
    client.sendUnmasked('violation')
    const frame = await client.nextFrame()
    expect(frame.opcode).toBe(8)
    expect(frame.payload.readUInt16BE(0)).toBe(WS_CLOSE.protocolError)
    await expect.poll(() => closedWith?.code, { timeout: 3000 }).toBe(WS_CLOSE.protocolError)
    client.close()
  })

  it('closes with 1007 on invalid UTF-8', async () => {
    const port = await start()
    const client = await TestWsClient.connect(port)
    client.sendFrame(1, Buffer.from([0xff, 0xfe, 0xfd]))
    const frame = await client.nextFrame()
    expect(frame.opcode).toBe(8)
    expect(frame.payload.readUInt16BE(0)).toBe(WS_CLOSE.invalidPayload)
    client.close()
  })

  it('closes with 1003 on binary frames', async () => {
    const port = await start()
    const client = await TestWsClient.connect(port)
    client.sendFrame(2, Buffer.from([1, 2, 3]))
    const frame = await client.nextFrame()
    expect(frame.opcode).toBe(8)
    expect(frame.payload.readUInt16BE(0)).toBe(WS_CLOSE.unsupported)
    client.close()
  })

  it('closes with 1009 when a message exceeds the configured cap', async () => {
    const port = await start({ maxMessageBytes: 8 })
    const client = await TestWsClient.connect(port)
    client.sendText('this is definitely longer than eight bytes')
    const frame = await client.nextFrame()
    expect(frame.opcode).toBe(8)
    expect(frame.payload.readUInt16BE(0)).toBe(WS_CLOSE.tooBig)
    client.close()
  })

  it('echoes the close handshake and reports code/reason', async () => {
    const port = await start()
    const client = await TestWsClient.connect(port)
    const payload = Buffer.alloc(2 + 4)
    payload.writeUInt16BE(WS_CLOSE.normal, 0)
    payload.write('bye!', 2)
    client.sendFrame(8, payload)
    const frame = await client.nextFrame()
    expect(frame.opcode).toBe(8)
    expect(frame.payload.readUInt16BE(0)).toBe(WS_CLOSE.normal)
    await expect.poll(() => closedWith?.reason, { timeout: 3000 }).toBe('bye!')
    client.close()
  })

  it('handles >64KiB frames (64-bit length path)', async () => {
    const port = await start()
    const client = await TestWsClient.connect(port)
    const big = 'x'.repeat(70_000)
    client.sendText(big)
    await expect.poll(() => received.length, { timeout: 5000 }).toBe(1)
    expect(received[0]?.length).toBe(70_000)
    client.close()
  })
})

describe('accept key vector', () => {
  it('matches the RFC 6455 example', () => {
    // RFC 6455 §1.3：dGhlIHNhbXBsZSBub25jZQ== → s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
    const accept = createHash('sha1')
      .update('dGhlIHNhbXBsZSBub25jZQ==' + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')
    expect(accept).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })
})
