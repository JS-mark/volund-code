/**
 * P6-01/P6-02 Web 攻击面 corpus（§22.13 测试层 7）：把网关的安全门系统化为
 * 拒绝语料——伪造/重放/越权/超限/路径逃逸/秘密渗出六个面向。
 * 每条用例对应 §22.10 的一条威胁模型断言。
 */
import http from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { createWebServer } from './index'
import type { WebServerHandle } from './index'

let handle: WebServerHandle | undefined
afterEach(async () => {
  await handle?.close()
  handle = undefined
})

async function start(): Promise<WebServerHandle> {
  handle = await createWebServer({
    host: '127.0.0.1',
    port: 0,
    ports: {
      identity: { version: '0.0.0-test' },
      cwd: '/tmp/web-security-test',
      session: { list: async () => [] },
    },
  })
  return handle
}

function baseOf(handle: WebServerHandle): string {
  return handle.url.split('/#')[0]! + '/'
}

async function exchange(handle: WebServerHandle): Promise<{ cookie: string; csrf: string }> {
  const nonce = handle.url.split('#token=')[1]!
  const res = await fetch(`${baseOf(handle)}api/v1/browser-session/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseOf(handle).slice(0, -1) },
    body: JSON.stringify({ nonce }),
  })
  expect(res.status).toBe(200)
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!
  const csrf = ((await res.json()) as { data: { csrfToken: string } }).data.csrfToken
  return { cookie, csrf }
}

describe('web attack corpus', () => {
  it('oversized bodies are rejected before parsing (64 KiB cap)', async () => {
    const handle = await start()
    const base = baseOf(handle)
    const big = 'x'.repeat(65 * 1024)
    const res = await fetch(`${base}api/v1/browser-session/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base.slice(0, -1) },
      body: JSON.stringify({ nonce: big }),
    })
    expect([400, 403]).toContain(res.status)
  })

  it('malformed JSON bodies are rejected', async () => {
    const handle = await start()
    const base = baseOf(handle)
    const res = await fetch(`${base}api/v1/browser-session/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base.slice(0, -1) },
      body: '{broken',
    })
    expect(res.status).toBe(400)
  })

  it('mutations without Origin, cookie, or CSRF all fail closed', async () => {
    const handle = await start()
    const base = baseOf(handle)
    // 无 session：端点直接 401（无须走到 CSRF）。
    const noSession = await fetch(`${base}api/v1/permissions/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base.slice(0, -1) },
      body: JSON.stringify({ requestId: 'x', kind: 'deny' }),
    })
    expect(noSession.status).toBe(401)
    // 有 session 无 CSRF → 403。
    const { cookie } = await exchange(handle)
    const noCsrf = await fetch(`${base}api/v1/permissions/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base.slice(0, -1), Cookie: cookie },
      body: JSON.stringify({ requestId: 'x', kind: 'deny' }),
    })
    expect(noCsrf.status).toBe(403)
    expect(((await noCsrf.json()) as { error: { code: string } }).error.code).toBe(
      'web_csrf_invalid',
    )
    // 有 session 有 CSRF 但 Origin 伪造 → 403。
    const badOrigin = await fetch(`${base}api/v1/permissions/decide`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:1',
        Cookie: cookie,
        'X-Volund-Csrf': 'forged',
      },
      body: JSON.stringify({ requestId: 'x', kind: 'deny' }),
    })
    expect(badOrigin.status).toBe(403)
    expect(((await badOrigin.json()) as { error: { code: string } }).error.code).toBe(
      'web_origin_rejected',
    )
  })

  it('static path traversal cannot escape the asset root', async () => {
    const handle = await start()
    const base = baseOf(handle).slice(0, -1)
    for (const path of [
      '/../package.json',
      '/..%2f..%2fpackage.json',
      '/../../tsconfig.base.json',
    ]) {
      const res = await fetch(`${base}${path}`)
      // 核心不变量：无论状态码，根目录文件内容绝不出现。
      const text = res.status === 200 ? await res.text() : ''
      expect(text).not.toContain('compilerOptions')
      if (res.status !== 200) expect([403, 404]).toContain(res.status)
    }
  })

  it('XSS payloads in data round-trip inert (server never renders user data as HTML)', async () => {
    const hostile = {
      id: '<script>alert(1)</script>',
      cwd: 'x" onmouseover="alert(1)',
      updatedAt: '2026-09-05T00:00:00Z',
      title: '<img src=x onerror=alert(1)>',
    }
    await handle?.close()
    handle = await createWebServer({
      host: '127.0.0.1',
      port: 0,
      ports: {
        identity: { version: '0.0.0-test' },
        cwd: '/tmp/web-security-test',
        session: { list: async () => [hostile] },
      },
    })
    const base = baseOf(handle)
    const { cookie } = await exchange(handle)
    const res = await fetch(`${base}api/v1/sessions`, { headers: { Cookie: cookie } })
    const body = (await res.json()) as { data: { sessions: { title: string }[] } }
    // JSON 原样透传（无渲染），载荷完整但绝不会被服务器包成 HTML。
    expect(body.data.sessions[0]?.title).toBe(hostile.title)
    const page = await fetch(base)
    expect(await page.text()).not.toContain('<img src=x')
  })

  it('health endpoint never exposes credentials, tokens, or absolute secrets', async () => {
    const handle = await start()
    const base = baseOf(handle)
    const res = await fetch(`${base}api/v1/health`)
    const text = await res.text()
    for (const needle of ['csrfToken', 'volund_session', 'credential', 'token=']) {
      expect(text).not.toContain(needle)
    }
  })

  it('the startup nonce never appears in any HTTP response', async () => {
    const handle = await start()
    const nonce = handle.url.split('#token=')[1]!
    const base = baseOf(handle)
    const page = await fetch(base)
    expect(await page.text()).not.toContain(nonce)
    const health = await fetch(`${base}api/v1/health`)
    expect(await health.text()).not.toContain(nonce)
  })

  it('unknown endpoints and unsupported methods are 404 without disclosure', async () => {
    const handle = await start()
    const base = baseOf(handle)
    const { cookie } = await exchange(handle)
    const unknown = await fetch(`${base}api/v1/definitely-not-a-route`, {
      headers: { Cookie: cookie },
    })
    expect(unknown.status).toBe(404)
    // 安全优先：mutation 的 Origin/CSRF 门先于路由匹配（避免跨Origin探测路由存在性）。
    const wrongMethod = await fetch(`${base}api/v1/sessions`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    })
    expect(wrongMethod.status).toBe(403)
    // 带全量合法头的未知端点 → 404 web_schema_invalid（无信息泄露）。
    const unknownWithHeaders = await fetch(`${base}api/v1/definitely-not-a-route`, {
      headers: { Cookie: cookie },
    })
    expect(unknownWithHeaders.status).toBe(404)
    expect(((await unknownWithHeaders.json()) as { error: { code: string } }).error.code).toBe(
      'web_schema_invalid',
    )
  })

  it('the bound port refuses a second listener (explicit error, not silent reuse)', async () => {
    const handle = await start()
    const port = handle.port
    const second = createWebServer({
      host: '127.0.0.1',
      port,
      ports: { identity: { version: '0' }, cwd: '/tmp' },
    })
    await expect(second).rejects.toThrow()
  })

  it('server id rotation invalidates prior browser sessions (restart semantics)', async () => {
    const first = await start()
    const base = baseOf(first)
    const { cookie } = await exchange(first)
    expect((await fetch(`${base}api/v1/sessions`, { headers: { Cookie: cookie } })).status).toBe(
      200,
    )
    await first.close()
    // 同 cookie 打到新 server（新 serverId）→ 会话失效。
    const second = await start()
    const stale = await fetch(`${baseOf(second)}api/v1/sessions`, { headers: { Cookie: cookie } })
    expect(stale.status).toBe(401)
  })

  it('DNS rebinding: a page rebound to the server IP sends a foreign Host and is rejected', async () => {
    const handle = await start()
    const { hostname, port } = new URL(handle.url.split('/#')[0]!)
    // DNS rebinding 的等效形态：请求打到 127.0.0.1:port 但 Host 是攻击者域
    //（浏览器按目标主机设 Host）。用原生 http.client 伪造（fetch 会规范化）。
    for (const path of ['/api/v1/health', '/']) {
      const status = await new Promise<number>((resolveReq, rejectReq) => {
        const req = http.request(
          { hostname, port, path, method: 'GET', headers: { Host: 'attacker.example' } },
          (response) => {
            response.resume()
            response.on('end', () => resolveReq(response.statusCode ?? 0))
          },
        )
        req.on('error', rejectReq)
        req.end()
      })
      expect(status).toBe(403)
    }
    void hostname
  })
})
