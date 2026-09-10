/**
 * Uplink 中转通道（远程控制 REM-r1）：本机 volund 向公网网关的反向拨出连接。
 *
 * 拓扑：移动端/远程客户端 → 网关（公网 VPS）→ /uplink 反向隧道 → 本机 SessionHub。
 * 本机不做端口暴露，全部流量走网关中转；`GatewayHubLike` 在网关侧被 RPC 化——
 * `/v1/ws`、`/v1/chat/completions` 的处理逻辑不感知 hub 在本地还是远端。
 *
 * 帧协议（JSON 文本帧，`type` 判别；契约锚点 src/protocol.ts + ../PROTOCOL.md）：
 * - 本机 → 网关：
 *   `uplink.register` {instance:{instanceId,workspaceCwd,hostname,version,channels,
 *                    active,pendingPermissions}}   首帧，注册即路由
 *   `uplink.state`    {active,pendingPermissions}   活动会话/审批快照变化时重推
 *   `event`           {envelope}                    hub 事件透传（与 /v1/ws 同信封）
 *   `rpc.result`      {id,ok,result|error}          网关 RPC 的应答
 *   `req`             {ref,method,params}           本机发起的请求（配对码/设备管理）
 * - 网关 → 本机：
 *   `uplink.registered` {serverId,version}          注册确认
 *   `rpc`            {id,method,params}             hub 方法调用（hub.start/…/sessions.list）
 *   `res`            {ref,ok,result|error}          本机 req 的应答
 *   `pong`                                          应答 app 级 ping
 *
 * 同步面：`active`/`pendingPermissionIds()` 是同步属性，但远端天然异步——
 * 由注册帧 + state 帧在网关侧缓存快照；`decide()` 的布尔返回值取自缓存，
 * 实际决策经 RPC 落到本机共享审批队列。
 */
import { randomUUID } from 'node:crypto'

import type {
  GatewayAttachmentBytes,
  GatewayEnvelope,
  GatewayHubLike,
  GatewayModelsView,
  GatewayStagedAttachment,
  GatewaySubmitAttachment,
} from './hub'
import type { GatewayFrame, HubRpcMethod } from './protocol'
import { GatewayError } from './queue'
import type { WsConnection } from './websocket'
import { WS_CLOSE } from './websocket'

/** 本机注册时上报的实例信息（routing 展示与 cwd 校验用）。 */
export interface UplinkInstanceInfo {
  readonly instanceId: string
  readonly workspaceCwd: string
  readonly hostname?: string
  readonly version?: string
  readonly channels: readonly string[]
  readonly connectedAt: number
}

export interface UplinkRegistration {
  readonly client: string
  readonly info: UplinkInstanceInfo
  readonly hub: RemoteHub
  /** 原始连接（closeAll/替换竞态时由注册表统一收尾）。 */
  readonly conn: WsConnection
}

/** 本机经 uplink 发起的请求（网关侧路由到 pairing 等处理器）。 */
export type UplinkCommandHandler = (input: {
  readonly method: string
  readonly params: Record<string, unknown>
}) => Promise<unknown>

export interface UplinkRegistryOptions {
  /** hub RPC 应答上限（默认 15s）；超时按链路中断处理。 */
  readonly rpcTimeoutMs?: number
  readonly logger?: (message: string) => void
}

