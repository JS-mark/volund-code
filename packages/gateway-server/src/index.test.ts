/**
 * 网关服务器集成测试：真实 HTTP/WS 端口 + 内存假 hub。
 * 覆盖 OAuth 颁证、Bearer 门、chat/completions（SSE + 聚合）、WS 通道、
 * 限流、CORS、审批超时兜底。
 */
import { randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import type { Socket } from 'node:net'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { GatewayEnvelope, GatewayHubLike } from './hub'
import { createGatewayServer } from './index'
import type { GatewayServerHandle } from './index'
import { deriveSigningKey } from './oauth'

const CLIENT = { id: 'test-client', secret: 'c'.repeat(43), scopes: ['chat', 'sessions'] }

class FakeHub implements GatewayHubLike {
  activeSession: { id: string; cwd?: string } | undefined
  readonly listeners = new Set<(envelope: GatewayEnvelope) => void>()
  readonly submitted: { prompt: string; model?: string }[] = []
  readonly decisions: [string, string][] = []
  private counter = 0

  get active(): { id: string; cwd?: string } | undefined {
    return this.activeSession
  }

  async start(input: { cwd: string }): Promise<{ id: string }> {
    this.counter += 1
    this.activeSession = { id: `sess-${this.counter}`, cwd: input.cwd }
    this.emit('view', { type: 'session.attached', id: `sess-${this.counter}`, cwd: input.cwd })
    return { id: `sess-${this.counter}` }
  }

  async resume(id: string): Promise<{ id: string }> {
    if (id !== 'existing-sess')
      throw new Error(`Session not found or has no resumable events: ${id}`)
    this.activeSession = { id }
    this.emit('view', { type: 'session.attached', id })
    return { id }
  }

  async submit(input: { prompt: string; model?: string }): Promise<'accepted'> {
    if (!this.activeSession)
      throw Object.assign(new Error('no active session'), { code: 'web_session_invalid' })
    this.submitted.push(input)
    // setTimeout 而非 queueMicrotask：模拟真实 hub「先 202 accepted、后流式事件」
    // 的顺序（runner 的 delta 来自网络流，必然晚于 accept 应答）。
    setTimeout(() => {
      this.emit('core', {
        type: 'stream.delta',
        payload: { messageId: 'm1', kind: 'text', fragment: 'Hello' },
      })
      this.emit('core', {
        type: 'stream.delta',
        payload: { messageId: 'm1', kind: 'text', fragment: ', world' },
      })
      this.emit('core', {
        type: 'turn.completed',
        payload: { usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUSD: 0.001 } },
      })
    }, 0)
    return 'accepted'
  }

  async interrupt(): Promise<void> {
    this.emit('core', { type: 'turn.aborted', payload: { reason: 'user_interrupt' } })
  }

  async closeActive(): Promise<void> {
    this.activeSession = undefined
  }

  subscribe(listener: (envelope: GatewayEnvelope) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  decide(requestId: string, kind: string): boolean {
    this.decisions.push([requestId, kind])
    return true
  }

  pendingPermissionIds(): string[] {
    return []
  }

  emit(kind: string, event: unknown): void {
    for (const listener of this.listeners) listener({ kind, event })
  }
}

let server: GatewayServerHandle | undefined
let hub: FakeHub
let base = ''

beforeEach(async () => {
  hub = new FakeHub()
})

afterEach(async () => {
  await server?.close()
  server = undefined
})

async function startServer(overrides: Record<string, unknown> = {}): Promise<void> {
  server = await createGatewayServer({
    host: '127.0.0.1',
    port: 0,
    version: '0.0.0-test',
    workspaceCwd: process.cwd(),
    oauth: {
      issuer: 'volund-gateway-test',
      signingKey: deriveSigningKey('integration-test-key'),
      tokenTtlSeconds: 3600,
      clients: [CLIENT],
    },
    hub,
    listModels: async () => [{ id: 'openai/gpt-4o', label: 'gpt-4o' }],
    listSessions: async () => [{ id: 'existing-sess', title: 'demo' }],
    ...overrides,
  })
  base = server.url
}

async function fetchToken(extra: Record<string, string> = {}): Promise<string> {
  const response = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT.id,
      client_secret: CLIENT.secret,
      ...extra,
    }),
  })
  const body = (await response.json()) as { access_token?: string }
  if (!body.access_token) throw new Error(`token request failed: ${response.status}`)
  return body.access_token
}

