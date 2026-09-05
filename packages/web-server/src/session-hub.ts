/**
 * SessionHub（§22.8.3 / Web 计划 P3-01/02/06）：把 SessionController 的单活动会话
 * 变成 Web 的权威状态源——CoreEvent 透传（WebEventEnvelope + 单调 cursor）、
 * 权限审批队列（SSE 推卡 + decide 解析）、turn 提交的串行化。
 *
 * 诚实边界（本切片）：cursor 是内存态单调计数，重连经 GET transcript 快照 + 新
 * cursor 续传；pending permission 随 server 生命周期作废（§22.9.1）。
 */
import type { InteractivePermissionDecision, InteractiveSession } from '@volund/app-runtime'

/** SessionController 的最小结构面（@volund/app-runtime 的 SessionController 结构满足）。 */
export interface SessionControllerLike {
  startInteractive?(input: { cwd: string }): Promise<InteractiveSession<unknown>>
  resumeInteractive?(id: string): Promise<InteractiveSession<unknown>>
  interrupt(): Promise<void>
  end(): Promise<void>
}

/** CoreEvent 透传信封（§22.8.3；不改 payload）。 */
export interface WebEventEnvelope {
  streamVersion: 1
  cursor: string
  kind: 'core' | 'view' | 'control'
  sessionId?: string
  event: unknown
}

/** Web 权限请求卡（InteractivePermissionRequest 的授权面投影）。 */
export interface WebPermissionRequest {
  id: string
  attempt: number
  display: { approvable: boolean; spec: string; toolName: string }
}

export interface SessionHubPorts {
  readonly session: SessionControllerLike
}

export class SessionHub {
  private interactive: InteractiveSession<unknown> | undefined
  private cursor = 0
  private readonly subscribers = new Set<(envelope: WebEventEnvelope) => void>()
  private readonly pendingPermissions = new Map<
    string,
    (decision: InteractivePermissionDecision) => void
  >()

  constructor(private readonly ports: SessionHubPorts) {}

  get active(): { id: string; cwd?: string } | undefined {
    if (!this.interactive) return undefined
    return {
      id: this.interactive.id,
      ...(this.interactive.cwd ? { cwd: this.interactive.cwd } : {}),
    }
  }

  subscribe(fn: (envelope: WebEventEnvelope) => void): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  private emit(kind: WebEventEnvelope['kind'], event: unknown): void {
    this.cursor += 1
    const envelope: WebEventEnvelope = {
      streamVersion: 1,
      cursor: String(this.cursor),
      kind,
      ...(this.interactive ? { sessionId: this.interactive.id } : {}),
      event,
    }
    for (const subscriber of this.subscribers) subscriber(envelope)
  }

  /** 新建会话（单活动会话模型：先收掉原活动会话）。 */
  async start(input: { cwd: string }): Promise<{ id: string }> {
    await this.closeActive()
    const interactive = await this.ports.session.startInteractive!({ cwd: input.cwd })
    this.attach(interactive)
    return { id: interactive.id }
  }

  async resume(id: string): Promise<{ id: string }> {
    await this.closeActive()
    const interactive = await this.ports.session.resumeInteractive!(id)
    this.attach(interactive)
    return { id: interactive.id }
  }

  private attach(interactive: InteractiveSession<unknown>): void {
    this.interactive = interactive
    this.cursor = 0
    // CoreEvent 透传：envelope 只加外层，payload 原样（§22.8.3）。
    interactive.events.subscribe((event) => {
      this.emit('core', event)
    })
    // 权限审批：SSE 推卡 → decide 端点解析（镜像 TUI 的 PermissionPromptController 接线）。
    interactive.setPermissionPromptHandler?.((request) => {
      this.emit('view', {
        type: 'permission.request',
        request: { id: request.id, attempt: request.attempt, display: request.display },
      })
      return new Promise<InteractivePermissionDecision>((resolve) => {
        this.pendingPermissions.set(request.id, resolve)
      }).then((decision) => {
        this.emit('view', {
          type: 'permission.resolved',
          request: { id: request.id },
          decision: decision.kind,
        })
        return decision
      })
    })
    this.emit('view', { type: 'session.attached', id: interactive.id, cwd: interactive.cwd })
  }

  async closeActive(): Promise<void> {
    const interactive = this.interactive
    this.interactive = undefined
    for (const [id, resolve] of this.pendingPermissions) {
      resolve({ kind: 'deny' })
      this.pendingPermissions.delete(id)
    }
    if (!interactive) return
    interactive.setPermissionPromptHandler?.(undefined)
    await interactive.end()
  }

  /** 提交 turn：202 语义——立即返回，事件流承载结果；并发提交 409（controller mutex）。 */
  async submit(input: { prompt: string; model?: string }): Promise<'accepted'> {
    if (!this.interactive)
      throw Object.assign(new Error('no active session'), { code: 'web_session_invalid' })
    const promise = this.interactive.submit(
      input.prompt,
      input.model ? { model: input.model } : undefined,
    )
    void promise.catch((cause: unknown) => {
      this.emit('view', {
        type: 'turn.failed',
        message: cause instanceof Error ? cause.message : String(cause),
      })
    })
    return 'accepted'
  }

  async interrupt(): Promise<void> {
    await this.interactive?.interrupt?.()
  }

  /** 快照：持久化消息（流式 delta 不落盘，刷新后以此为准）。 */
  transcript(): { id?: string; cwd?: string; transcript: readonly unknown[] } {
    return {
      ...(this.interactive ? { id: this.interactive.id } : {}),
      ...(this.interactive?.cwd ? { cwd: this.interactive.cwd } : {}),
      transcript: this.interactive?.transcript ?? [],
    }
  }

  decide(requestId: string, kind: string): boolean {
    const resolve = this.pendingPermissions.get(requestId)
    if (!resolve) return false
    this.pendingPermissions.delete(requestId)
    resolve({ kind: kind as InteractivePermissionDecision['kind'] })
    return true
  }

  pendingPermissionIds(): string[] {
    return [...this.pendingPermissions.keys()]
  }
}