interface RpcPending {
  readonly resolve: (value: unknown) => void
  readonly reject: (cause: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** `GatewayHubLike` 的远程代理：方法 RPC 化，事件/状态由本机推送。 */
export class RemoteHub implements GatewayHubLike {
  private activeState: { id: string; cwd?: string } | undefined
  private pendingIds: readonly string[] = []
  private nextRpcId = 0
  private readonly pending = new Map<string, RpcPending>()
  private readonly subscribers = new Set<(envelope: GatewayEnvelope) => void>()
  private closed = false

  constructor(
    private readonly conn: WsConnection,
    private readonly rpcTimeoutMs: number,
    private readonly onEvent: (envelope: GatewayEnvelope) => void,
  ) {}

  get active(): { id: string; cwd?: string } | undefined {
    return this.activeState
  }

  get open(): boolean {
    return !this.closed
  }

  /** 注册/状态帧更新同步快照（active 与 pendingPermissions 必须同帧成对）。 */
  applyState(
    active: { id: string; cwd?: string } | null,
    pendingPermissions: readonly string[],
  ): void {
    this.activeState = active ?? undefined
    this.pendingIds = pendingPermissions
  }

  start(input: { cwd: string }): Promise<{ id: string }> {
    return this.optimistic('hub.start', input, (result) => {
      const id = (result as { id?: unknown } | undefined)?.id
      if (typeof id === 'string')
        this.applyState({ id, ...(input.cwd ? { cwd: input.cwd } : {}) }, this.pendingIds)
    }) as Promise<{ id: string }>
  }

  resume(id: string): Promise<{ id: string }> {
    return this.optimistic('hub.resume', { id }, (result) => {
      const resumed = (result as { id?: unknown } | undefined)?.id
      if (typeof resumed === 'string') this.applyState({ id: resumed }, this.pendingIds)
    }) as Promise<{ id: string }>
  }

  submit(input: {
    prompt: string
    model?: string
    attachments?: readonly GatewaySubmitAttachment[]
  }): Promise<'accepted'> {
    return this.call('hub.submit', input) as Promise<'accepted'>
  }

  /** 附件暂存（REST /v1/attachments 的隧道腿）：60s 超时——大图经慢上行链路 base64 进站。 */
  stageAttachment(input: { mime: string; dataBase64: string }): Promise<GatewayStagedAttachment> {
    return this.call('hub.stageAttachment', input, 60_000) as Promise<GatewayStagedAttachment>
  }

  /** 附件字节回放（GET /v1/attachments/:handle 的隧道腿）：60s——大图经慢链路 base64 出站。 */
  readAttachment(handle: string): Promise<GatewayAttachmentBytes | undefined> {
    return this.call('hub.readAttachment', { handle }, 60_000) as Promise<
      GatewayAttachmentBytes | undefined
    >
  }

  /** 模型清单（GET /v1/models 的隧道腿）：当前生效模型 + 可切换候选。 */
  listModels(): Promise<GatewayModelsView> {
    return this.call('models.list', {}) as Promise<GatewayModelsView>
  }

  interrupt(): Promise<void> {
    return this.call('hub.interrupt', {}) as Promise<void>
  }

  closeActive(): Promise<void> {
    return this.optimistic('hub.closeActive', {}, () => {
      this.applyState(null, this.pendingIds)
    }) as Promise<void>
  }

  /** /v1/sessions 数据源：会话清单经同一隧道取自本机。 */
  listSessions(): Promise<readonly unknown[]> {
    return this.call('sessions.list', {}) as Promise<readonly unknown[]>
  }

  /** 活动会话持久化快照（移动端刷新后以 transcript 为准重建视图）。 */
  transcript(): Promise<{ id?: string; cwd?: string; transcript: readonly unknown[] }> {
    return this.call('session.transcript', {}) as Promise<{
      id?: string
      cwd?: string
      transcript: readonly unknown[]
    }>
  }

  subscribe(listener: (envelope: GatewayEnvelope) => void): () => void {
    this.subscribers.add(listener)
    return () => this.subscribers.delete(listener)
  }

  decide(requestId: string, kind: string): boolean {
    const known = this.pendingIds.includes(requestId)
    if (!known || this.closed) return false
    // 布尔语义 = 「是否在待审批列表」（ws.ts 的 permission.decided 应答面）；
    // 决策本体 fire-and-forget——本机队列幂等，重复/过期决策被静默忽略。
    void this.call('hub.decide', { requestId, kind }).catch(() => {})
    return true
  }

  pendingPermissionIds(): string[] {
    return [...this.pendingIds]
  }

  /** 本机事件帧：扇出给网关侧订阅者（broadcaster/审批兜底）。 */
  acceptEvent(envelope: GatewayEnvelope): void {
    for (const subscriber of this.subscribers) subscriber(envelope)
    this.onEvent(envelope)
  }

  acceptResult(frame: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown }): void {
    const id = typeof frame.id === 'string' ? frame.id : undefined
    if (!id) return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (frame.ok === true) pending.resolve(frame.result)
    else {
      const error = frame.error as
        | { code?: unknown; message?: unknown; status?: unknown }
        | undefined
      pending.reject(
        new GatewayError(
          typeof error?.code === 'string' ? error.code : 'gateway_upstream_failed',
          typeof error?.status === 'number' ? error.status : 502,
          typeof error?.message === 'string' ? error.message : 'uplink rpc failed',
        ),
      )
    }
  }

  /** 链路断开：拒绝全部在途 RPC，后续调用按离线报 503。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new GatewayError('gateway_uplink_offline', 503, 'machine uplink disconnected'))
    }
    this.pending.clear()
  }

  private call(
    method: HubRpcMethod,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.closed)
      return Promise.reject(
        new GatewayError('gateway_uplink_offline', 503, 'machine uplink disconnected'),
      )
    const id = `rpc-${++this.nextRpcId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new GatewayError('gateway_upstream_failed', 504, `uplink rpc timeout: ${method}`))
      }, timeoutMs ?? this.rpcTimeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      this.conn.send(JSON.stringify({ type: 'rpc', id, method, params } satisfies GatewayFrame))
    })
  }

  /**
   * RPC + 本地快照乐观更新：远端权威状态经 state 帧推送，但 RPC 应答先到时
   * 同步快照仍是旧值（chat/completions 在 await 后立刻读 hub.active）——用
   * 应答结果先行更新，state 帧随后覆盖为权威值。
   */
  private optimistic(
    method: HubRpcMethod,
    params: Record<string, unknown>,
    apply: (result: unknown) => void,
  ): Promise<unknown> {
    return this.call(method, params).then(
      (result) => {
        apply(result)
        return result
      },
      (cause) => {
        throw cause
      },
    )
  }
}

function asActiveState(value: unknown): { id: string; cwd?: string } | null | undefined {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entry = value as { id?: unknown; cwd?: unknown }
  if (typeof entry.id !== 'string' || !entry.id) return undefined
  return { id: entry.id, ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}) }
}