describe('oauth token endpoint', () => {
  it('issues a token for valid client credentials (form)', async () => {
    await startServer()
    const token = await fetchToken()
    expect(token.split('.')).toHaveLength(3)
  })

  it('accepts JSON bodies and Basic auth', async () => {
    await startServer()
    const basic = Buffer.from(`${CLIENT.id}:${CLIENT.secret}`).toString('base64')
    const response = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${basic}` },
      body: JSON.stringify({ grant_type: 'client_credentials' }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { token_type: string; expires_in: number }
    expect(body.token_type).toBe('Bearer')
    expect(body.expires_in).toBe(3600)
  })

  it('rejects wrong secret with 401 gateway_client_rejected', async () => {
    await startServer()
    const response = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT.id,
        client_secret: 'wrong-secret-value',
      }),
    })
    expect(response.status).toBe(401)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'gateway_client_rejected',
    )
  })

  it('rejects unsupported grant types', async () => {
    await startServer()
    const response = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: CLIENT.id,
        client_secret: CLIENT.secret,
      }),
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'gateway_grant_unsupported',
    )
  })

  it('rate-limits token requests per IP', async () => {
    await startServer({ tokenRateLimitPerMinute: 2 })
    await fetchToken().catch(() => {})
    await fetchToken().catch(() => {})
    const third = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT.id,
        client_secret: CLIENT.secret,
      }),
    })
    expect(third.status).toBe(429)
    expect(third.headers.get('retry-after')).toBeTruthy()
  })
})

describe('auth gate', () => {
  it('rejects requests without a bearer token', async () => {
    await startServer()
    const response = await fetch(`${base}/v1/models`)
    expect(response.status).toBe(401)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'gateway_auth_invalid',
    )
    expect(response.headers.get('www-authenticate')).toContain('Bearer')
  })

  it('rejects expired tokens', async () => {
    await startServer({
      oauth: {
        issuer: 'volund-gateway-test',
        signingKey: deriveSigningKey('integration-test-key'),
        // TTL 0：签发即过期
        tokenTtlSeconds: 0,
        clients: [CLIENT],
      },
    })
    const token = await fetchToken()
    const response = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(401)
  })

  it('serves health without auth', async () => {
    await startServer()
    const response = await fetch(`${base}/v1/health`)
    expect(response.status).toBe(200)
    expect(((await response.json()) as { status: string }).status).toBe('ok')
  })
})

describe('models and sessions', () => {
  it('lists models in the OpenAI shape', async () => {
    await startServer()
    const token = await fetchToken()
    const response = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { object: string; data: { id: string }[] }
    expect(body.object).toBe('list')
    expect(body.data[0]?.id).toBe('openai/gpt-4o')
  })

  it('lists resumable sessions', async () => {
    await startServer()
    const token = await fetchToken()
    const response = await fetch(`${base}/v1/sessions`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const body = (await response.json()) as { sessions: { id: string }[] }
    expect(body.sessions[0]?.id).toBe('existing-sess')
  })
})

describe('chat/completions', () => {
  it('aggregates a non-streamed completion', async () => {
    await startServer()
    const token = await fetchToken()
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'say hi' },
        ],
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-volund-session-id')).toBe('sess-1')
    const body = (await response.json()) as {
      object: string
      choices: { message: { role: string; content: string }; finish_reason: string }[]
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
    }
    expect(body.object).toBe('chat.completion')
    expect(body.choices[0]?.message.content).toBe('Hello, world')
    expect(body.choices[0]?.finish_reason).toBe('stop')
    expect(body.usage.total_tokens).toBe(15)
    // 无 '/' 的 model 补了默认 provider 前缀；逐字稿含 system 行。
    expect(hub.submitted[0]?.model).toBe('openai/gpt-4o')
    expect(hub.submitted[0]?.prompt).toContain('[system]')
    expect(hub.submitted[0]?.prompt).toContain('say hi')
  })

  it('streams SSE chunks and terminates with [DONE]', async () => {
    await startServer()
    const token = await fetchToken()
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await response.text()
    const lines = text.split('\n').filter((line) => line.startsWith('data: '))
    const payloads = lines.map((line) => line.slice(6))
    expect(payloads.at(-1)).toBe('[DONE]')
    const chunks = payloads.slice(0, -1).map((payload) => JSON.parse(payload))
    expect(chunks[0].choices[0].delta.role).toBe('assistant')
    const content = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? '').join('')
    expect(content).toBe('Hello, world')
    const usageChunk = chunks.find((chunk) => chunk.usage)
    expect(usageChunk?.usage?.total_tokens).toBe(15)
  })

  it('rejects non-text content parts', async () => {
    await startServer()
    const token = await fetchToken()
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:...' } }] },
        ],
      }),
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'gateway_unsupported_content',
    )
  })

  it('returns 409 when another session is active and no session_id is given', async () => {
    await startServer()
    hub.activeSession = { id: 'busy-sess' }
    const token = await fetchToken()
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'gateway_session_busy',
    )
  })

  it('resumes an existing session by session_id and only submits the last user message', async () => {
    await startServer()
    const token = await fetchToken()
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: 'existing-sess',
        messages: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'first answer' },
          { role: 'user', content: 'follow up' },
        ],
      }),
    })
    expect(response.status).toBe(200)
    expect(hub.submitted[0]?.prompt).toBe('follow up')
    // 续接会话不被 one-shot 关闭
    expect(hub.active?.id).toBe('existing-sess')
  })

  it('returns 404 for an unknown session_id', async () => {
    await startServer()
    const token = await fetchToken()
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: 'missing-sess',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'gateway_session_not_found',
    )
  })

  it('maps error-aborted turns to 502 with the runner error message', async () => {
    await startServer()
    hub.submit = async (input: { prompt: string; model?: string }) => {
      hub.submitted.push(input)
      setTimeout(() => {
        hub.emit('core', {
          type: 'error.raised',
          payload: {
            code: 'runner_error',
            context: { message: 'Anthropic credential unavailable' },
          },
        })
        hub.emit('core', { type: 'turn.aborted', payload: { reason: 'error' } })
      }, 0)
      return 'accepted'
    }
    const token = await fetchToken()
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('gateway_upstream_failed')
    expect(body.error.message).toContain('Anthropic credential unavailable')
  })

  it('streams an in-band error frame when the turn fails mid-stream', async () => {
    await startServer()
    hub.submit = async () => {
      setTimeout(() => {
        hub.emit('core', {
          type: 'error.raised',
          payload: { code: 'runner_error', context: { message: 'upstream exploded' } },
        })
        hub.emit('core', { type: 'turn.aborted', payload: { reason: 'error' } })
      }, 0)
      return 'accepted'
    }
    const token = await fetchToken()
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('gateway_upstream_failed')
    expect(text).toContain('upstream exploded')
    expect(text.trim().endsWith('data: [DONE]')).toBe(true)
  })

  it('rate-limits API calls per client', async () => {
    await startServer({ rateLimitPerMinute: 2 })
    const token = await fetchToken()
    const call = () => fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${token}` } })
    await call()
    await call()
    const third = await call()
    expect(third.status).toBe(429)
    expect(((await third.json()) as { error: { code: string } }).error.code).toBe(
      'gateway_rate_limited',
    )
  })
})

