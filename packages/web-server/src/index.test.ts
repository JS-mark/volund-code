import { request as httpRequest } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { createWebServer } from './index'
import type { WebServerHandle } from './index'

let handle: WebServerHandle | undefined
afterEach(async () => {
  await handle?.close()
  handle = undefined
})

async function start(
  overrides: Partial<Parameters<typeof createWebServer>[0]> = {},
): Promise<WebServerHandle> {
  handle = await createWebServer({
    host: '127.0.0.1',
    port: 0,
    ports: {
      identity: { version: '0.0.0-test' },
      cwd: '/tmp/web-server-test',
      session: {
        list: async () => [
          {
            id: 'sess-1',
            cwd: '/tmp/web-server-test',
            updatedAt: '2026-09-05T00:00:00Z',
            title: 'demo',
          },
        ],
      },
    },
    ...overrides,
  })
  return handle
}

function nonceOf(url: string): string {
  return new URL(url).hash.replace('#token=', '')
}

async function exchange(url: string, nonce: string, origin?: string) {
  const { hostname, port } = new URL(url)
  return fetch(`http://${hostname}:${port}/api/v1/browser-session/exchange`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin ?? `http://${hostname}:${port}`,
    },
    body: JSON.stringify({ nonce }),
  })
}

describe('web-server gateway', () => {
  it('rejects non-loopback hosts and invalid ports', async () => {
    await expect(
      createWebServer({
        host: '0.0.0.0',
        port: 0,
        ports: { identity: { version: '0' }, cwd: '/tmp' },
      }),
    ).rejects.toThrow('loopback')
    await expect(
      createWebServer({
        host: '127.0.0.1',
        port: 80,
        ports: { identity: { version: '0' }, cwd: '/tmp' },
      }),
    ).rejects.toThrow('1024..65535')
  })

  it('health is public; api reads require a browser session', async () => {
    const { url } = await start()
    const base = url.split('/#')[0]! + '/'
    const health = await fetch(`${base}api/v1/health`)
    expect(health.status).toBe(200)
    const denied = await fetch(`${base}api/v1/sessions`)
    expect(denied.status).toBe(401)
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
      'web_session_invalid',
    )
  })

  it('nonce exchange is single-use and issues HttpOnly session + CSRF token', async () => {
    const { url } = await start()
    const nonce = nonceOf(url)
    const first = await exchange(url, nonce)
    expect(first.status).toBe(200)
    const cookie = first.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    const body = (await first.json()) as { data: { csrfToken: string } }
    expect(body.data.csrfToken.length).toBeGreaterThan(16)
    // 重放同一 nonce 拒绝
    const replay = await exchange(url, nonce)
    expect(replay.status).toBe(403)
    // 错误 Origin 拒绝
    const foreign = await start()
    const foreignNonce = nonceOf(foreign.url)
    const { hostname, port } = new URL(foreign.url)
    const badOrigin = await exchange(foreign.url, foreignNonce, `http://evil.example`)
    expect(badOrigin.status).toBe(403)
    expect(((await badOrigin.json()) as { error: { code: string } }).error.code).toBe(
      'web_origin_rejected',
    )
    void hostname
    void port
  })

  it('session cookie unlocks reads; sessions endpoint returns real data', async () => {
    const { url } = await start()
    const base = url.split('/#')[0]! + '/'
    const exchanged = await exchange(url, nonceOf(url))
    const cookie = (exchanged.headers.get('set-cookie') ?? '').split(';')[0]!
    const sessions = await fetch(`${base}api/v1/sessions`, { headers: { Cookie: cookie } })
    expect(sessions.status).toBe(200)
    const body = (await sessions.json()) as { data: { sessions: { id: string }[] } }
    expect(body.data.sessions[0]?.id).toBe('sess-1')
  })

  it('rejects a foreign Host header on every route', async () => {
    const { url } = await start()
    const { hostname, port } = new URL(url)
    // undici fetch 会从 URL 规范化 Host——伪造 Host 必须走原生 http.request。
    const res = await new Promise<{ status: number; body: string }>((resolveReq, rejectReq) => {
      const req = httpRequest(
        {
          hostname,
          port,
          path: '/api/v1/health',
          method: 'GET',
          headers: { Host: 'evil.example' },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () =>
            resolveReq({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          )
        },
      )
      req.on('error', rejectReq)
      req.end()
    })
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body).error.code).toBe('web_origin_rejected')
  })

  it('SSE hello carries serverId and heartbeat keeps the stream', async () => {
    const { url } = await start()
    const base = url.split('/#')[0]! + '/'
    const exchanged = await exchange(url, nonceOf(url))
    const cookie = (exchanged.headers.get('set-cookie') ?? '').split(';')[0]!
    const controller = new AbortController()
    const res = await fetch(`${base}api/v1/events`, {
      headers: { Cookie: cookie },
      signal: controller.signal,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    expect(text).toContain('"kind":"hello"')
    controller.abort()
  })

  it('serves the placeholder page when no assets are built', async () => {
    const { url } = await start()
    const base = url.split('/#')[0]! + '/'
    const res = await fetch(base)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(await res.text()).toContain('not built')
  })
})
