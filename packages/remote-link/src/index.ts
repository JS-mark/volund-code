/**
 * @volund/remote-link — 远程控制的本机侧（REM-r1）：向公网网关反向拨出 /uplink，
 * 把本地 SessionHub 暴露为网关的可路由实例。
 *
 * 职责：
 * - 凭证：client_credentials 换 JWT（缓存至临近过期；重连时按需重取）；
 * - 连接：WSS /uplink + `uplink.register` 注册（active/pending 快照）；
 *   断线指数退避重连（默认 1s 起、上限 30s）；
 * - 桥接：网关 hub RPC → 本地 SessionHub；本地事件/状态变化 → 网关；
 *   cwd 关卡在本地二次校验（workspaceCwd 内，realpath 防 symlink 逃逸）；
 * - 配对：pairing.create / devices.list / device.revoke（转发给网关）。
 *
 * `start()` 幂等；配置在每次拨号前经 `config()` 现取（tab 里改完立即生效）。
 */
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { hostname as osHostname } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'

import type { GatewayEnvelope, GatewayHubLike } from '@volund/gateway-server'
import type { GatewaySubmitAttachment } from '@volund/gateway-server'
import type { MachineFrame, UplinkCommandMethod } from '@volund/gateway-server'

/** 连接配置（缺任一字段视为未配置，等待重试）。 */
export interface RemoteLinkConfig {
  readonly gatewayUrl: string
  readonly clientId: string
  readonly clientSecret: string
}

export type RemoteLinkState = 'off' | 'connecting' | 'online'

export interface RemoteLinkStatus {
  readonly state: RemoteLinkState
  readonly instanceId: string
  readonly gatewayUrl: string | undefined
  /** connecting 时的累计尝试次数与最近一次错误（online 后清零）。 */
  readonly attempt: number
  readonly lastError: string | undefined
  readonly lastOnlineAt: number | undefined
}

export interface PairedDeviceView {
  readonly id: string
  readonly name: string
  readonly pairedAt: number
  readonly lastSeen: number
}

export interface PairingInvitation {
  readonly code: string
  readonly url: string
  readonly expiresAt: number
}

/** 结构化 WS 客户端面（默认包原生 WebSocket；测试可注入）。 */
export interface UplinkSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  onOpen(handler: () => void): void
  onMessage(handler: (data: string) => void): void
  /** code/reason 用于识别「被同凭证新实例顶替」（1008）——顶替即停连，不打注册战。 */
  onClose(handler: (code: number, reason: string) => void): void
}

export interface RemoteLinkOptions {
  /** 每次拨号前解析的配置读取器（undefined = 未配置，进等待重试）。 */
  readonly config: () => RemoteLinkConfig | undefined
  /** 本机会话枢纽（apps/cli 装配 SessionHub + model 别名包装后传入）。 */
  readonly hub: GatewayHubLike
  /** /v1/sessions 数据源（缺省空列表）。 */
  readonly listSessions?: () => Promise<readonly unknown[]>
  /** cwd 关卡根（会话 cwd 被关进这里）。 */
  readonly workspaceCwd: string
  readonly version?: string
  readonly hostname?: string
  /** 上报的渠道清单（默认 ['mobile-web']）。 */
  readonly channels?: readonly string[]
  /** 重连退避（默认 1s 起、×2、上限 30s）。 */
  readonly initialBackoffMs?: number
  readonly maxBackoffMs?: number
  readonly logger?: (message: string) => void
  readonly now?: () => number
  readonly fetchImpl?: typeof fetch
  readonly socketFactory?: (url: string) => UplinkSocket
}

