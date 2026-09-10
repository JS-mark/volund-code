/**
 * Uplink 中转集成测试：真实 relay 网关 + 原生 WebSocket 客户端拨 /uplink。
 * 覆盖注册、hub RPC 路由（/v1/ws、/v1/sessions 经隧道）、配对核销、设备 token
 * 调用面、撤销与离线语义、事件广播按机器过滤。
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { GatewayEnvelope, GatewayHubLike } from './hub'
import { createGatewayServer } from './index'
import type { GatewayServerHandle } from './index'
import { deriveSigningKey, hashGatewayClientREFID_014Q } from './oauth'
import type { GatewayOAuthClient } from './oauth'
import { PairingStore } from './pairing'

const MACHINE_SECRET = 'm'.repeat(43)
const OTHER_SECRET = 'o'.repeat(43)
const NO_UPLINK_SECRET = 'n'.repeat(43)

/** 落盘形态（secretHash）；tokenFor 用对应明文换 JWT。 */
const MACHINE: GatewayOAuthClient = {
  id: 'machine-a',
  secretHash: hashGatewayClientREFID_014Q(MACHINE_SECRET),
  scopes: ['chat', 'sessions', 'uplink'],
}
const OTHER: GatewayOAuthClient = {
  id: 'other-b',
  secretHash: hashGatewayClientREFID_014Q(OTHER_SECRET),
  scopes: ['chat', 'sessions', 'uplink'],
}
const NO_UPLINK: GatewayOAuthClient = {
  id: 'noscope-c',
  secretHash: hashGatewayClientREFID_014Q(NO_UPLINK_SECRET),
  scopes: ['chat'],
}

/** 本机会话枢纽假实现：与 index.test.ts 的 FakeHub 同语义。 */
class LocalHub implements GatewayHubLike {
  activeSession: { id: string; cwd?: string } | undefined
  readonly listeners = new Set<(envelope: GatewayEnvelope) => void>()
  submitted: { prompt: string; model?: string }[] = []
  decisions: [string, string][] = []
  listedSessions = false
  private counter = 0

  get active() {
    return this.activeSession
  }

  async start(input: { cwd: string }): Promise<{ id: string }> {
    this.counter += 1
    this.activeSession = { id: `sess-${this.counter}`, cwd: input.cwd }
    return { id: this.activeSession.id }
  }

  async resume(id: string): Promise<{ id: string }> {
    this.activeSession = { id }
    return { id }
  }

  async submit(input: { prompt: string; model?: string }): Promise<'accepted'> {
    this.submitted.push(input)
    setTimeout(() => {
      this.emit('core', { type: 'stream.delta', payload: { kind: 'text', fragment: 'hi' } })
      this.emit('core', { type: 'turn.completed', payload: {} })
    }, 0)
    return 'accepted'
  }

  async interrupt(): Promise<void> {}

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

  listSessions(): Promise<readonly unknown[]> {
    this.listedSessions = true
    return Promise.resolve([{ id: 'sess-1', title: '本地会话' }])
  }