describe('CORS', () => {
  it('answers preflight for whitelisted origins only', async () => {
    await startServer({ corsOrigins: ['https://app.example'] })
    const allowed = await fetch(`${base}/v1/models`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example' },
    })
    expect(allowed.status).toBe(204)
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example')
    const denied = await fetch(`${base}/v1/models`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    })
    expect(denied.status).toBe(403)
  })

  it('omits CORS headers by default', async () => {
    await startServer()
    const response = await fetch(`${base}/v1/health`, {
      headers: { origin: 'https://app.example' },
    })
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('permission timeout fallback', () => {
  it('auto-denies an undecided permission request after the timeout', async () => {
    await startServer({ permissionTimeoutMs: 50 })
    hub.emit('view', {
      type: 'permission.request',
      request: {
        id: 'perm-1',
        attempt: 1,
        display: { approvable: true, spec: 'x', toolName: 'Bash' },
      },
    })
    await expect.poll(() => hub.decisions.length, { timeout: 3000, interval: 20 }).toBe(1)
    expect(hub.decisions[0]).toEqual(['perm-1', 'deny'])
  })
})

describe('websocket channel', () => {
  /** 带认证的 WS 客户端（复用 websocket.test.ts 的思路，支持 Bearer 头与查询参数）。 */
  async function wsConnect(
    path = '/v1/ws',
    headers: Record<string, string> = {},
  ): Promise<{
    socket: Socket
    send: (value: unknown) => void
    nextMessage: () => Promise<Record<string, unknown>>
    close: () => void
  }> {
    const address = server!.url
    const port = Number(new URL(address).port)
    const socket = connect(port, '127.0.0.1')
    const key = randomBytes(16).toString('base64')
    await new Promise<void>((resolveConnect, rejectConnect) => {
      socket.once('error', rejectConnect)
      socket.once('connect', () => resolveConnect())
    })
    const extraHeaders = Object.entries(headers)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join('')
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extraHeaders}\r\n`,
    )
    const rest = await new Promise<Buffer>((resolveHandshake, rejectHandshake) => {
      let head = Buffer.alloc(0)
      const onData = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk])
        const end = head.indexOf('\r\n\r\n')
        if (end === -1) return
        const status = head.subarray(0, end).toString('utf8').split('\r\n')[0] ?? ''
        if (!status.includes('101'))
          return rejectHandshake(new Error(`handshake failed: ${status}`))
        socket.off('data', onData)
        resolveHandshake(Buffer.from(head.subarray(end + 4)))
      }
      socket.on('data', onData)
    })

    let buffer = rest
    const waiters: { resolve(value: Record<string, unknown>): void }[] = []
    const messages: Record<string, unknown>[] = []
    const parseFrames = () => {
      for (;;) {
        if (buffer.length < 2) return
        let length = buffer[1]! & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (buffer.length < 10) return
          length = Number(buffer.readBigUInt64BE(2))
          offset = 10
        }
        if (buffer.length < offset + length) return
        const opcode = buffer[0]! & 0x0f
        const payload = Buffer.from(buffer.subarray(offset, offset + length))
        buffer = buffer.subarray(offset + length)
        if (opcode !== 1) continue
        const message = JSON.parse(payload.toString('utf8')) as Record<string, unknown>
        const waiter = waiters.shift()
        if (waiter) waiter.resolve(message)
        else messages.push(message)
      }
    }
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      parseFrames()
    })
    parseFrames()

    return {
      socket,
      send: (value: unknown) => {
        const payload = Buffer.from(JSON.stringify(value), 'utf8')
        const mask = randomBytes(4)
        const masked = Buffer.from(payload)
        for (let i = 0; i < masked.length; i++) masked[i] = masked[i]! ^ mask[i % 4]!
        const header =
          payload.length < 126
            ? Buffer.from([0x81, 0x80 | payload.length])
            : (() => {
                const extended = Buffer.alloc(4)
                extended[0] = 0x81
                extended[1] = 0x80 | 126
                extended.writeUInt16BE(payload.length, 2)
                return extended
              })()
        socket.write(Buffer.concat([header, mask, masked]))
      },
      nextMessage: () => {
        const queued = messages.shift()
        if (queued) return Promise.resolve(queued)
        return new Promise((resolveMessage, rejectMessage) => {
          const timer = setTimeout(() => rejectMessage(new Error('ws message timeout')), 5000)
          waiters.push({
            resolve: (value) => {
              clearTimeout(timer)
              resolveMessage(value)
            },
          })
        })
      },
      close: () => socket.destroy(),
    }
  }

  it('rejects upgrades without a token', async () => {
    await startServer()
    await expect(wsConnect()).rejects.toThrow('handshake failed')
  })

  it('authenticates via query parameter for browser clients', async () => {
    await startServer()
    const token = await fetchToken()
    const client = await wsConnect(`/v1/ws?access_token=${encodeURIComponent(token)}`)
    const hello = await client.nextMessage()
    expect(hello.type).toBe('hello')
    client.close()
  })

  it('runs the full session lifecycle over WS', async () => {
    await startServer()
    const token = await fetchToken()
    const client = await wsConnect('/v1/ws', { authorization: `Bearer ${token}` })
    const hello = await client.nextMessage()
    expect(hello.type).toBe('hello')
    expect(hello.session).toBeNull()

    client.send({ type: 'ping', ref: 'p1' })
    const pong = await client.nextMessage()
    expect(pong.type).toBe('pong')
    expect(pong.ref).toBe('p1')

    client.send({ type: 'session.start', ref: 's1' })
    const attachedReply = await client.nextMessage()
    const attachedEvent = await client.nextMessage()
    const frames = [attachedReply, attachedEvent]
    const reply = frames.find((frame) => frame.ref === 's1')
    const broadcast = frames.find((frame) => frame.type === 'event')
    expect(reply?.type).toBe('session.attached')
    expect(broadcast).toBeDefined()
    expect(hub.active?.id).toBe('sess-1')

    client.send({ type: 'turn.submit', prompt: 'fix the tests', ref: 't1' })
    const accepted = await client.nextMessage()
    expect(accepted.type).toBe('turn.accepted')
    expect(accepted.ref).toBe('t1')
    // 两个 stream.delta + 一个 turn.completed 经 event 帧透传
    const events = [
      await client.nextMessage(),
      await client.nextMessage(),
      await client.nextMessage(),
    ]
    const types = events.map((frame) => (frame.event as { type?: string } | undefined)?.type)
    expect(types).toContain('stream.delta')
    expect(types).toContain('turn.completed')

    client.send({ type: 'permission.decide', requestId: 'perm-9', kind: 'allow-once', ref: 'd1' })
    const decided = await client.nextMessage()
    expect(decided.type).toBe('permission.decided')
    expect(hub.decisions).toContainEqual(['perm-9', 'allow-once'])

    client.send({ type: 'session.end', ref: 'e1' })
    const ended = await client.nextMessage()
    expect(ended.type).toBe('session.ended')
    expect(hub.active).toBeUndefined()
    client.close()
  })

  it('rejects malformed frames with gateway_ws_protocol_error', async () => {
    await startServer()
    const token = await fetchToken()
    const client = await wsConnect('/v1/ws', { authorization: `Bearer ${token}` })
    await client.nextMessage() // hello
    client.send({ nope: true })
    const error = await client.nextMessage()
    expect(error.type).toBe('error')
    expect(error.code).toBe('gateway_ws_protocol_error')
    client.close()
  })

  it('requires an active session before turn.submit', async () => {
    await startServer()
    const token = await fetchToken()
    const client = await wsConnect('/v1/ws', { authorization: `Bearer ${token}` })
    await client.nextMessage()
    client.send({ type: 'turn.submit', prompt: 'hi' })
    const error = await client.nextMessage()
    expect(error.type).toBe('error')
    expect(String(error.message)).toContain('no active session')
    client.close()
  })
})
