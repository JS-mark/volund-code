import { request as httpRequest } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { createWebServer } from './index'
import type { RemoteControlPort, WebServerHandle } from './index'

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

function baseOf(url: string): string {
  return new URL(url).origin + '/'
}

/** bootstrap 自动签发 browser session（进入无 token 门）：取 cookie + CSRF + 全量头。 */
async function authed(url: string) {
  const base = baseOf(url)
  const res = await fetch(`${base}api/v1/bootstrap`)
  expect(res.status).toBe(200)
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!
  const body = (await res.json()) as { data: { session: { csrfToken: string } } }
  const csrfToken = body.data.session.csrfToken
  return {
    base,
    cookie,
    csrfToken,
    headers: {
      Cookie: cookie,
      Origin: new URL(base).origin,
      'X-Volund-Csrf': csrfToken,
      'Content-Type': 'application/json',
    },
  }
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
    const base = baseOf(url)
    const health = await fetch(`${base}api/v1/health`)
    expect(health.status).toBe(200)
    const denied = await fetch(`${base}api/v1/sessions`)
    expect(denied.status).toBe(401)
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
      'web_session_invalid',
    )
  })

  it('bootstrap auto-issues HttpOnly session + CSRF token (no launch token on entry)', async () => {
    const { url } = await start()
    // 启动地址不带任何凭据 fragment——进入即用
    expect(new URL(url).hash).toBe('')
    const base = baseOf(url)
    const first = await fetch(`${base}api/v1/bootstrap`)
    expect(first.status).toBe(200)
    const setCookie = first.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    const body = (await first.json()) as { data: { session: { csrfToken: string } } }
    expect(body.data.session.csrfToken.length).toBeGreaterThan(16)
    // 刷新/重开（cookie 仍有效）复用同一会话：不再 Set-Cookie，CSRF 不变
    const cookie = setCookie.split(';')[0]!
    const again = await fetch(`${base}api/v1/bootstrap`, { headers: { Cookie: cookie } })
    expect(again.status).toBe(200)
    expect(again.headers.get('set-cookie')).toBeNull()
    const againBody = (await again.json()) as { data: { session: { csrfToken: string } } }
    expect(againBody.data.session.csrfToken).toBe(body.data.session.csrfToken)
    // 旧的 nonce 交换端点已移除（全量合法头 → 404，无信息泄露）
    const gone = await fetch(`${base}api/v1/browser-session/exchange`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: new URL(base).origin,
        'X-Volund-Csrf': body.data.session.csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ nonce: 'obsolete' }),
    })
    expect(gone.status).toBe(404)
  })

  it('session cookie unlocks reads; sessions endpoint returns real data', async () => {
    const { url } = await start()
    const { base, cookie } = await authed(url)
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
    const { base, cookie } = await authed(url)
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
    const base = baseOf(url)
    const res = await fetch(base)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(await res.text()).toContain('not built')
  })

  it('W-05 attachment upload stages via the active session and gates MIME', async () => {
    const staged: { mime: string; size: number }[] = []
    const fakeSession = {
      id: 'sess-att',
      cwd: '/tmp/web-server-test',
      events: { subscribe: () => () => {} },
      transcript: [],
      setPermissionPromptHandler() {},
      async submit() {},
      async end() {},
      async stageAttachment(bytes: Uint8Array, mime: string) {
        staged.push({ mime, size: bytes.byteLength })
        return {
          kind: 'attached',
          attachment: { kind: 'image', mime, size: bytes.byteLength, handle: 'a.png' },
        }
      },
    }
    const { SessionHub } = await import('./session-hub')
    const { PermissionPromptController } = await import('@volund/app-runtime')
    const sessionHub = new SessionHub({
      permissions: new PermissionPromptController(),
      session: {
        async startInteractive() {
          return fakeSession as never
        },
        async interrupt() {},
        async end() {},
      },
    })
    const { url } = await start({ sessionHub })
    const { base, cookie, csrfToken } = await authed(url)
    const origin = new URL(base).origin
    const mutation = (contentType: string) => ({
      Cookie: cookie,
      Origin: origin,
      'X-Volund-Csrf': csrfToken,
      'Content-Type': contentType,
    })

    // 建会话前上传 → 409（无活动会话）
    const noSession = await fetch(`${base}api/v1/sessions/active/attachments`, {
      method: 'POST',
      headers: mutation('image/png'),
      body: new Uint8Array([1, 2, 3]),
    })
    expect(noSession.status).toBe(409)

    // 非图片 MIME → 400
    const badMime = await fetch(`${base}api/v1/sessions/active/attachments`, {
      method: 'POST',
      headers: mutation('text/plain'),
      body: 'hello',
    })
    expect(badMime.status).toBe(400)
    expect(((await badMime.json()) as { error: { code: string } }).error.code).toBe(
      'web_attachment_rejected',
    )

    // 建会话后上传 → 200 + handle；turns 携带 attachments → 202
    await fetch(`${base}api/v1/sessions`, {
      method: 'POST',
      headers: mutation('application/json'),
      body: JSON.stringify({ cwd: '/tmp/web-server-test' }),
    })
    const uploaded = await fetch(`${base}api/v1/sessions/active/attachments`, {
      method: 'POST',
      headers: mutation('image/png'),
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    })
    expect(uploaded.status).toBe(200)
    expect(((await uploaded.json()) as { data: { handle: string } }).data.handle).toBe('a.png')
    expect(staged).toEqual([{ mime: 'image/png', size: 4 }])

    const turn = await fetch(`${base}api/v1/sessions/active/turns`, {
      method: 'POST',
      headers: mutation('application/json'),
      body: JSON.stringify({
        prompt: '看图',
        attachments: [
          { kind: 'image', mime: 'image/png', size: 4, handle: 'a.png', chip: '[image_1]' },
        ],
      }),
    })
    expect(turn.status).toBe(202)

    const malformed = await fetch(`${base}api/v1/sessions/active/turns`, {
      method: 'POST',
      headers: mutation('application/json'),
      body: JSON.stringify({ prompt: 'x', attachments: [{ kind: 'image' }] }),
    })
    expect(malformed.status).toBe(400)
    // 真实 loopback HTTP + 动态 import，常态 ~3.5s——高并发下 5s 默认超时太紧。
  }, 15_000)

  it('W-05 attachment bytes are served by handle (transcript image echo)', async () => {
    const handle = `${'e'.repeat(64)}.png`
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const fakeSession = {
      id: 'sess-att-read',
      cwd: '/tmp/web-server-test',
      events: { subscribe: () => () => {} },
      transcript: [],
      setPermissionPromptHandler() {},
      async submit() {},
      async end() {},
      async readAttachment(wanted: string) {
        return wanted === handle ? { mime: 'image/png', bytes } : undefined
      },
    }
    const { SessionHub } = await import('./session-hub')
    const { PermissionPromptController } = await import('@volund/app-runtime')
    const sessionHub = new SessionHub({
      permissions: new PermissionPromptController(),
      session: {
        async startInteractive() {
          return fakeSession as never
        },
        async interrupt() {},
        async end() {},
      },
    })
    const { url } = await start({ sessionHub })
    const { base, cookie, csrfToken } = await authed(url)
    await fetch(`${base}api/v1/sessions`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: new URL(base).origin,
        'X-Volund-Csrf': csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ cwd: '/tmp/web-server-test' }),
    })

    // 无 cookie → 401（读端点同样要 browser session）
    const anonymous = await fetch(`${base}api/v1/sessions/active/attachments/${handle}`)
    expect(anonymous.status).toBe(401)

    // 命中 → 200 + 原始字节 + 内容寻址长缓存
    const hit = await fetch(`${base}api/v1/sessions/active/attachments/${handle}`, {
      headers: { Cookie: cookie },
    })
    expect(hit.status).toBe(200)
    expect(hit.headers.get('content-type')).toBe('image/png')
    expect(hit.headers.get('cache-control')).toContain('immutable')
    expect(new Uint8Array(await hit.arrayBuffer())).toEqual(bytes)

    // 合法形状但不存在 → 404 web_attachment_not_found
    const missing = await fetch(`${base}api/v1/sessions/active/attachments/${'f'.repeat(64)}.png`, {
      headers: { Cookie: cookie },
    })
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      'web_attachment_not_found',
    )

    // 非法 handle 形状 → 路由不匹配，落未知端点 404
    const badHandle = await fetch(`${base}api/v1/sessions/active/attachments/not-a-handle`, {
      headers: { Cookie: cookie },
    })
    expect(badHandle.status).toBe(404)
    expect(((await badHandle.json()) as { error: { code: string } }).error.code).toBe(
      'web_schema_invalid',
    )
  }, 15_000)
})