  emit(kind: string, event: unknown): void {
    for (const listener of this.listeners) listener({ kind, event })
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 测试用 uplink 客户端：拨 /uplink、注册、应答 hub RPC、转发事件。 */
class TestUplink {
  private readonly ws: WebSocket
  private readonly pendingRes = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >()
  private nextRef = 0
  registered = false
  closed = false
  private readonly registeredWaiters: (() => void)[] = []

  constructor(
    private readonly base: string,
    token: string,
    private readonly hub: LocalHub,
  ) {
    this.ws = new WebSocket(`${base.replace('http', 'ws')}/uplink?access_token=${token}`)
    this.ws.onmessage = (event) => this.handle(String(event.data))
    this.ws.onclose = () => {
      this.closed = true
    }
    this.hub.subscribe((envelope) => {
      if (this.registered) this.ws.send(JSON.stringify({ type: 'event', envelope }))
    })
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN
  }

  async waitOpen(): Promise<void> {
    while (!this.open && !this.closed) await sleep(10)
    if (this.closed) throw new Error('uplink connection rejected')
  }

  async waitRegistered(): Promise<void> {
    if (this.registered) return
    await new Promise<void>((resolve) => this.registeredWaiters.push(resolve))
  }

  register(): void {
    this.ws.send(
      JSON.stringify({
        type: 'uplink.register',
        instance: {
          instanceId: 'instance-a',
          workspaceCwd: '/local/workspace',
          hostname: 'mac-local',
          channels: ['mobile-web'],
          active: this.hub.active ?? null,
          pendingPermissions: this.hub.pendingPermissionIds(),
        },
      }),
    )
  }

  pushState(): void {
    this.ws.send(
      JSON.stringify({
        type: 'uplink.state',
        active: this.hub.active ?? null,
        pendingPermissions: this.hub.pendingPermissionIds(),
      }),
    )
  }

  /** 本机 → 网关请求（pairing.create / devices.list / device.revoke）。 */
  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const ref = `req-${++this.nextRef}`
    return new Promise((resolve, reject) => {
      this.pendingRes.set(ref, { resolve, reject })
      this.ws.send(JSON.stringify({ type: 'req', ref, method, params }))
    })
  }

  close(): void {
    this.ws.close()
  }

  private handle(text: string): void {
    const frame = JSON.parse(text) as {
      type?: string
      ref?: string
      method?: string
      id?: string
      params?: Record<string, unknown>
      ok?: boolean
      result?: unknown
      error?: { code?: string; message?: string }
    }
    if (frame.type === 'uplink.registered') {
      this.registered = true
      for (const waiter of this.registeredWaiters) waiter()
      this.registeredWaiters.length = 0
      return
    }
    if (frame.type === 'res' && frame.ref) {
      const pending = this.pendingRes.get(frame.ref)
      if (!pending) return
      this.pendingRes.delete(frame.ref)
      if (frame.ok) pending.resolve(frame.result)
      else pending.reject(new Error(frame.error?.message ?? 'uplink request failed'))
      return
    }
    if (frame.type === 'rpc' && frame.id && frame.method) {
      void this.answerRpc(frame.id, frame.method, frame.params ?? {})
    }
  }

  private async answerRpc(
    id: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      let result: unknown
      if (method === 'hub.start') result = await this.hub.start(params as { cwd: string })
      else if (method === 'hub.resume') result = await this.hub.resume(String(params.id))
      else if (method === 'hub.submit')
        result = await this.hub.submit(params as { prompt: string; model?: string })
      else if (method === 'hub.interrupt') result = await this.hub.interrupt()
      else if (method === 'hub.closeActive') result = await this.hub.closeActive()
      else if (method === 'hub.decide')
        result = this.hub.decide(String(params.requestId), String(params.kind))
      else if (method === 'sessions.list') result = await this.hub.listSessions()
      else throw new Error(`unknown method ${method}`)
      this.ws.send(JSON.stringify({ type: 'rpc.result', id, ok: true, result }))
    } catch (cause) {
      this.ws.send(
        JSON.stringify({
          type: 'rpc.result',
          id,
          ok: false,
          error: { message: cause instanceof Error ? cause.message : String(cause) },
        }),
      )
    }
  }
}

async function tokenFor(base: string, client: { id: string; secret: string }): Promise<string> {
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: client.id,
      client_secret: client.secret,
    }),
  })
  const body = (await res.json()) as { access_token?: string }
  if (!body.access_token)
    throw new Error(`token fetch failed: ${res.status} ${JSON.stringify(body)}`)
  return body.access_token
}

/** 简易 /v1/ws 客户端（收帧/发帧），用于验证 relay 路由与广播。 */
class WsClient {
  private readonly ws: WebSocket
  private readonly waiters: ((frame: Record<string, unknown>) => boolean)[] = []
  readonly frames: Record<string, unknown>[] = []
  closed = false
  closeCode = 0
  closeReason = ''

  constructor(base: string, token: string) {
    this.ws = new WebSocket(`${base.replace('http', 'ws')}/v1/ws?access_token=${token}`)
    this.ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>
      this.frames.push(frame)
      for (const [index, waiter] of Array.from(this.waiters.entries())) {
        if (waiter(frame)) this.waiters.splice(index, 1)
      }
    }
    this.ws.onclose = (event) => {
      this.closed = true
      this.closeCode = event.code
      this.closeReason = event.reason
    }
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame))
  }

  async waitOpen(): Promise<void> {
    while (!this.open && !this.closed) await sleep(10)
    if (this.closed) throw new Error('ws connection rejected')
  }

  async waitClosed(): Promise<void> {
    while (!this.closed) await sleep(10)
  }

  async expect(
    predicate: (frame: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    const found = this.frames.find(predicate)
    if (found) return found
    return new Promise((resolve) => {
      this.waiters.push((frame) => {
        if (predicate(frame)) {
          resolve(frame)
          return true
        }
        return false
      })
    })
  }

  close(): void {
    this.ws.close()
  }
}

