/**
 * volund 网关协议（REMOTE-GATEWAY-PROTOCOL v1）的机器可读契约。
 *
 * 网关是独立的协议面：任何实现了本文件帧类型的应用都能对接——
 * - **机器面（uplink）**：agent 运行时（volund 桌面端或其他实现）经
 *   `GET /uplink`（WS，Bearer + uplink scope）反向拨出注册，承载 hub RPC、
 *   事件透传与状态快照；实现方参照 MachineFrame / GatewayFrame。
 * - **客户端面（device）**：移动站/Web 后端/CI 经 REST `/v1/*` +
 *   `GET /v1/ws`（WS，Bearer chat/sessions scope）驱动会话；
 *   实现方参照 ClientFrame / ServerFrame。
 *
 * 语义细节（幂等/超时/乐观更新/配对）见 packages/gateway-server/PROTOCOL.md。
 * 帧字段只增不改（新增 optional 字段、新增 type 均为兼容变更）。
 */
import type { GatewayEnvelope, GatewaySubmitAttachment } from './hub'

// ── 共享形状 ───────────────────────────────────────────────────────────

/** 活动会话快照（null = 无活动会话）。 */
export type ProtocolActiveState = { id: string; cwd?: string } | null

/** 帧内错误形状（code 见 PROTOCOL.md 错误码表）。 */
export interface ProtocolError {
  readonly code: string
  readonly message: string
}

// ── 机器面：本机（uplink 拨出方）→ 网关 ────────────────────────────────

/** 首帧：注册即路由。同 client 重复注册时新连接顶替旧连接。 */
export interface UplinkRegisterFrame {
  readonly type: 'uplink.register'
  readonly instance: {
    readonly instanceId: string
    readonly workspaceCwd: string
    readonly hostname?: string
    readonly version?: string
    /** 本机支持的渠道清单（如 ['mobile-web']）。 */
    readonly channels: readonly string[]
    readonly active: ProtocolActiveState
    readonly pendingPermissions: readonly string[]
  }
}

/** 活动会话/待审批快照变化时重推（active 与 pendingPermissions 同帧成对）。 */
export interface UplinkStateFrame {
  readonly type: 'uplink.state'
  readonly active: ProtocolActiveState
  readonly pendingPermissions: readonly string[]
}

/** hub 事件透传（信封与 /v1/ws 下行 event 同形）。 */
export interface UplinkEventFrame {
  readonly type: 'event'
  readonly envelope: GatewayEnvelope
}

/** 网关 hub RPC 的应答。 */
export interface UplinkRpcResultFrame {
  readonly type: 'rpc.result'
  readonly id: string
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: ProtocolError
}

/** 本机经 uplink 发起的命令（配对码/设备管理）。 */
export type UplinkCommandMethod = 'pairing.create' | 'devices.list' | 'device.revoke'

export interface UplinkRequestFrame {
  readonly type: 'req'
  readonly ref: string
  readonly method: UplinkCommandMethod
  readonly params: Record<string, unknown>
}

export interface UplinkPingFrame {
  readonly type: 'ping'
}

export type MachineFrame =
  | UplinkRegisterFrame
  | UplinkStateFrame
  | UplinkEventFrame
  | UplinkRpcResultFrame
  | UplinkRequestFrame
  | UplinkPingFrame

// ── 机器面：网关 → 本机 ────────────────────────────────────────────────

/** 注册确认。 */
export interface UplinkRegisteredFrame {
  readonly type: 'uplink.registered'
  readonly serverId: string
  readonly version: string
}

/** 网关侧可调用的 hub RPC 方法（本机侧须全部实现）。 */
export type HubRpcMethod =
  | 'hub.start'
  | 'hub.resume'
  | 'hub.submit'
  | 'hub.interrupt'
  | 'hub.closeActive'
  | 'hub.decide'
  | 'hub.stageAttachment'
  | 'hub.readAttachment'
  | 'sessions.list'
  | 'session.transcript'
  | 'models.list'

export interface UplinkRpcFrame {
  readonly type: 'rpc'
  readonly id: string
  readonly method: HubRpcMethod
  readonly params: Record<string, unknown>
}

/** 本机 req 的应答。 */
export interface UplinkResponseFrame {
  readonly type: 'res'
  readonly ref: string
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: ProtocolError
}

export interface UplinkPongFrame {
  readonly type: 'pong'
}

export type GatewayFrame =
  | UplinkRegisteredFrame
  | UplinkRpcFrame
  | UplinkResponseFrame
  | UplinkPongFrame

// ── 客户端面：设备/调用方 → 网关（/v1/ws） ─────────────────────────────

export type ClientFrame =
  | { readonly type: 'ping'; readonly ref?: string }
  | { readonly type: 'session.start'; readonly ref?: string; readonly cwd?: string }
  | { readonly type: 'session.resume'; readonly ref?: string; readonly id: string }
  | { readonly type: 'session.end'; readonly ref?: string }
  | {
      readonly type: 'turn.submit'
      readonly ref?: string
      readonly prompt: string
      readonly model?: string
      /** 附件引用（先经 POST /v1/attachments 暂存换 handle；prompt 为空时 chip 占位）。 */
      readonly attachments?: readonly GatewaySubmitAttachment[]
    }
  | { readonly type: 'turn.interrupt'; readonly ref?: string }
  | {
      readonly type: 'permission.decide'
      readonly ref?: string
      readonly requestId: string
      readonly kind: string
    }

/**
 * turn.submit 的 attachments 字段校验（与 web-server 的 parseSubmitAttachments
 * 同语义）：形状不符 → undefined（400）；缺省 → []。
 */
export function parseClientAttachments(
  value: unknown,
): readonly GatewaySubmitAttachment[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const out: GatewaySubmitAttachment[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined
    const candidate = item as Record<string, unknown>
    if (candidate.kind !== 'image' && candidate.kind !== 'file') return undefined
    if (typeof candidate.mime !== 'string' || typeof candidate.chip !== 'string') return undefined
    if (typeof candidate.size !== 'number' || !Number.isFinite(candidate.size)) return undefined
    if (candidate.handle !== undefined && typeof candidate.handle !== 'string') return undefined
    if (candidate.path !== undefined && typeof candidate.path !== 'string') return undefined
    out.push({
      kind: candidate.kind,
      mime: candidate.mime,
      chip: candidate.chip,
      size: candidate.size,
      ...(typeof candidate.handle === 'string' ? { handle: candidate.handle } : {}),
      ...(typeof candidate.path === 'string' ? { path: candidate.path } : {}),
    })
  }
  return out
}

/** hello 帧：连接即发，携带会话/审批快照（移动端刷新重建视图用）。 */
export interface ServerHelloFrame {
  readonly type: 'hello'
  readonly serverId: string
  readonly version: string
  readonly session: ProtocolActiveState
  readonly pendingPermissions: readonly string[]
}

export type ServerFrame =
  | ServerHelloFrame
  | { readonly type: 'pong'; readonly ref?: string }
  | {
      readonly type: 'session.attached'
      readonly ref?: string
      readonly id: string
      readonly cwd?: string
    }
  | { readonly type: 'session.ended'; readonly ref?: string }
  | { readonly type: 'turn.accepted'; readonly ref?: string }
  | { readonly type: 'turn.interrupt_requested'; readonly ref?: string }
  | {
      readonly type: 'permission.decided'
      readonly ref?: string
      readonly requestId: string
      readonly decided: boolean
    }
  | ({ readonly type: 'event' } & GatewayEnvelope)
  | ({ readonly type: 'error'; readonly ref?: string } & ProtocolError)