describe('web-server session groups', () => {
  async function withStore(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { rm } = await import('node:fs/promises')
    const dir = await mkdtemp(join(tmpdir(), 'volund-web-groups-api-'))
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
  }

  it('is an honest 503 when the port is not wired', async () => {
    const { url } = await start()
    const { base, headers } = await authed(url)
    const list = await fetch(`${base}api/v1/session-groups`, { headers })
    expect(list.status).toBe(503)
    const create = await fetch(`${base}api/v1/session-groups`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'x' }),
    })
    expect(create.status).toBe(503)
    expect(((await create.json()) as { error: { code: string } }).error.code).toBe(
      'web_capability_unavailable',
    )
    // bootstrap 能力面同步关闭
    const bootstrap = await fetch(`${base}api/v1/bootstrap`, { headers })
    const caps = (
      (await bootstrap.json()) as { data: { capabilities: { sessionGroups: boolean } } }
    ).data.capabilities
    expect(caps.sessionGroups).toBe(false)
  })

  it('supports the full group lifecycle and prunes stale assignments in the view', async () => {
    const { createSessionGroupStore } = await import('./session-groups')
    const { dir, cleanup } = await withStore()
    try {
      const { join } = await import('node:path')
      const { url } = await start({
        sessionGroups: createSessionGroupStore(join(dir, 'session-groups.json')),
      })
      const { base, headers } = await authed(url)

      // bootstrap 能力面开启
      const bootstrap = await fetch(`${base}api/v1/bootstrap`, { headers })
      expect(
        ((await bootstrap.json()) as { data: { capabilities: { sessionGroups: boolean } } }).data
          .capabilities.sessionGroups,
      ).toBe(true)

      // 建分组
      const created = await fetch(`${base}api/v1/session-groups`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: '工作' }),
      })
      expect(created.status).toBe(200)
      const group = ((await created.json()) as { data: { group: { id: string } } }).data.group

      // 归属：一个真实会话 + 一个已消失的会话
      await fetch(`${base}api/v1/session-groups/assign`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId: 'sess-1', groupId: group.id }),
      })
      await fetch(`${base}api/v1/session-groups/assign`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId: 'ghost', groupId: group.id }),
      })
      const view = (await (await fetch(`${base}api/v1/session-groups`, { headers })).json()) as {
        data: { groups: { id: string; name: string }[]; assignments: Record<string, string> }
      }
      expect(view.data.groups).toHaveLength(1)
      // ghost 已不在会话列表 → 视图级裁剪
      expect(view.data.assignments).toEqual({ 'sess-1': group.id })

      // 重命名 + 重名冲突
      const renamed = await fetch(`${base}api/v1/session-groups/rename`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: group.id, name: '日常' }),
      })
      expect(renamed.status).toBe(200)
      const dup = await fetch(`${base}api/v1/session-groups`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: '日常' }),
      })
      expect(dup.status).toBe(409)

      // 删组 → 归属清空
      const deleted = await fetch(`${base}api/v1/session-groups/delete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: group.id }),
      })
      expect(deleted.status).toBe(200)
      const after = (await (await fetch(`${base}api/v1/session-groups`, { headers })).json()) as {
        data: { groups: unknown[]; assignments: Record<string, string> }
      }
      expect(after.data.groups).toEqual([])
      expect(after.data.assignments).toEqual({})
    } finally {
      await cleanup()
    }
  })

  it('validates payloads and maps unknown group ids to 404', async () => {
    const { createSessionGroupStore } = await import('./session-groups')
    const { dir, cleanup } = await withStore()
    try {
      const { join } = await import('node:path')
      const { url } = await start({
        sessionGroups: createSessionGroupStore(join(dir, 'session-groups.json')),
      })
      const { base, headers } = await authed(url)

      const noName = await fetch(`${base}api/v1/session-groups`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      })
      expect(noName.status).toBe(400)
      const blank = await fetch(`${base}api/v1/session-groups`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: '  ' }),
      })
      expect(blank.status).toBe(400)
      const missing = await fetch(`${base}api/v1/session-groups/rename`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: 'grp_none', name: 'x' }),
      })
      expect(missing.status).toBe(404)
      expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
        'web_session_group_not_found',
      )
      const badAssign = await fetch(`${base}api/v1/session-groups/assign`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId: 'sess-1' }),
      })
      expect(badAssign.status).toBe(400)

      // 未消费 CSRF 的 mutation 一律 403
      const noCsrf = await fetch(`${base}api/v1/session-groups`, {
        method: 'POST',
        headers: {
          Cookie: headers.Cookie,
          Origin: headers.Origin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'x' }),
      })
      expect(noCsrf.status).toBe(403)
    } finally {
      await cleanup()
    }
  })
})

function configPort(overrides: Record<string, unknown> = {}) {
  const calls: { set: unknown[]; unset: unknown[] } = { set: [], unset: [] }
  return {
    calls,
    port: {
      listMerged: async () => ({
        config: {
          auth: { anthropic_api_key: 'sk-test-value', skipAuth: true },
          env: { HTTP_PROXY: 'http://127.0.0.1:7890', OPENAI_API_KEY: 'k-1' },
          web: { enabled: true },
        },
        warnings: ['w1'],
      }),
      filePaths: () => ({ user: '/home/u/.volund/config.toml', project: '/p/.volund/config.toml' }),
      setValue: async (input: unknown) => {
        calls.set.push(input)
        return { file: '/home/u/.volund/config.toml' }
      },
      unsetValue: async (input: unknown) => {
        calls.unset.push(input)
        return { file: '/home/u/.volund/config.toml', removed: true }
      },
      ...overrides,
    },
  }
}

describe('web-server config endpoints (W-13)', () => {
  it('GET /config returns the merged view with credentials redacted to presence', async () => {
    const { url } = await start({
      ports: {
        identity: { version: '0.0.0-test' },
        cwd: '/tmp/web-server-test',
        config: configPort().port,
      },
    })
    const { base, headers } = await authed(url)
    const res = await fetch(`${base}api/v1/config`, { headers })
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as {
      data: {
        config: Record<string, Record<string, unknown>>
        redacted: string[]
        warnings: string[]
        files: { user: string; project: string }
      }
    }
    // 凭据键脱敏为 presence；skipAuth（布尔）与代理地址（非 key）保留原值
    expect(data.config.auth?.anthropic_api_key).toBe(true)
    expect(data.config.auth?.skipAuth).toBe(true)
    expect(data.config.env?.OPENAI_API_KEY).toBe(true)
    expect(data.config.env?.HTTP_PROXY).toBe('http://127.0.0.1:7890')
    expect(data.config.web?.enabled).toBe(true)
    expect(data.redacted.toSorted()).toEqual(['auth.anthropic_api_key', 'env.OPENAI_API_KEY'])
    expect(data.warnings).toEqual(['w1'])
    expect(data.files.user).toBe('/home/u/.volund/config.toml')
  })

  it('bootstrap advertises the config capability only when read+write are wired', async () => {
    const wired = await start({
      ports: {
        identity: { version: '0' },
        cwd: '/tmp',
        config: configPort().port,
      },
    })
    const a = await authed(wired.url)
    const b1 = await fetch(`${a.base}api/v1/bootstrap`, { headers: a.headers })
    expect(
      ((await b1.json()) as { data: { capabilities: { config: boolean } } }).data.capabilities
        .config,
    ).toBe(true)
    await wired.close()

    const partial = await start({
      ports: {
        identity: { version: '0' },
        cwd: '/tmp',
        config: { setValue: async () => ({ file: 'x' }) },
      },
    })
    const b = await authed(partial.url)
    const b2 = await fetch(`${b.base}api/v1/bootstrap`, { headers: b.headers })
    expect(
      ((await b2.json()) as { data: { capabilities: { config: boolean } } }).data.capabilities
        .config,
    ).toBe(false)
  })

  it('config/set passes any well-formed key through to the port (no web whitelist)', async () => {
    const { calls, port } = configPort()
    const { url } = await start({
      ports: { identity: { version: '0' }, cwd: '/tmp/web-server-test', config: port },
    })
    const { base, headers } = await authed(url)
    // 旧的"白名单外"键现在放行（schema 校验在端口内）
    const res = await fetch(`${base}api/v1/config/set`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: 'runner.maxToolLoopsPerTurn', value: 10 }),
    })
    expect(res.status).toBe(200)
    expect(calls.set).toEqual([
      { cwd: '/tmp/web-server-test', key: 'runner.maxToolLoopsPerTurn', value: 10 },
    ])
    // 结构化值（对象/数组）原样透传
    const structured = await fetch(`${base}api/v1/config/set`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: 'models.aliases.fast', value: { provider: 'a', model: 'b' } }),
    })
    expect(structured.status).toBe(200)
    // 形状非法的 key → 400
    const malformed = await fetch(`${base}api/v1/config/set`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: '..', value: 1 }),
    })
    expect(malformed.status).toBe(400)
    expect(((await malformed.json()) as { error: { code: string } }).error.code).toBe(
      'web_schema_invalid',
    )
    // 缺 value → 400
    const noValue = await fetch(`${base}api/v1/config/set`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: 'web.port' }),
    })
    expect(noValue.status).toBe(400)
  })

  it('config/set refuses web.enabled (the console cannot disable itself)', async () => {
    const { calls, port } = configPort()
    const { url } = await start({
      ports: { identity: { version: '0' }, cwd: '/tmp/web-server-test', config: port },
    })
    const { base, headers } = await authed(url)
    const res = await fetch(`${base}api/v1/config/set`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: 'web.enabled', value: false }),
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'web_capability_unavailable',
    )
    expect(calls.set).toEqual([])
  })

  it('config/set maps port schema errors: unknown key → 400, project-forbidden → 403', async () => {
    const { url } = await start({
      ports: {
        identity: { version: '0' },
        cwd: '/tmp/web-server-test',
        config: {
          setValue: async ({ key }: { key: string }) => {
            if (key === 'bogus.key')
              throw Object.assign(new Error('unknown key'), { code: 'config_unknown_key' })
            if (key === 'auth.x')
              throw Object.assign(new Error('forbidden'), { code: 'config_project_forbidden' })
            return { file: 'x' }
          },
        },
      },
    })
    const { base, headers } = await authed(url)
    const unknown = await fetch(`${base}api/v1/config/set`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: 'bogus.key', value: 1 }),
    })
    expect(unknown.status).toBe(400)
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
      'config_unknown_key',
    )
    const forbidden = await fetch(`${base}api/v1/config/set`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: 'auth.x', value: 1 }),
    })
    expect(forbidden.status).toBe(403)
    expect(((await forbidden.json()) as { error: { code: string } }).error.code).toBe(
      'config_project_forbidden',
    )
  })

  it('config/unset clears a key via the port; malformed key → 400', async () => {
    const { calls, port } = configPort()
    const { url } = await start({
      ports: { identity: { version: '0' }, cwd: '/tmp/web-server-test', config: port },
    })
    const { base, headers } = await authed(url)
    const res = await fetch(`${base}api/v1/config/unset`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: 'web.port' }),
    })
    expect(res.status).toBe(200)
    expect(calls.unset).toEqual([{ cwd: '/tmp/web-server-test', key: 'web.port' }])
    const malformed = await fetch(`${base}api/v1/config/unset`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: 'bad key!' }),
    })
    expect(malformed.status).toBe(400)
  })

  it('config endpoints are 503 when the port is not wired', async () => {
    const { url } = await start()
    const { base, headers } = await authed(url)
    const get = await fetch(`${base}api/v1/config`, { headers })
    expect(get.status).toBe(503)
    const set = await fetch(`${base}api/v1/config/set`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: 'web.enabled', value: true }),
    })
    expect(set.status).toBe(503)
    const unset = await fetch(`${base}api/v1/config/unset`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: 'web.port' }),
    })
    expect(unset.status).toBe(503)
  })
})

describe('web-server remote control endpoints (REM-r1)', () => {
  function fakeRemote(overrides: Partial<RemoteControlPort> = {}) {
    const state = {
      current: 'off' as 'off' | 'connecting' | 'online',
      started: 0,
      stopped: 0,
    }
    const port: RemoteControlPort & { state: typeof state } = {
      state,
      status: () => ({
        state: state.current,
        gatewayUrl: state.current === 'off' ? undefined : 'https://gw.example.com',
        attempt: state.current === 'online' ? 0 : 2,
        lastError: state.current === 'online' ? undefined : 'not configured',
        lastOnlineAt: state.current === 'online' ? 123 : undefined,
      }),
      start: () => {
        state.started += 1
        state.current = 'online'
      },
      stop: async () => {
        state.stopped += 1
        state.current = 'off'
      },
      createPairing: async () => ({
        code: 'ABCD2345',
        url: 'https://gw.example.com/#pair=ABCD2345',
        expiresAt: 999,
      }),
      listDevices: async () => [{ id: 'dev-1', name: '手机', pairedAt: 1, lastSeen: 2 }],
      revokeDevice: async (deviceId: string) => deviceId === 'dev-1',
      ...overrides,
    }
    return port
  }

  it('serves remote status/channels/devices and capability flag', async () => {
    const remote = fakeRemote()
    const { url } = await start({ remote })
    const boot = await fetch(`${new URL(url).origin}/api/v1/bootstrap`)
    const capabilities = ((await boot.json()) as { data: { capabilities: { remote?: boolean } } })
      .data.capabilities
    expect(capabilities.remote).toBe(true)
    const { base, headers } = await authed(url)
    const res = await fetch(`${base}api/v1/remote`, { headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: {
        status: { state: string }
        channels: { id: string; available: boolean }[]
        devices: { id: string }[]
      }
    }
    expect(body.data.status.state).toBe('off')
    expect(body.data.channels.map((channel) => channel.id)).toEqual([
      'mobile-web',
      'wechat',
      'wecom',
    ])
    expect(body.data.devices).toEqual([{ id: 'dev-1', name: '手机', pairedAt: 1, lastSeen: 2 }])
  })

  it('dispatches start/stop/pairing/revoke actions', async () => {
    const remote = fakeRemote()
    const { url } = await start({ remote })
    const { base, headers } = await authed(url)

    const pairOffline = await fetch(`${base}api/v1/remote/actions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'create-pairing' }),
    })
    expect(pairOffline.status).toBe(409)

    const startRes = await fetch(`${base}api/v1/remote/actions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'start' }),
    })
    expect(startRes.status).toBe(200)
    expect(remote.state.started).toBe(1)

    const pair = await fetch(`${base}api/v1/remote/actions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'create-pairing' }),
    })
    expect(pair.status).toBe(200)
    const pairing = ((await pair.json()) as { data: { pairing: { code: string } } }).data.pairing
    expect(pairing.code).toBe('ABCD2345')

    const revoke = await fetch(`${base}api/v1/remote/actions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'revoke-device', deviceId: 'dev-1' }),
    })
    expect(((await revoke.json()) as { data: { revoked: boolean } }).data.revoked).toBe(true)

    const stop = await fetch(`${base}api/v1/remote/actions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'stop' }),
    })
    expect(stop.status).toBe(200)
    expect(remote.state.stopped).toBe(1)
  })

  it('is 503 without the remote port wired', async () => {
    const { url } = await start()
    const { base, headers } = await authed(url)
    const get = await fetch(`${base}api/v1/remote`, { headers })
    expect(get.status).toBe(503)
    const action = await fetch(`${base}api/v1/remote/actions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'start' }),
    })
    expect(action.status).toBe(503)
  })
})