/** 断言 WS 拨号被服务端拒绝（升级失败 → 浏览器侧 error/close）。 */
async function expectRejected(url: string): Promise<void> {
  const ws = new WebSocket(url)
  await new Promise<void>((resolve) => {
    ws.onerror = () => resolve()
    ws.onclose = () => resolve()
  })
  expect(ws.readyState).not.toBe(WebSocket.OPEN)
}

let server: GatewayServerHandle | undefined
let storeDir: string | undefined
let hub: LocalHub
let base = ''

beforeEach(async () => {
  hub = new LocalHub()
  storeDir = await mkdtemp(join(tmpdir(), 'volund-uplink-'))
})

afterEach(async () => {
  await server?.close()
  server = undefined
})

async function startRelay(
  clients: readonly GatewayOAuthClient[] = [MACHINE, OTHER],
  extra?: { publicUrl?: string; mobilePublicUrl?: string },
): Promise<void> {
  server = await createGatewayServer({
    host: '127.0.0.1',
    port: 0,
    version: '0.0.0-test',
    workspaceCwd: '/server/workspace',
    oauth: {
      issuer: 'volund-gateway-test',
      signingKey: deriveSigningKey('uplink-test-key'),
      tokenTtlSeconds: 3600,
      clients,
    },
    relay: {
      pairing: new PairingStore({
        signingKey: deriveSigningKey('uplink-test-key'),
        issuer: 'volund-gateway-test',
        storePath: join(storeDir!, 'devices.json'),
      }),
    },
    listSessions: () => Promise.resolve([]),
    ...(extra?.publicUrl ? { publicUrl: extra.publicUrl } : {}),
    ...(extra?.mobilePublicUrl ? { mobilePublicUrl: extra.mobilePublicUrl } : {}),
  })
  base = server.url
}

/** 拨 /uplink 并完成注册（含 active/pending 快照）。 */
async function dialUplink(hubInstance = hub): Promise<TestUplink> {
  const uplink = new TestUplink(
    base,
    await tokenFor(base, { id: MACHINE.id, secret: MACHINE_SECRET }),
    hubInstance,
  )
  await uplink.waitOpen()
  uplink.register()
  await uplink.waitRegistered()
  return uplink
}

describe('uplink relay', () => {
  it('registers an instance and reports it on /healthz', async () => {
    await startRelay()
    const uplink = await dialUplink()
    const res = await fetch(`${base}/healthz`)
    const body = (await res.json()) as { relay?: { instances?: number } }
    expect(body.relay?.instances).toBe(1)
    uplink.close()
  })

  it('rejects unauthenticated dials and dials without the uplink scope', async () => {
    await startRelay([MACHINE, OTHER, NO_UPLINK])
    await expectRejected(`${base.replace('http', 'ws')}/uplink`)
    await expectRejected(
      `${base.replace('http', 'ws')}/uplink?access_token=${await tokenFor(base, { id: NO_UPLINK.id, secret: NO_UPLINK_SECRET })}`,
    )
  })

  it('routes /v1/sessions over the tunnel to the machine hub', async () => {
    await startRelay()
    const uplink = await dialUplink()
    const res = await fetch(`${base}/v1/sessions`, {
      headers: {
        Authorization: `Bearer ${await tokenFor(base, { id: MACHINE.id, secret: MACHINE_SECRET })}`,
      },
    })
    const body = (await res.json()) as { sessions?: unknown[] }
    expect(body.sessions).toEqual([{ id: 'sess-1', title: '本地会话' }])
    expect(hub.listedSessions).toBe(true)
    uplink.close()
  })

  it('serves /v1/ws through the remote hub and relays events', async () => {
    await startRelay()
    const uplink = await dialUplink()
    // 本机已有活动会话（state 帧同步到网关缓存）。
    await hub.start({ cwd: '/local/workspace' })
    uplink.pushState()
    await sleep(50)

    const client = new WsClient(
      base,
      await tokenFor(base, { id: MACHINE.id, secret: MACHINE_SECRET }),
    )
    await client.waitOpen()
    const hello = await client.expect((frame) => frame.type === 'hello')
    expect((hello as { session?: { id?: string } }).session?.id).toBe('sess-1')

    client.send({ type: 'turn.submit', prompt: '你好' })
    await client.expect((frame) => frame.type === 'turn.accepted')
    await client.expect(
      (frame) =>
        frame.type === 'event' &&
        String(frame.kind) === 'core' &&
        (frame.event as { type?: string })?.type === 'stream.delta',
    )
    expect(hub.submitted).toEqual([{ prompt: '你好' }])
    client.close()
    uplink.close()
  })

  it('notifies device clients when the machine uplink drops and reconnects', async () => {
    await startRelay()
    let uplink = await dialUplink()
    const client = new WsClient(
      base,
      await tokenFor(base, { id: MACHINE.id, secret: MACHINE_SECRET }),
    )
    await client.waitOpen()
    await client.expect((frame) => frame.type === 'hello')

    uplink.close()
    await client.expect(
      (frame) =>
        frame.type === 'event' &&
        frame.kind === 'view' &&
        (frame.event as { type?: string })?.type === 'machine.offline',
    )

    uplink = await dialUplink()
    await client.expect(
      (frame) =>
        frame.type === 'event' &&
        frame.kind === 'view' &&
        (frame.event as { type?: string })?.type === 'machine.online',
    )
    client.close()
    uplink.close()
  })

  it('rejects /v1/ws when the machine is offline', async () => {
    await startRelay()
    await expectRejected(
      `${base.replace('http', 'ws')}/v1/ws?access_token=${await tokenFor(base, { id: MACHINE.id, secret: MACHINE_SECRET })}`,
    )
  })

  it('keeps machine event streams isolated per client', async () => {
    await startRelay()
    const uplinkA = await dialUplink()
    const hubB = new LocalHub()
    const uplinkB = new TestUplink(
      base,
      await tokenFor(base, { id: OTHER.id, secret: OTHER_SECRET }),
      hubB,
    )
    await uplinkB.waitOpen()
    uplinkB.register()
    await uplinkB.waitRegistered()

    const clientA = new WsClient(
      base,
      await tokenFor(base, { id: MACHINE.id, secret: MACHINE_SECRET }),
    )
    await clientA.waitOpen()
    await clientA.expect((frame) => frame.type === 'hello')

    hubB.emit('core', { type: 'turn.completed', payload: {} })
    hub.emit('core', {
      type: 'stream.delta',
      payload: { kind: 'text', fragment: 'a-only' },
    })
    await sleep(150)
    const events = clientA.frames.filter((frame) => frame.type === 'event')
    expect(
      events.some(
        (frame) => (frame.event as { type?: string } | undefined)?.type === 'turn.completed',
      ),
    ).toBe(false)
    expect(
      events.some(
        (frame) =>
          (frame.event as { payload?: { fragment?: string } } | undefined)?.payload?.fragment ===
          'a-only',
      ),
    ).toBe(true)
    clientA.close()
    uplinkA.close()
    uplinkB.close()
  })
})