/**
 * 已注册实例表：client id（OAuth 机器凭证）→ uplink 连接。同 client 重复注册
 * （重连竞态）后者顶替前者——路由永远指向最新连接。
 */
export class UplinkRegistry {
  private readonly instances = new Map<string, UplinkRegistration>()
  private readonly hubListeners = new Set<(client: string, envelope: GatewayEnvelope) => void>()
  private readonly rpcTimeoutMs: number
  private readonly log: (message: string) => void

  constructor(options: UplinkRegistryOptions = {}) {
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? 15_000
    this.log = options.logger ?? (() => {})
  }

  /** 网关侧事件订阅（带来源 client 标记：broadcaster 按连接归属过滤）。 */
  subscribe(listener: (client: string, envelope: GatewayEnvelope) => void): () => void {
    this.hubListeners.add(listener)
    return () => this.hubListeners.delete(listener)
  }

  resolve(client: string): UplinkRegistration | undefined {
    return this.instances.get(client)
  }

  list(): readonly UplinkRegistration[] {
    return [...this.instances.values()]
  }

  closeAll(): void {
    for (const registration of this.instances.values()) {
      registration.hub.close()
      registration.conn.close(WS_CLOSE.goingAway, 'gateway shutting down')
    }
    this.instances.clear()
  }

