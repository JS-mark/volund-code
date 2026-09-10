/**
 * 网关客户端（REM-r1 移动站）：配对核销 → 设备 token（localStorage）→
 * REST（/v1/sessions 等，Bearer）+ WS /v1/ws（?access_token=）。
 *
 * 网关基址解析（移动站可独立部署，与网关不同源）：
 * `#pair=CODE&gw=<url>` hash（配对链接携带）→ localStorage → ''（同源托管）。
 * 跨源部署时网关侧须配 GATEWAY_CORS_ORIGINS 放行本站 Origin；token 过期 →
 * 清本地回到配对页。
 */

export interface MobileSession {
  readonly token: string
  readonly deviceId: string
  readonly expiresAt: number
}

const STORAGE_KEY = 'volund-mobile-session'
const GATEWAY_STORAGE_KEY = 'volund-mobile-gateway'
const MODEL_STORAGE_KEY = 'volund-mobile-model'

/** 模型覆盖选择的本地持久化（设备级；切回默认即清除，跟随本机配置变化）。 */
export function loadModelOverride(): string | undefined {
  try {
    return localStorage.getItem(MODEL_STORAGE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

export function saveModelOverride(model: string | undefined): void {
  try {
    if (model) localStorage.setItem(MODEL_STORAGE_KEY, model)
    else localStorage.removeItem(MODEL_STORAGE_KEY)
  } catch {
    // 隐私模式等写不进存储时按不持久化处理
  }
}

/** 网关基址规范化：仅接受 http(s) 绝对地址，去尾斜杠；空串 = 同源。 */
function normalizeBase(raw: string): string {
  const value = raw.trim().replace(/\/+$/, '')
  if (value && !/^https?:\/\//.test(value)) throw new Error('网关地址须以 http(s):// 开头')
  return value
}

/** 当前生效的网关基址（'' = 与站点同源）。#gw= 命中时顺手持久化。 */
export function gatewayBase(): string {
  const fromHash = /[#&]gw=([^&]+)/.exec(window.location.hash)?.[1]
  if (fromHash) {
    try {
      const decoded = normalizeBase(decodeURIComponent(fromHash))
      if (decoded) {
        localStorage.setItem(GATEWAY_STORAGE_KEY, decoded)
        return decoded
      }
    } catch {
      // 非法 hash 参数按未配置处理
    }
  }
  try {
    return normalizeBase(localStorage.getItem(GATEWAY_STORAGE_KEY) ?? '')
  } catch {
    return ''
  }
}

/** 手动设置/清除网关基址（配对页表单）。 */
export function setGatewayBase(raw: string): void {
  const value = normalizeBase(raw)
  if (value) localStorage.setItem(GATEWAY_STORAGE_KEY, value)
  else localStorage.removeItem(GATEWAY_STORAGE_KEY)
}

/** 展示用网关标签：已解析基址去 scheme；同源托管时回退站点 host。 */
export function gatewayLabel(): string {
  const base = gatewayBase()
  return base ? base.replace(/^https?:\/\//, '') : window.location.host
}

export function loadSession(): MobileSession | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return undefined
    const session = JSON.parse(raw) as Partial<MobileSession>
    if (
      typeof session.token !== 'string' ||
      typeof session.deviceId !== 'string' ||
      typeof session.expiresAt !== 'number'
    )
      return undefined
    if (session.expiresAt * 1000 <= Date.now()) return undefined
    return { token: session.token, deviceId: session.deviceId, expiresAt: session.expiresAt }
  } catch {
    return undefined
  }
}

export function saveSession(session: MobileSession): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY)
}

/**
 * 凭证失效（REST 401 / WS 被策略关闭）的全局回调：页面据此清会话状态回配对页。
 * 只清 localStorage 不动 React state 的话，UI 会卡在聊天页永远「重连中」。
 */
let unauthorizedListener: (() => void) | undefined

export function setUnauthorizedHandler(handler: (() => void) | undefined): void {
  unauthorizedListener = handler
}

function notifyUnauthorized(): void {
  clearSession()
  unauthorizedListener?.()
}

/** 配对入口 hash：#pair=CODE[&gw=网关地址]（远程控制页二维码内容）。 */
export function pairingCodeFromHash(): string | undefined {
  const match = /[#&]pair=([A-Za-z0-9]+)/.exec(window.location.hash)
  return match?.[1]
}

export function clearPairingHash(): void {
  if (window.location.hash) window.history.replaceState(null, '', window.location.pathname)
}

export interface PairingRedeemResult extends MobileSession {}

/** 核销配对码 → 设备 token。失败抛 Error（网关错误信息透出）。 */
export async function redeemPairing(code: string, name: string): Promise<PairingRedeemResult> {
  let res: Response
  try {
    res = await fetch(`${gatewayBase()}/pairing/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.trim().toUpperCase(), name }),
    })
  } catch {
    // fetch 在断网与 CORS 拦截下都抛 TypeError——给出可操作的提示而非裸异常。
    throw new Error(
      '连不上网关：确认网关地址可达；跨源部署时网关侧须把本站 Origin 加进 GATEWAY_CORS_ORIGINS',
    )
  }
  const body = (await res.json()) as {
    access_token?: string
    device_id?: string
    expires_in?: number
    error?: { message?: string }
  }
  if (!res.ok || !body.access_token || !body.device_id)
    throw new Error(body.error?.message ?? `配对失败（${res.status}）`)
  const session: MobileSession = {
    token: body.access_token,
    deviceId: body.device_id,
    expiresAt: Math.floor(Date.now() / 1000) + (body.expires_in ?? 0),
  }
  saveSession(session)
  return session
}

export interface SessionSummary {
  id: string
  cwd: string
  updatedAt: string
  title: string
  summary?: string
}

/** 已暂存附件（POST /v1/attachments 返回面；handle 由本机 AttachmentStore 颁发）。 */
export interface StagedAttachment {
  kind: 'file' | 'image'
  mime: string
  size: number
  handle?: string
}

/**
 * 附件字节缓存：transcript 图片随滚动反复挂载/卸载，字节内容寻址不可变——
 * 缓存 Blob（非 objectURL，挂载方自行 create/revoke），失败不留缓存允许重试。
 */
const attachmentBlobCache = new Map<string, Promise<Blob>>()
const ATTACHMENT_CACHE_LIMIT = 30

/** 网关 REST 面（Bearer token）。 */
export class GatewayApi {
  constructor(private readonly token: string) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${gatewayBase()}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    })
    if (res.status === 401) {
      notifyUnauthorized()
      throw new Error('凭证已失效，请重新配对')
    }
    if (!res.ok) throw new Error(`网关请求失败（${res.status}）`)
    return (await res.json()) as T
  }

  sessions(): Promise<{ sessions: SessionSummary[] }> {
    return this.get<{ sessions: SessionSummary[] }>('/v1/sessions')
  }

  transcript(): Promise<{ id?: string; cwd?: string; transcript: unknown[] }> {
    return this.get('/v1/sessions/active/transcript')
  }

  /** 模型清单（relay 模式经隧道取自本机；data 为 OpenAI 形状，current 为默认模型）。 */
  models(): Promise<{ current?: string; data: { id: string; label?: string }[] }> {
    return this.get('/v1/models')
  }

  /** 附件上传：原始字节直传（Content-Type = 图片 mime），回本机 AttachmentStore 引用。 */
  async uploadAttachment(bytes: Blob, mime: string): Promise<StagedAttachment> {
    const res = await fetch(`${gatewayBase()}/v1/attachments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': mime },
      body: bytes,
    })
    if (res.status === 401) {
      notifyUnauthorized()
      throw new Error('凭证已失效，请重新配对')
    }
    const body = (await res.json().catch(() => ({}))) as StagedAttachment & {
      error?: { message?: string }
    }
    if (!res.ok) throw new Error(body.error?.message ?? `图片上传失败（${res.status}）`)
    return body
  }

  /**
   * 附件字节下载（transcript/跨端消息的图片回显）：img 标签带不了 Authorization 头，
   * 只能 fetch 取 Blob 再转 objectURL；字节按 handle 缓存（内容寻址不可变）。
   */
  downloadAttachment(handle: string): Promise<Blob> {
    const key = `${gatewayBase()}|${handle}`
    const hit = attachmentBlobCache.get(key)
    if (hit) return hit
    const pending = (async () => {
      const res = await fetch(`${gatewayBase()}/v1/attachments/${handle}`, {
        headers: { Authorization: `Bearer ${this.token}` },
      })
      if (res.status === 401) {
        notifyUnauthorized()
        throw new Error('凭证已失效，请重新配对')
      }
      if (!res.ok) throw new Error(`图片下载失败（${res.status}）`)
      return res.blob()
    })()
    attachmentBlobCache.set(key, pending)
    if (attachmentBlobCache.size > ATTACHMENT_CACHE_LIMIT) {
      const oldest = attachmentBlobCache.keys().next().value
      if (oldest !== undefined) attachmentBlobCache.delete(oldest)
    }
    pending.catch(() => attachmentBlobCache.delete(key))
    return pending
  }
}

// ── WS 通道（/v1/ws 帧协议见 gateway-server/src/ws.ts） ────────────────────

export interface WsEnvelope {
  streamVersion?: number
  cursor?: string
  kind: 'core' | 'view' | 'control'
  sessionId?: string
  event: { type: string; payload?: Record<string, unknown> }
}

export interface WsHello {
  serverId: string
  version: string
  session: { id: string; cwd?: string } | null
  pendingPermissions: string[]
}

export interface GatewayWsHandlers {
  onOpenChange(open: boolean): void
  onHello(hello: WsHello): void
  onEvent(envelope: WsEnvelope): void
  onFrame(frame: Record<string, unknown>): void
  /** WS 被策略关闭（1008 = 设备已被桌面端撤销）：不重连，回配对页。 */
  onRevoked?(reason: string): void
}

/** 移动站 WS 客户端：自动重连（2.5s 退避），命令经 send() 发 JSON 帧。 */
export class GatewayWs {
  private ws: WebSocket | undefined
  private closed = false
  private retryTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly token: string,
    private readonly handlers: GatewayWsHandlers,
  ) {}

  connect(): void {
    if (this.closed) return
    const base = gatewayBase()
    const wsBase = base
      ? base.replace(/^http/, 'ws')
      : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
    const ws = new WebSocket(`${wsBase}/v1/ws?access_token=${encodeURIComponent(this.token)}`)
    this.ws = ws
    ws.onopen = () => this.handlers.onOpenChange(true)
    ws.onmessage = (event) => {
      // 只处理当前连接的帧：重连后旧连接若未竟，其迟到事件不应重复进 reducer。
      if (this.ws !== ws) return
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(String(event.data)) as Record<string, unknown>
      } catch {
        return
      }
      if (frame.type === 'hello') {
        this.handlers.onHello(frame as unknown as WsHello)
        return
      }
      if (frame.type === 'event') {
        const envelope = frame as unknown as WsEnvelope
        if (envelope && typeof envelope.kind === 'string' && envelope.event) {
          this.handlers.onEvent(envelope)
          return
        }
      }
      this.handlers.onFrame(frame)
    }
    const onDrop = (code?: number, reason?: string) => {
      // 策略关闭（设备被撤销）：不重连，通知上层回配对页。
      if (code === 1008) {
        this.handlers.onOpenChange(false)
        this.handlers.onRevoked?.(reason ?? '')
        return
      }
      this.handlers.onOpenChange(false)
      if (this.closed) return
      // onerror 与 onclose 对同一次断开都会触发——不判重会调度两条重连，
      // 两条连接并存会让每个事件进 reducer 两次（流式文本翻倍/错乱）。
      if (this.retryTimer) return
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined
        this.connect()
      }, 2_500)
    }
    ws.onclose = (event) => onDrop(event.code, event.reason)
    ws.onerror = () => onDrop()
  }

  send(frame: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame))
  }

  close(): void {
    this.closed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.ws?.close()
    this.ws = undefined
  }
}