describe('pairing over uplink', () => {
  it('creates a code via uplink, redeems it, and accepts the device token', async () => {
    await startRelay()
    const uplink = await dialUplink()

    const created = (await uplink.request('pairing.create')) as {
      code: string
      url: string
      expiresAt: number
    }
    expect(created.code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/)
    expect(created.url).toContain(`#pair=${created.code}`)

    const res = await fetch(`${base}/pairing/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: created.code, name: '我的手机' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { access_token?: string; device_id?: string }
    expect(body.access_token).toBeTruthy()
    expect(body.device_id).toMatch(/^dev-/)

    // 设备 token 直连 /v1/ws：走机器 A 的隧道。
    await hub.start({ cwd: '/local/workspace' })
    uplink.pushState()
    await sleep(50)
    const client = new WsClient(base, body.access_token!)
    await client.waitOpen()
    const hello = await client.expect((frame) => frame.type === 'hello')
    expect((hello as { session?: { id?: string } }).session?.id).toBe('sess-1')
    client.close()

    // 设备清单（经 uplink）含新设备；撤销后 token 立即失效。
    const listed = (await uplink.request('devices.list')) as {
      devices: { id: string; name: string }[]
    }
    expect(listed.devices).toHaveLength(1)
    expect(listed.devices[0]?.name).toBe('我的手机')
    const revoked = await uplink.request('device.revoke', { deviceId: body.device_id })
    expect(revoked).toEqual({ revoked: true })
    await expectRejected(`${base.replace('http', 'ws')}/v1/ws?access_token=${body.access_token}`)
    uplink.close()
  })

  it('closes the device live WS connections on revoke (revocation kicks existing sessions)', async () => {
    await startRelay()
    const uplink = await dialUplink()
    const created = (await uplink.request('pairing.create')) as { code: string }
    const res = await fetch(`${base}/pairing/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: created.code }),
    })
    const body = (await res.json()) as { access_token: string; device_id: string }

    await hub.start({ cwd: '/local/workspace' })
    uplink.pushState()
    await sleep(50)
    // 撤销前建立一条存活连接。
    const client = new WsClient(base, body.access_token)
    await client.waitOpen()
    await client.expect((frame) => frame.type === 'hello')

    // 撤销 → 存量连接被网关以 1008 主动关闭（移动端据此回配对页）。
    const revoked = await uplink.request('device.revoke', { deviceId: body.device_id })
    expect(revoked).toEqual({ revoked: true })
    await client.waitClosed()
    expect(client.closeCode).toBe(1008)
    expect(client.closeReason).toBe('device_revoked')
    uplink.close()
  })

  it('points the pairing URL at a separately deployed mobile site with &gw=', async () => {
    await startRelay([MACHINE, OTHER], {
      publicUrl: 'https://gw.example.com',
      mobilePublicUrl: 'https://m.example.com',
    })
    const uplink = await dialUplink()
    const created = (await uplink.request('pairing.create')) as { code: string; url: string }
    expect(created.url).toBe(
      `https://m.example.com/#pair=${created.code}&gw=${encodeURIComponent('https://gw.example.com')}`,
    )
    uplink.close()
  })

  it('keeps the pairing URL on the gateway origin when mobilePublicUrl matches', async () => {
    await startRelay([MACHINE, OTHER], {
      publicUrl: 'https://gw.example.com',
      mobilePublicUrl: 'https://gw.example.com',
    })
    const uplink = await dialUplink()
    const created = (await uplink.request('pairing.create')) as { code: string; url: string }
    expect(created.url).toBe(`https://gw.example.com/#pair=${created.code}`)
    uplink.close()
  })

  it('rejects double redeem and unknown codes with 400', async () => {
    await startRelay()
    const uplink = await dialUplink()
    const created = (await uplink.request('pairing.create')) as { code: string }
    const first = await fetch(`${base}/pairing/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: created.code }),
    })
    expect(first.status).toBe(200)
    const second = await fetch(`${base}/pairing/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: created.code }),
    })
    expect(second.status).toBe(400)
    const unknown = await fetch(`${base}/pairing/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'XXXXXXXX' }),
    })
    expect(unknown.status).toBe(400)
    uplink.close()
  })

  it('persists paired devices across gateway restarts', async () => {
    await startRelay()
    const uplink = await dialUplink()
    const created = (await uplink.request('pairing.create')) as { code: string }
    const redeemed = (await (
      await fetch(`${base}/pairing/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: created.code, name: '平板' }),
      })
    ).json()) as { access_token: string }

    uplink.close()
    await server!.close()
    server = undefined
    await startRelay()

    // 重启后 token 仍可过认证面（设备注册表落盘）。
    const res = await fetch(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${redeemed.access_token}` },
    })
    expect(res.status).toBe(200)
    const raw = await readFile(join(storeDir!, 'devices.json'), 'utf8')
    expect(raw).toContain('平板')
    uplink.close()
  })
})

describe('relay static site hosting', () => {
  it('serves the mobile site with CSP nonce, SPA fallback and asset caching', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    const root = join(storeDir!, 'site')
    await mkdir(join(root, '_next', 'static'), { recursive: true })
    await writeFile(
      join(root, 'index.html'),
      '<html><body><script>console.log(1)</script></body></html>',
    )
    await writeFile(join(root, '_next', 'static', 'app.js'), 'console.log("app")')
    server = await createGatewayServer({
      host: '127.0.0.1',
      port: 0,
      version: '0.0.0-test',
      workspaceCwd: '/unused',
      oauth: {
        issuer: 'volund-gateway-test',
        signingKey: deriveSigningKey('static-test'),
        tokenTtlSeconds: 3600,
        clients: [MACHINE],
      },
      relay: {},
      staticDir: root,
    })
    base = server.url

    const index = await fetch(`${base}/`)
    expect(index.status).toBe(200)
    expect(index.headers.get('content-type')).toContain('text/html')
    // per-request CSP nonce 注入（Next 内联引导脚本）。
    const html = await index.text()
    expect(html).toMatch(/<script nonce="[^"]+">/)

    // SPA 路由回退。
    const deep = await fetch(`${base}/some/route`)
    expect(deep.status).toBe(200)
    expect(deep.headers.get('content-type')).toContain('text/html')

    // 哈希资产长缓存。
    const asset = await fetch(`${base}/_next/static/app.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(asset.headers.get('cache-control')).toContain('immutable')

    // 带扩展名的缺失资源 404（不回退 HTML）。
    const missing = await fetch(`${base}/_next/static/missing.js`)
    expect(missing.status).toBe(404)

    // API 面不受静态托管影响。
    const health = await fetch(`${base}/v1/health`)
    expect(((await health.json()) as { status?: string }).status).toBe('ok')
  })
})
