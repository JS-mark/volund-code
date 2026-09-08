/**
 * /v1/ws 交互会话通道：全双工 JSON 帧承载会话生命周期 + turn 提交 + 权限审批。
 *
 * 客户端 → 服务端帧（全部 JSON 文本帧，`type` 判别）：
 * - `ping`                                  → `pong`
 * - `session.start`    {cwd?}               → `session.attached`（cwd 限 workspace 内）
 * - `session.resume`   {id}                 → `session.attached`
 * - `session.end`                           → `session.ended`
 * - `turn.submit`      {prompt, model?}     → `turn.accepted`（串行排队，忙时等锁）
 * - `turn.interrupt`                        → `turn.interrupt_requested`
 * - `permission.decide` {requestId, kind}   → `permission.decided`
 *
 * 服务端 → 客户端帧：
 * - `hello`（握手成功即发，含 serverId/version/当前活动会话）
 * - `event`（hub 信封透传：core=CoreEvent，view=permission.request 等视图事件）
 * - 上述各应答 + `error`（{code, message}，请求级错误，含回显 ref）
 *
 * 锁语义：turn.submit 与 session 生命周期命令进 FIFO 队列（与 chat/completions
 * 共用）；permission.decide / turn.interrupt / ping 不进队列（审批不能排在
 * 被审批的 turn 后面）。
 */
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import type { GatewayHubLike } from './hub'
import { GatewayError, TurnQueue } from './queue'
import type { WsConnection } from './websocket'
import { WS_CLOSE } from './websocket'

export interface WsChannelDeps {
  readonly hub: GatewayHubLike
  readonly queue: TurnQueue
  readonly workspaceCwd: string
  readonly queueTimeoutMs: number
  /** turn 持锁上限（默认 30min）：runner 静默卡死时强制放行队列。 */
  readonly maxTurnHoldMs: number
  readonly serverId: string
  readonly version: string
}

/** cwd 禁出 workspace（realpath 双端解析，防 symlink 逃逸）。 */
async function confineCwd(workspace: string, requested: string | undefined): Promise<string> {
  if (!requested) return workspace
  const candidate = isAbsolute(requested) ? requested : resolve(workspace, requested)
  const [realCandidate, realWorkspace] = await Promise.all([
    realpath(candidate).catch(() => undefined),
    realpath(workspace),
  ])
  if (!realCandidate)
    throw new GatewayError('gateway_schema_invalid', 400, `cwd does not exist: ${requested}`)
  const rel = relative(realWorkspace, realCandidate)
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel)))
    throw new GatewayError('gateway_schema_invalid', 400, 'cwd escapes the gateway workspace')
  return realCandidate
}

/** 等当前 turn 终态（完成/中断/失败）后释放队列锁；maxHoldMs 兜底防 runner 静默卡死。 */
function holdQueueUntilTurnEnd(hub: GatewayHubLike, release: () => void, maxHoldMs: number): void {
  const detach = hub.subscribe((envelope) => {
    const event = envelope.event as { type?: unknown }
    if (!event || typeof event.type !== 'string') return
    if (
      (envelope.kind === 'core' &&
        (event.type === 'turn.completed' || event.type === 'turn.aborted')) ||
      (envelope.kind === 'view' && event.type === 'turn.failed')
    ) {
      clearTimeout(timer)
      detach()
      release()
    }
  })
  const timer = setTimeout(() => {
    detach()
    release()
  }, maxHoldMs)
  timer.unref?.()
}

