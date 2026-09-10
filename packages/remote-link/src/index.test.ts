/**
 * remote-link 集成：真实 relay 网关 + FakeHub + RemoteLink 拨号。
 * 覆盖：注册上线、状态/事件推送、网关 RPC 落到本地 hub、移动端 WS 经网关
 * 走通 turn、配对邀请、断线重连（网关重启）、cwd 越界拒绝。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createGatewayServer,
  deriveSigningKey,
  hashGatewayClientREFID_014Q,
} from '@volund/gateway-server'
import type {
  GatewayEnvelope,
  GatewayHubLike,
  GatewaySubmitAttachment,
} from '@volund/gateway-server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RemoteLink } from './index'

const CLIENT_ID = 'machine-a'
const CLIENT_SECRET = 'm'.repeat(43)

class FakeHub implements GatewayHubLike {
  activeSession: { id: string; cwd?: string } | undefined
  readonly listeners = new Set<(envelope: GatewayEnvelope) => void>()
  submitted: {
    prompt: string
    model?: string
    attachments?: readonly GatewaySubmitAttachment[]
  }[] = []
  staged: { mime: string; dataBase64: string }[] = []
  startedCwds: string[] = []
  private counter = 0

  get active() {
    return this.activeSession
  }

  async start(input: { cwd: string }): Promise<{ id: string }> {
    this.startedCwds.push(input.cwd)
    this.counter += 1
    this.activeSession = { id: `sess-${this.counter}`, cwd: input.cwd }
    this.emit('view', { type: 'session.attached', id: this.activeSession.id })
    return { id: this.activeSession.id }
  }

  async resume(id: string): Promise<{ id: string }> {
    this.activeSession = { id }
    return { id }
  }

  async submit(input: {
    prompt: string
    model?: string
    attachments?: readonly GatewaySubmitAttachment[]
  }): Promise<'accepted'> {
    this.submitted.push(input)
    setTimeout(() => {
      this.emit('core', { type: 'stream.delta', payload: { kind: 'text', fragment: '回复' } })
      this.emit('core', { type: 'turn.completed', payload: {} })
    }, 0)
    return 'accepted'
  }

  async stageAttachment(input: { mime: string; dataBase64: string }) {
    this.staged.push(input)
    return {
      kind: 'image' as const,
      mime: input.mime,
      size: Buffer.from(input.dataBase64, 'base64').length,
      handle: `h-${this.staged.length}`,
    }
  }

  async readAttachment(handle: string) {
    if (handle !== `${'d'.repeat(64)}.png`) return undefined
    return { mime: 'image/png', dataBase64: Buffer.from([5, 6, 7]).toString('base64') }
  }

  async listModels() {
    return {
      current: 'anthropic/mimo-v2.5-pro',
      options: [{ id: 'anthropic/mimo-v2.5-pro', label: 'mimo（默认）' }],
    }
  }

  async interrupt(): Promise<void> {}

  async closeActive(): Promise<void> {
    this.activeSession = undefined
  }

  subscribe(listener: (envelope: GatewayEnvelope) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  decide(): boolean {
    return true
  }

  pendingPermissionIds(): string[] {
    return []
  }

  emit(kind: string, event: unknown): void {
    for (const listener of this.listeners) listener({ kind, event })
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let base = ''
let hub: FakeHub
let link: RemoteLink | undefined
let gateway: Awaited<ReturnType<typeof createGatewayServer>> | undefined
let storeDir: string

async function startGateway(): Promise<void> {
  gateway = await createGatewayServer({
    host: '127.0.0.1',
    port: 0,
    version: '0.0.0-test',
    workspaceCwd: '/unused',
    oauth: {
      issuer: 'volund-gateway-test',
      signingKey: deriveSigningKey('remote-link-test'),
      tokenTtlSeconds: 3600,
      clients: [
        {
          id: CLIENT_ID,
          secretHash: hashGatewayClientREFID_014Q(CLIENT_SECRET),
          scopes: ['chat', 'sessions', 'uplink'],
        },
      ],
    },
    relay: {},
  })
  base = gateway.url
}

beforeEach(async () => {
  hub = new FakeHub()
  storeDir = await mkdtemp(join(tmpdir(), 'volund-remote-link-'))
})

afterEach(async () => {
  await link?.stop()
  link = undefined
  await gateway?.close()
  gateway = undefined
})

function createLink(): RemoteLink {
  return new RemoteLink({
    config: () => ({
      gatewayUrl: base,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    }),
    hub,
    workspaceCwd: storeDir,
    listSessions: () => Promise.resolve([{ id: 'sess-9', title: '本机会话' }]),
    version: '1.0.0-test',
    hostname: 'test-host',
    initialBackoffMs: 50,
    maxBackoffMs: 200,
    logger: () => {},
  })
}

async function waitOnline(target: RemoteLink, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (target.status.state !== 'online' && Date.now() < deadline) await sleep(20)
  expect(target.status.state).toBe('online')
}

describe('RemoteLink', () => {
  it('registers online and exposes the local hub through the gateway', async () => {
    await startGateway()
    link = createLink()
    link.start()
    await waitOnline(link)

    // /v1/sessions 经网关取到本机清单。
    const tokenRes = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    })
    const token = ((await tokenRes.json()) as { access_token: string }).access_token
    const sessionsRes = await fetch(`${base}/v1/sessions`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(await sessionsRes.json()).toEqual({ sessions: [{ id: 'sess-9', title: '本机会话' }] })
  })

  it('serves a mobile ws client end-to-end (turn + events)', async () => {
    await startGateway()
    link = createLink()
    link.start()
    await waitOnline(link)
    await hub.start({ cwd: storeDir })
    await sleep(100)

    const tokenRes = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    })
    const token = ((await tokenRes.json()) as { access_token: string }).access_token
    const ws = new WebSocket(`${base.replace('http', 'ws')}/v1/ws?access_token=${token}`)
    const frames: Record<string, unknown>[] = []
    ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)) as Record<string, unknown>)
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve()
    })
    const hello = await new Promise((resolve) => {
      const timer = setInterval(() => {
        const found = frames.find((frame) => frame.type === 'hello')
        if (found) {
          clearInterval(timer)
          resolve(found)
        }
      }, 10)
    })
    expect((hello as { session?: { id?: string } }).session?.id).toBe('sess-1')

    ws.send(JSON.stringify({ type: 'turn.submit', prompt: '在吗' }))
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (frames.some((frame) => frame.type === 'turn.accepted')) {
          clearInterval(timer)
          resolve()
        }
      }, 10)
    })
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (
          frames.some(
            (frame) =>
              frame.type === 'event' &&
              (frame.event as { type?: string })?.type === 'turn.completed',
          )
        ) {
          clearInterval(timer)
          resolve()
        }
      }, 10)
    })
    expect(hub.submitted).toEqual([{ prompt: '在吗' }])
    ws.close()
  })

  it('relays attachment staging and turn.submit over the uplink', async () => {
    await startGateway()
    link = createLink()
    link.start()
    await waitOnline(link)
    await hub.start({ cwd: storeDir })
    await sleep(100)

    const tokenRes = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    })
    const token = ((await tokenRes.json()) as { access_token: string }).access_token

    // 1) 字节经 REST 进站 → 隧道 RPC 落到本机 hub（base64 在 RPC 边界，hub 拿到原文）。
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const upload = await fetch(`${base}/v1/attachments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' },
      body: png,
    })
    expect(upload.status).toBe(200)
    const staged = (await upload.json()) as { kind: string; size: number; handle: string }
    expect(staged).toMatchObject({ kind: 'image', size: 4, handle: 'h-1' })
    expect(hub.staged).toEqual([{ mime: 'image/png', dataBase64: png.toString('base64') }])

    // 2) turn.submit 携带 handle 引用 → 本机 hub 收到完整 attachments。
    const ws = new WebSocket(`${base.replace('http', 'ws')}/v1/ws?access_token=${token}`)
    const frames: Record<string, unknown>[] = []
    ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)) as Record<string, unknown>)
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve()
    })
    ws.send(
      JSON.stringify({
        type: 'turn.submit',
        prompt: '[image_1]',
        attachments: [
          { kind: 'image', chip: '[image_1]', mime: 'image/png', size: 4, handle: 'h-1' },
        ],
      }),
    )
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (frames.some((frame) => frame.type === 'turn.accepted')) {
          clearInterval(timer)
          resolve()
        }
      }, 10)
    })
    expect(hub.submitted[0]?.attachments).toEqual([
      { kind: 'image', chip: '[image_1]', mime: 'image/png', size: 4, handle: 'h-1' },
    ])
    ws.close()
  })

  it('serves /v1/models from the machine over the uplink', async () => {
    await startGateway()
    link = createLink()
    link.start()
    await waitOnline(link)

    const tokenRes = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    })
    const token = ((await tokenRes.json()) as { access_token: string }).access_token
    const response = await fetch(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      object: string
      current?: string
      data: { id: string; label?: string }[]
    }
    expect(body.object).toBe('list')
    expect(body.current).toBe('anthropic/mimo-v2.5-pro')
    expect(body.data[0]).toMatchObject({ id: 'anthropic/mimo-v2.5-pro', label: 'mimo（默认）' })
  })

  it('serves attachment bytes back through the uplink tunnel', async () => {
    await startGateway()
    link = createLink()
    link.start()
    await waitOnline(link)

    const tokenRes = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    })
    const token = ((await tokenRes.json()) as { access_token: string }).access_token
    const found = await fetch(`${base}/v1/attachments/${'d'.repeat(64)}.png`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(found.status).toBe(200)
    expect(found.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await found.arrayBuffer())).toEqual(Buffer.from([5, 6, 7]))
    // 本机读不到的 handle → 网关 404。
    const missing = await fetch(`${base}/v1/attachments/${'e'.repeat(64)}.png`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(missing.status).toBe(404)
  })

  it('creates pairing invitations and lists devices', async () => {
    await startGateway()
    link = createLink()
    link.start()
    await waitOnline(link)

    const invitation = await link.createPairing()
    expect(invitation.code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/)
    expect(invitation.url).toContain('#pair=')

    const redeem = await fetch(`${base}/pairing/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: invitation.code, name: '手机' }),
    })
    expect(redeem.status).toBe(200)
    const devices = await link.listDevices()
    expect(devices.map((device) => device.name)).toEqual(['手机'])
    const revoked = await link.revokeDevice(devices[0]!.id)
    expect(revoked).toBe(true)
    expect(await link.listDevices()).toEqual([])
  })

  it('stands down when replaced by a same-credential instance', async () => {
    await startGateway()
    link = createLink()
    link.start()
    await waitOnline(link)

    // 同凭证第二个实例上线：网关顶替旧连接，旧实例应让位停连而不是互抢。
    const rival = createLink()
    rival.start()
    await waitOnline(rival)

    await sleep(300)
    expect(link.status.state).toBe('off')
    expect(link.status.attempt).toBe(0)
    expect(link.status.lastError).toContain('顶替')
    const attempts = link.status.attempt
    await sleep(300)
    expect(link.status.attempt).toBe(attempts)
    await rival.stop()
  })

  it('rejects rpc cwd that escapes the local workspace', async () => {
    await startGateway()
    link = createLink()
    link.start()
    await waitOnline(link)

    const tokenRes = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    })
    const token = ((await tokenRes.json()) as { access_token: string }).access_token
    const ws = new WebSocket(`${base.replace('http', 'ws')}/v1/ws?access_token=${token}`)
    const frames: Record<string, unknown>[] = []
    ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)) as Record<string, unknown>)
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve()
    })
    // 网关侧先用自己的 workspaceCwd 关一道（'/unused'）→ 越界在这里就被拦。
    ws.send(JSON.stringify({ type: 'session.start', cwd: '/etc' }))
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (frames.some((frame) => frame.type === 'error')) {
          clearInterval(timer)
          resolve()
        }
      }, 10)
    })
    const error = frames.find((frame) => frame.type === 'error') as { code?: string }
    expect(error?.code).toBeTruthy()
    ws.close()
  })

  it('reconnects after the gateway restarts', async () => {
    await startGateway()
    link = createLink()
    link.start()
    await waitOnline(link)

    await gateway!.close()
    gateway = undefined
    await sleep(300)
    expect(link.status.state).toBe('connecting')

    await startGateway()
    await waitOnline(link, 10_000)
    expect(link.status.state).toBe('online')
  })

  it('stays quiet when unconfigured and reports the reason', async () => {
    link = new RemoteLink({
      config: () => undefined,
      hub,
      workspaceCwd: storeDir,
      initialBackoffMs: 20,
      logger: () => {},
    })
    link.start()
    await sleep(80)
    expect(link.status.state).toBe('connecting')
    expect(link.status.lastError).toBe('remote is not configured')
    // 未配置期间不应发起任何网络拨号。
    expect(link.status.gatewayUrl).toBeUndefined()
  })
})