interface OutstandingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (cause: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * 远程控制链路：一个可 start/stop 的长连接对象。状态变化经 onState 通知
 *（web 远程控制页订阅展示）；配对/设备管理命令只在 online 时可用。
 */
export class RemoteLink {
  readonly instanceId = randomUUID()

  private running = false
  private state: RemoteLinkState = 'off'
  private attempt = 0
  private lastError: string | undefined
  private lastOnlineAt: number | undefined
  private reportedGatewayUrl: string | undefined
  private socket: UplinkSocket | undefined
  private detachHub: (() => void) | undefined
  private unsubscribeState: (() => void) | undefined
  private stateSignature = ''
  private readonly pending = new Map<string, OutstandingRequest>()
  private nextRef = 0
  private token: { value: string; expiresAtMs: number } | undefined
  /** 被同凭证的新实例顶替（1008 replaced）后置位：让位不重连，避免注册战。 */
  private replacedByPeer = false
  private readonly listeners = new Set<(status: RemoteLinkStatus) => void>()
  private readonly log: (message: string) => void
  private readonly now: () => number

  constructor(private readonly options: RemoteLinkOptions) {
    this.log = options.logger ?? (() => {})
    this.now = options.now ?? (() => Date.now())
  }

  get status(): RemoteLinkStatus {
    return {
      state: this.state,
      instanceId: this.instanceId,
      gatewayUrl: this.reportedGatewayUrl,
      attempt: this.attempt,
      lastError: this.lastError,
      lastOnlineAt: this.lastOnlineAt,
    }
  }

  onState(listener: (status: RemoteLinkStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private setState(state: RemoteLinkState, patch: { error?: string } = {}): void {
    this.state = state
    if (patch.error !== undefined) this.lastError = patch.error
    if (state === 'online') {
      this.attempt = 0
      this.lastError = undefined
      this.lastOnlineAt = this.now()
    }
    const status = this.status
    for (const listener of this.listeners) listener(status)
  }

  /** 幂等启动：进入拨号循环（已在跑则无操作）；清除上次的顶替让位标记。 */
  start(): void {
    if (this.running) return
    this.running = true
    this.attempt = 0
    this.replacedByPeer = false
    void this.loop()
  }

  async stop(): Promise<void> {
    this.running = false
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('remote link stopped'))
    }
    this.pending.clear()
    this.detachHub?.()
    this.detachHub = undefined
    this.socket?.close()
    this.socket = undefined
    this.setState('off')
  }

  /** 生成配对邀请（一次性配对码 + 手机入口 URL）；仅 online 可用。 */
  async createPairing(): Promise<PairingInvitation> {
    const created = (await this.request('pairing.create', {})) as {
      code?: unknown
      url?: unknown
      expiresAt?: unknown
    }
    if (
      typeof created.code !== 'string' ||
      typeof created.url !== 'string' ||
      typeof created.expiresAt !== 'number'
    )
      throw new Error('gateway returned a malformed pairing invitation')
    return { code: created.code, url: created.url, expiresAt: created.expiresAt }
  }

  async listDevices(): Promise<readonly PairedDeviceView[]> {
    const result = (await this.request('devices.list', {})) as { devices?: unknown }
    if (!Array.isArray(result.devices)) return []
    return result.devices.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const device = entry as Record<string, unknown>
      if (typeof device.id !== 'string' || typeof device.name !== 'string') return []
      return [
        {
          id: device.id,
          name: device.name,
          pairedAt: typeof device.pairedAt === 'number' ? device.pairedAt : 0,
          lastSeen: typeof device.lastSeen === 'number' ? device.lastSeen : 0,
        },
      ]
    })
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    const result = (await this.request('device.revoke', { deviceId })) as { revoked?: unknown }
    return result.revoked === true
  }

  // ── 拨号循环 ───────────────────────────────────────────────────────────

  private async loop(): Promise<void> {
    let backoff = this.options.initialBackoffMs ?? 1_000
    const maxBackoff = this.options.maxBackoffMs ?? 30_000
    while (this.running) {
      const config = this.options.config()
      if (!config) {
        this.setState('connecting', { error: 'remote is not configured' })
        await this.delay(5_000)
        continue
      }
      this.reportedGatewayUrl = config.gatewayUrl
      this.attempt += 1
      try {
        this.setState('connecting')
        await this.connect(config)
        // connect 只在已建立连接断开后返回：重置退避，立即重试。
        backoff = this.options.initialBackoffMs ?? 1_000
        if (!this.running) break
        // 被同凭证的新实例顶替：让位停连（否则两个实例互抢注册，事件/turn 全抖断）。
        if (this.replacedByPeer) {
          this.setState('off', {
            error: '已被同凭证的另一个实例顶替，本实例让位（重开远程控制可抢回）',
          })
          this.log('uplink replaced by a newer instance; standing down')
          break
        }
        this.setState('connecting', { error: 'uplink disconnected' })
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        this.setState('connecting', { error: message })
        this.log(`remote link attempt ${this.attempt} failed: ${message}`)
      }
      if (!this.running) break
      await this.delay(backoff)
      backoff = Math.min(backoff * 2, maxBackoff)
    }
  }

  private async connect(config: RemoteLinkConfig): Promise<void> {
    const token = await this.ensureToken(config)
    const gatewayBase = config.gatewayUrl.replace(/\/+$/, '')
    const url = `${gatewayBase.replace(/^http/, 'ws')}/uplink?access_token=${encodeURIComponent(token)}`
    await new Promise<void>((resolveDisconnected, rejectConnect) => {
      const socket = this.createSocket(url)
      this.socket = socket
      let opened = false
      let settled = false
      socket.onOpen(() => {
        opened = true
        this.sendRegister()
      })
      socket.onMessage((data) => {
        void this.handleFrame(data).catch((cause) => {
          this.log(`uplink frame error: ${String(cause)}`)
        })
      })
      socket.onClose((code, reason) => {
        if (settled) return
        settled = true
        // 1008 + replaced：同凭证的新实例完成注册，本连接被顶替（见 loop 的让位逻辑）。
        if (code === 1008 && /replaced/i.test(reason)) this.replacedByPeer = true
        this.detachHub?.()
        this.detachHub = undefined
        for (const request of this.pending.values()) {
          clearTimeout(request.timer)
          request.reject(new Error('uplink disconnected'))
        }
        this.pending.clear()
        this.socket = undefined
        // open 前关闭 = 连不上（凭证/网络/网关不可达）；open 后关闭 = 正常断线。
        if (opened) resolveDisconnected()
        else rejectConnect(new Error('uplink connection failed'))
      })
    })
  }

  private sendRegister(): void {
    const hub = this.options.hub
    const active = hub.active
    this.stateSignature = this.signatureOf()
    this.socket?.send(
      JSON.stringify({
        type: 'uplink.register',
        instance: {
          instanceId: this.instanceId,
          workspaceCwd: this.options.workspaceCwd,
          hostname: this.options.hostname ?? osHostname(),
          ...(this.options.version ? { version: this.options.version } : {}),
          channels: this.options.channels ?? ['mobile-web'],
          active: active ? { id: active.id, ...(active.cwd ? { cwd: active.cwd } : {}) } : null,
          pendingPermissions: hub.pendingPermissionIds(),
        },
      } satisfies MachineFrame),
    )
  }

  /** 本机 → 网关命令（配对/设备管理）。 */
  private request(method: UplinkCommandMethod, params: Record<string, unknown>): Promise<unknown> {
    if (this.state !== 'online' || !this.socket)
      return Promise.reject(new Error('remote link is not online'))
    const ref = `req-${++this.nextRef}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(ref)
        reject(new Error(`uplink request timeout: ${method}`))
      }, 15_000)
      timer.unref?.()
      this.pending.set(ref, { resolve, reject, timer })
      this.socket!.send(JSON.stringify({ type: 'req', ref, method, params } satisfies MachineFrame))
    })
  }

  private async handleFrame(text: string): Promise<void> {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(text) as Record<string, unknown>
    } catch {
      return
    }
    switch (frame.type) {
      case 'uplink.registered': {
        // 注册确认：挂事件转发 + 状态推送，转入 online。
        this.attachHubForwarding()
        this.setState('online')
        this.log(`remote link online: ${this.reportedGatewayUrl ?? ''}`)
        return
      }
      case 'res': {
        const ref = typeof frame.ref === 'string' ? frame.ref : undefined
        if (!ref) return
        const pending = this.pending.get(ref)
        if (!pending) return
        this.pending.delete(ref)
        clearTimeout(pending.timer)
        if (frame.ok === true) pending.resolve(frame.result)
        else {
          const error = frame.error as { message?: unknown } | undefined
          pending.reject(
            new Error(typeof error?.message === 'string' ? error.message : 'uplink request failed'),
          )
        }
        return
      }
      case 'rpc': {
        const id = typeof frame.id === 'string' ? frame.id : undefined
        const method = typeof frame.method === 'string' ? frame.method : undefined
        if (!id || !method) return
        const params =
          frame.params && typeof frame.params === 'object' && !Array.isArray(frame.params)
            ? (frame.params as Record<string, unknown>)
            : {}
        try {
          const result = await this.invokeHub(method, params)
          this.socket?.send(
            JSON.stringify({ type: 'rpc.result', id, ok: true, result } satisfies MachineFrame),
          )
        } catch (cause) {
          const code = (cause as { code?: unknown })?.code
          this.socket?.send(
            JSON.stringify({
              type: 'rpc.result',
              id,
              ok: false,
              error: {
                code: typeof code === 'string' ? code : 'remote_hub_failed',
                message: cause instanceof Error ? cause.message : String(cause),
              },
            } satisfies MachineFrame),
          )
        }
        return
      }
      case 'pong':
        return
      default:
        return
    }
  }

  private async invokeHub(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'hub.start') {
      const cwd = await confineCwd(this.options.workspaceCwd, String(params.cwd ?? ''))
      return this.options.hub.start({ cwd })
    }
    if (method === 'hub.resume') return this.options.hub.resume(String(params.id ?? ''))
    if (method === 'hub.submit')
      return this.options.hub.submit({
        prompt: String(params.prompt ?? ''),
        ...(typeof params.model === 'string' && params.model ? { model: params.model } : {}),
        // 附件形状已在网关 WS 边界校验（parseClientAttachments），此处只判数组。
        ...(Array.isArray(params.attachments) && params.attachments.length
          ? { attachments: params.attachments as readonly GatewaySubmitAttachment[] }
          : {}),
      })
    if (method === 'hub.stageAttachment') {
      const stage = this.options.hub.stageAttachment
      if (!stage) throw new Error('attachments are not supported by this hub')
      return stage.call(this.options.hub, {
        mime: String(params.mime ?? ''),
        dataBase64: String(params.dataBase64 ?? ''),
      })
    }
    if (method === 'hub.readAttachment') {
      const read = this.options.hub.readAttachment
      if (!read) throw new Error('attachment reads are not supported by this hub')
      return read.call(this.options.hub, String(params.handle ?? ''))
    }
    if (method === 'hub.interrupt') return this.options.hub.interrupt()
    if (method === 'hub.closeActive') return this.options.hub.closeActive()
    if (method === 'hub.decide')
      return this.options.hub.decide(String(params.requestId ?? ''), String(params.kind ?? ''))
    if (method === 'sessions.list')
      return this.options.listSessions ? this.options.listSessions() : []
    if (method === 'session.transcript') {
      const transcript = (
        this.options.hub as unknown as {
          transcript?(): { id?: string; cwd?: string; transcript: readonly unknown[] }
        }
      ).transcript
      return transcript ? Promise.resolve(transcript.call(this.options.hub)) : { transcript: [] }
    }
    if (method === 'models.list') {
      const list = this.options.hub.listModels
      return list ? list.call(this.options.hub) : { options: [] }
    }
    throw new Error(`unknown uplink rpc method: ${method}`)
  }

  /** 事件透传 + active/pending 变化重推（注册成功后挂上，断开即摘）。 */
  private attachHubForwarding(): void {
    this.detachHub?.()
    this.detachHub = this.options.hub.subscribe((envelope: GatewayEnvelope) => {
      this.socket?.send(JSON.stringify({ type: 'event', envelope } satisfies MachineFrame))
      const signature = this.signatureOf()
      if (signature !== this.stateSignature) {
        this.stateSignature = signature
        this.pushState()
      }
    })
  }

  private signatureOf(): string {
    const active = this.options.hub.active
    return `${active?.id ?? ''}|${this.options.hub.pendingPermissionIds().join(',')}`
  }

  private pushState(): void {
    const active = this.options.hub.active
    this.socket?.send(
      JSON.stringify({
        type: 'uplink.state',
        active: active ? { id: active.id, ...(active.cwd ? { cwd: active.cwd } : {}) } : null,
        pendingPermissions: this.options.hub.pendingPermissionIds(),
      } satisfies MachineFrame),
    )
  }

  // ── 凭证与工具 ─────────────────────────────────────────────────────────

  private async ensureToken(config: RemoteLinkConfig): Promise<string> {
    if (this.token && this.token.expiresAtMs - 60_000 > this.now()) return this.token.value
    const base = config.gatewayUrl.replace(/\/+$/, '')
    const fetchImpl = this.options.fetchImpl ?? fetch
    const res = await fetchImpl(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        scope: 'uplink chat sessions',
      }),
    })
    if (!res.ok) throw new Error(`gateway token request failed with ${res.status}`)
    const body = (await res.json()) as { access_token?: string; expires_in?: number }
    if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number')
      throw new Error('gateway token response is malformed')
    this.token = { value: body.access_token, expiresAtMs: this.now() + body.expires_in * 1000 }
    return body.access_token
  }

  private createSocket(url: string): UplinkSocket {
    const factory = this.options.socketFactory
    if (factory) return factory(url)
    // Node ≥22 / Bun 原生 WebSocket（bun compile 打包无 undici import 问题）。
    const ws = new WebSocket(url)
    return {
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
      onOpen: (handler) => {
        ws.onopen = () => handler()
      },
      onMessage: (handler) => {
        ws.onmessage = (event) => handler(String((event as MessageEvent).data))
      },
      onClose: (handler) => {
        ws.onclose = (event) => handler(event.code, event.reason)
        ws.onerror = () => handler(1006, 'transport error')
      },
    }
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }
}

/** cwd 禁出工作区（realpath 双端解析，防 symlink 逃逸；与网关侧 confineCwd 同规则）。 */
async function confineCwd(workspace: string, requested: string): Promise<string> {
  const candidate = isAbsolute(requested) ? requested : resolve(workspace, requested || '.')
  const [realCandidate, realWorkspace] = await Promise.all([
    realpath(candidate).catch(() => undefined),
    realpath(workspace).catch(() => workspace),
  ])
  if (!realCandidate)
    throw Object.assign(new Error(`cwd does not exist: ${requested}`), {
      code: 'remote_cwd_invalid',
    })
  const rel = relative(realWorkspace, realCandidate)
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel)))
    throw Object.assign(new Error('cwd escapes the local workspace'), {
      code: 'remote_cwd_invalid',
    })
  return realCandidate
}

export function createRemoteLink(options: RemoteLinkOptions): RemoteLink {
  return new RemoteLink(options)
}