  /**
   * 挂载一条已认证的 uplink 连接：等待首帧 `uplink.register` 完成注册，
   * 之后按帧协议路由。commandHandler 服务于本机发起的请求（配对/设备管理）。
   */
  attach(
    conn: WsConnection,
    input: {
      readonly client: string
      readonly serverId: string
      readonly version: string
      readonly commandHandler: UplinkCommandHandler
    },
  ): void {
    let registration: UplinkRegistration | undefined
    const send = (value: unknown) => conn.send(JSON.stringify(value))

    conn.onClose = () => {
      if (registration && this.instances.get(registration.client) === registration) {
        this.instances.delete(registration.client)
        this.log(`uplink disconnected: ${registration.client}`)
        // 主动通知该机器的客户端连接（mobile 的离线提示条；被新连接顶替的旧连接
        // 不走这里——registration 已非当前值，online 事件由新注册发出）。
        for (const listener of this.hubListeners)
          listener(registration.client, { kind: 'view', event: { type: 'machine.offline' } })
      }
      registration?.hub.close()
    }

    conn.onMessage = (text) => {
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(text) as Record<string, unknown>
      } catch {
        conn.close(1002, 'frame must be JSON')
        return
      }
      if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') {
        conn.close(1002, 'frame.type is required')
        return
      }
      if (!registration) {
        if (frame.type !== 'uplink.register') {
          conn.close(1002, 'first frame must be uplink.register')
          return
        }
        const instance = frame.instance
        if (!instance || typeof instance !== 'object' || Array.isArray(instance)) {
          conn.close(1002, 'uplink.register requires instanceId and workspaceCwd')
          return
        }
        const record = instance as Record<string, unknown>
        const instanceId =
          typeof record.instanceId === 'string' && record.instanceId ? record.instanceId : undefined
        const workspaceCwd =
          typeof record.workspaceCwd === 'string' ? record.workspaceCwd : undefined
        if (!instanceId || !workspaceCwd) {
          conn.close(1002, 'uplink.register requires instanceId and workspaceCwd')
          return
        }
        const active = asActiveState(record.active)
        const pendingPermissions = Array.isArray(record.pendingPermissions)
          ? (record.pendingPermissions as unknown[]).filter(
              (id): id is string => typeof id === 'string',
            )
          : []
        const channels = Array.isArray(record.channels)
          ? (record.channels as unknown[]).filter(
              (channel): channel is string => typeof channel === 'string',
            )
          : []
        const hub = new RemoteHub(conn, this.rpcTimeoutMs, (envelope) => {
          for (const listener of this.hubListeners) listener(input.client, envelope)
        })
        hub.applyState(active ?? null, pendingPermissions)
        registration = {
          client: input.client,
          info: {
            instanceId,
            workspaceCwd,
            ...(typeof record.hostname === 'string' ? { hostname: record.hostname } : {}),
            ...(typeof record.version === 'string' ? { version: record.version } : {}),
            channels,
            connectedAt: Date.now(),
          },
          hub,
          conn,
        }
        const previous = this.instances.get(input.client)
        if (previous) {
          // 重连竞态：旧连接上的在途 RPC 立即失败并断开，避免双写。
          this.instances.delete(input.client)
          previous.hub.close()
          previous.conn.close(WS_CLOSE.policy, 'replaced by a newer uplink')
          this.log(`uplink replaced stale connection: ${input.client}`)
        }
        this.instances.set(input.client, registration)
        this.log(`uplink registered: ${input.client} (${workspaceCwd})`)
        send({
          type: 'uplink.registered',
          serverId: input.serverId,
          version: input.version,
        } satisfies GatewayFrame)
        // 注册/重连成功 → 通知该机器的客户端连接本机上线（清离线提示用）。
        for (const listener of this.hubListeners)
          listener(input.client, {
            kind: 'view',
            event: { type: 'machine.online', cwd: workspaceCwd },
          })
        return
      }

      const hub = registration.hub
      switch (frame.type) {
        case 'event': {
          const envelope = frame.envelope as GatewayEnvelope | undefined
          if (!envelope || typeof envelope !== 'object' || typeof envelope.kind !== 'string') return
          hub.acceptEvent(envelope)
          return
        }
        case 'uplink.state': {
          const active = asActiveState(frame.active)
          if (active === undefined) return
          const pendingPermissions = Array.isArray(frame.pendingPermissions)
            ? (frame.pendingPermissions as unknown[]).filter(
                (id): id is string => typeof id === 'string',
              )
            : []
          hub.applyState(active, pendingPermissions)
          return
        }
        case 'rpc.result': {
          hub.acceptResult(frame)
          return
        }
        case 'ping': {
          send({ type: 'pong' } satisfies GatewayFrame)
          return
        }
        case 'req': {
          const ref = typeof frame.ref === 'string' ? frame.ref : ''
          const method = typeof frame.method === 'string' ? frame.method : ''
          const params =
            frame.params && typeof frame.params === 'object' && !Array.isArray(frame.params)
              ? (frame.params as Record<string, unknown>)
              : {}
          void input
            .commandHandler({ method, params })
            .then((result) => send({ type: 'res', ref, ok: true, result } satisfies GatewayFrame))
            .catch((cause) => {
              const error =
                cause instanceof GatewayError
                  ? cause
                  : new GatewayError(
                      'gateway_upstream_failed',
                      500,
                      cause instanceof Error ? cause.message : String(cause),
                    )
              send({
                type: 'res',
                ref,
                ok: false,
                error: { code: error.code, message: error.message },
              } satisfies GatewayFrame)
            })
          return
        }
        default:
          conn.close(1002, `unknown frame type: ${String(frame.type)}`)
      }
    }
  }
}

/** 注册帧的 instanceId 生成助手（remote-link 侧也用同规则）。 */
export function newUplinkInstanceId(): string {
  return randomUUID()
}