export function attachWsConnection(deps: WsChannelDeps, conn: WsConnection): void {
  const send = (value: unknown) => conn.send(JSON.stringify(value))
  send({
    type: 'hello',
    serverId: deps.serverId,
    version: deps.version,
    session: deps.hub.active ?? null,
    pendingPermissions: deps.hub.pendingPermissionIds(),
  })

  conn.onMessage = (text) => {
    void handleFrame(text).catch(() => {})
  }

  const replyError = (ref: string | undefined, cause: unknown) => {
    const error =
      cause instanceof GatewayError
        ? cause
        : new GatewayError(
            'gateway_upstream_failed',
            502,
            cause instanceof Error ? cause.message : String(cause),
          )
    send({ type: 'error', ...(ref ? { ref } : {}), code: error.code, message: error.message })
  }

  const handleFrame = async (text: string): Promise<void> => {
    let frame: { type?: unknown; ref?: unknown }
    try {
      frame = JSON.parse(text)
    } catch {
      send({ type: 'error', code: 'gateway_ws_protocol_error', message: 'frame must be JSON' })
      return
    }
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') {
      send({ type: 'error', code: 'gateway_ws_protocol_error', message: 'frame.type is required' })
      return
    }
    const ref = typeof frame.ref === 'string' ? frame.ref : undefined
    const body = frame as Record<string, unknown>
    switch (frame.type) {
      case 'ping':
        send({ type: 'pong', ...(ref ? { ref } : {}) })
        return
      case 'permission.decide': {
        const requestId = body.requestId
        const kind = body.kind
        if (typeof requestId !== 'string' || typeof kind !== 'string') {
          replyError(
            ref,
            new GatewayError('gateway_schema_invalid', 400, 'requestId and kind are required'),
          )
          return
        }
        send({
          type: 'permission.decided',
          ...(ref ? { ref } : {}),
          accepted: deps.hub.decide(requestId, kind),
        })
        return
      }
      case 'turn.interrupt':
        await deps.hub.interrupt()
        send({ type: 'turn.interrupt_requested', ...(ref ? { ref } : {}) })
        return
      case 'session.start':
      case 'session.resume':
      case 'session.end':
      case 'turn.submit': {
        // 进队列的命令：等锁 → 执行 → turn 类命令持锁到终态。
        let release: () => void
        try {
          release = await deps.queue.acquire(deps.queueTimeoutMs)
        } catch (cause) {
          replyError(ref, cause)
          return
        }
        try {
          if (frame.type === 'session.start') {
            const cwd = await confineCwd(
              deps.workspaceCwd,
              typeof body.cwd === 'string' ? body.cwd : undefined,
            )
            const started = await deps.hub.start({ cwd })
            send({ type: 'session.attached', ...(ref ? { ref } : {}), id: started.id, cwd })
            release()
            return
          }
          if (frame.type === 'session.resume') {
            const id = body.id
            if (typeof id !== 'string' || !id) {
              release()
              replyError(ref, new GatewayError('gateway_schema_invalid', 400, 'id is required'))
              return
            }
            try {
              await deps.hub.resume(id)
            } catch (cause) {
              release()
              replyError(
                ref,
                /not found|invalid session/i.test(
                  cause instanceof Error ? cause.message : String(cause),
                )
                  ? new GatewayError('gateway_session_not_found', 404, `session not found: ${id}`)
                  : cause,
              )
              return
            }
            send({ type: 'session.attached', ...(ref ? { ref } : {}), id })
            release()
            return
          }
          if (frame.type === 'session.end') {
            await deps.hub.closeActive()
            send({ type: 'session.ended', ...(ref ? { ref } : {}) })
            release()
            return
          }
          // turn.submit
          const prompt = body.prompt
          if (typeof prompt !== 'string' || !prompt.trim()) {
            release()
            replyError(ref, new GatewayError('gateway_schema_invalid', 400, 'prompt is required'))
            return
          }
          if (!deps.hub.active) {
            release()
            replyError(
              ref,
              new GatewayError(
                'gateway_schema_invalid',
                400,
                'no active session; send session.start first',
              ),
            )
            return
          }
          try {
            await deps.hub.submit({
              prompt,
              ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
            })
          } catch (cause) {
            release()
            replyError(ref, cause)
            return
          }
          send({ type: 'turn.accepted', ...(ref ? { ref } : {}) })
          holdQueueUntilTurnEnd(deps.hub, release, deps.maxTurnHoldMs)
          return
        } catch (cause) {
          release()
          replyError(ref, cause)
        }
        return
      }
      default:
        send({
          type: 'error',
          ...(ref ? { ref } : {}),
          code: 'gateway_ws_protocol_error',
          message: `unknown frame type: ${frame.type}`,
        })
    }
  }
}

/** WS 广播扇出：hub 事件 → 全部已认证连接。 */
export class WsBroadcaster {
  private readonly connections = new Set<WsConnection>()

  constructor(private readonly hub: GatewayHubLike) {
    this.hub.subscribe((envelope) => this.broadcast({ type: 'event', ...envelope }))
  }

  add(conn: WsConnection): void {
    this.connections.add(conn)
    conn.onClose = () => this.connections.delete(conn)
  }

  get size(): number {
    return this.connections.size
  }

  closeAll(code: number = WS_CLOSE.goingAway, reason: string = 'server shutting down'): void {
    for (const conn of this.connections) conn.close(code, reason)
    this.connections.clear()
  }

  private broadcast(value: unknown): void {
    const text = JSON.stringify(value)
    for (const conn of this.connections) conn.send(text)
  }
}
