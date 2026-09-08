/**
 * SessionHub（§22.8.3 / Web 计划 P3-01/02/06 + W-01 嵌入式）：把 SessionController
 * 的会话暴露为 Web 的权威状态源——CoreEvent 透传（WebEventEnvelope + 单调 cursor）、
 * 权限审批队列（共享 PermissionPromptController → SSE 推卡 → decide 解析）、
 * turn 提交的串行化。
 *
 * 两种模式：
 * - standalone（`volund web` 独立进程）：hub 自建/恢复会话（start/resume），
 *   关闭即结束会话（owned）。
 * - embedded（随 TUI 静默启动）：挂载 controller 的当前活动会话（attachActive），
 *   TUI 内 resume/新建经 onActivate 自动重挂；start/resume/end 拒绝
 *   （web_state_conflict）——单 runner 模型下 web 不得顶替 TUI 的会话。
 *
 * 诚实边界：cursor 是内存态单调计数，重连经 GET transcript 快照 + 新 cursor 续传。
 */
import type {
  InteractivePermissionDecision,
  InteractiveSession,
  PermissionPromptController,
} from '@volund/app-runtime'
import type { StagedAttachmentInfo, SubmitAttachment } from '@volund/shared'

/** SessionController 的最小结构面（@volund/app-runtime 的 SessionController 结构满足）。 */
export interface SessionControllerLike {
  startInteractive?(input: { cwd: string }): Promise<InteractiveSession<unknown>>
  resumeInteractive?(id: string): Promise<InteractiveSession<unknown>>
  /** 嵌入式：当前活动会话 facade（无则 undefined）。 */
  getActive?(): InteractiveSession<unknown> | undefined
  /** 嵌入式：会话激活订阅（TUI resume/新建后重挂）。 */
  onActivate?(listener: (session: InteractiveSession<unknown>) => void): () => void
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
  /**
   * 进程级共享审批队列（§22 W-07 多路分发）：TUI 与 Web 都是它的订阅者——
   * 任一端决策，全端清卡。装配侧（runtime）同时把它接进权限链的 prompt 源。
   */
  readonly permissions: PermissionPromptController
}

export interface SessionHubOptions {
  /** 嵌入式（随 TUI 启动）：只挂载既有会话，禁止 web 侧 start/resume/end。 */
  readonly embedded?: boolean
}

export class SessionHub {
  private interactive: InteractiveSession<unknown> | undefined
  /** 当前挂载是否归 hub 所有（standalone 自建=true；embedded 挂载=false）。 */
  private owned = false
  private cursor = 0
  private readonly subscribers = new Set<(envelope: WebEventEnvelope) => void>()
  private unsubscribeSession: (() => void) | undefined
  private unsubscribeActivate: (() => void) | undefined
  private lastPermissionId: string | undefined

  constructor(
    private readonly ports: SessionHubPorts,
    private readonly options: SessionHubOptions = {},
  ) {
    // 审批队列 → SSE 推卡：队列非空发首张卡，清空发 resolved（TUI 端决策也清 Web 卡）。
    this.ports.permissions.subscribe((requests) => {
      const first = requests[0]
      if (first) {
        if (first.id === this.lastPermissionId) return
        this.lastPermissionId = first.id
        this.emit('view', {
          type: 'permission.request',
          request: { id: first.id, attempt: first.attempt, display: first.display },
        })
      } else if (this.lastPermissionId !== undefined) {
        this.lastPermissionId = undefined
        this.emit('view', { type: 'permission.resolved' })
      }
    })
  }

  get active(): { id: string; cwd?: string } | undefined {
    if (!this.interactive) return undefined
    return {
      id: this.interactive.id,
      ...(this.interactive.cwd ? { cwd: this.interactive.cwd } : {}),
    }
  }

  get embedded(): boolean {
    return this.options.embedded === true
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

  /**
   * 新建会话。standalone：先收掉原活动会话（owned 结束）；embedded：detach 后
   * 经 controller 激活——onActivate 让 TUI 跟随切换，hub 不拥有会话（owned=false）。
   */
  async start(input: { cwd: string }): Promise<{ id: string }> {
    await this.closeActive()
    const interactive = await this.ports.session.startInteractive!({ cwd: input.cwd })
    this.attach(interactive, !this.embedded)
    return { id: interactive.id }
  }

  async resume(id: string): Promise<{ id: string }> {
    await this.closeActive()
    const interactive = await this.ports.session.resumeInteractive!(id)
    this.attach(interactive, !this.embedded)
    return { id: interactive.id }
  }

  /**
   * 嵌入式挂载：接管 controller 当前活动会话（不 end、不拥有），并订阅后续
   * 激活（TUI 内 resume/新建会换新 facade——这里自动重挂）。
   */
  attachActive(): void {
    if (!this.embedded)
      throw Object.assign(new Error('attachActive is only valid in embedded mode'), {
        code: 'web_state_conflict',
      })
    const attach = (session: InteractiveSession<unknown>) => {
      this.detach()
      this.attach(session, false)
    }
    const active = this.ports.session.getActive?.()
    if (active) attach(active)
    this.unsubscribeActivate = this.ports.session.onActivate?.(attach)
  }

  /** 嵌入式：会话生命周期（end）仍属 TUI；detach 语义保留在 closeActive。 */

  private attach(interactive: InteractiveSession<unknown>, owned: boolean): void {
    this.interactive = interactive
    this.owned = owned
    this.cursor = 0
    // CoreEvent 透传：envelope 只加外层，payload 原样（§22.8.3）。
    this.unsubscribeSession = interactive.events.subscribe((event) => {
      this.emit('core', event)
    })
    this.emit('view', { type: 'session.attached', id: interactive.id, cwd: interactive.cwd })
  }

  /** 只摘挂载不结束会话（embedded 重挂/摘挂路径）。 */
  private detach(): void {
    this.unsubscribeSession?.()
    this.unsubscribeSession = undefined
    this.interactive = undefined
    this.owned = false
  }

  async closeActive(): Promise<void> {
    const interactive = this.interactive
    const owned = this.owned
    this.detach()
    if (!interactive) return
    // embedded 挂载不拥有会话：detach 即止（TUI 的会话由 TUI 收尾）。
    if (!owned) return
    await interactive.end()
  }

  /** 嵌入式卸载：退激活订阅 + 摘挂（进程收尾用）。 */
  dispose(): void {
    this.unsubscribeActivate?.()
    this.unsubscribeActivate = undefined
    this.detach()
  }

  /** 提交 turn：202 语义——立即返回，事件流承载结果；并发提交 409（controller mutex）。 */
  async submit(input: {
    prompt: string
    model?: string
    attachments?: readonly SubmitAttachment[]
  }): Promise<'accepted'> {
    if (!this.interactive)
      throw Object.assign(new Error('no active session'), { code: 'web_session_invalid' })
    const promise = this.interactive.submit(input.prompt, {
      ...(input.model ? { model: input.model } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    })
    void promise.catch((cause: unknown) => {
      this.emit('view', {
        type: 'turn.failed',
        message: cause instanceof Error ? cause.message : String(cause),
      })
    })
    return 'accepted'
  }

  /**
   * §22 W-05 附件暂存：浏览器上传的图片字节经会话的 AttachmentStore 管线落盘
   * （内容寻址 handle；字节不进事件流/日志）。无会话或宿主不支持 → 明确错误。
   */
  async stageAttachment(bytes: Uint8Array, mime: string): Promise<StagedAttachmentInfo> {
    const interactive = this.interactive
    if (!interactive)
      throw Object.assign(new Error('no active session'), { code: 'web_session_invalid' })
    if (!interactive.stageAttachment)
      throw Object.assign(new Error('attachment staging is not wired'), {
        code: 'web_capability_unavailable',
      })
    const result = await interactive.stageAttachment(bytes, mime)
    if (result.kind !== 'attached')
      throw Object.assign(
        new Error(
          result.kind === 'unavailable' ? result.reason : `attachment rejected: ${result.kind}`,
        ),
        { code: 'web_attachment_rejected' },
      )
    return result.attachment
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

  /** 决策落到共享审批队列（TUI/Web 同队列；重复/过期 decision 幂等忽略）。 */
  decide(requestId: string, kind: string): boolean {
    const pending = this.ports.permissions.requests().some((request) => request.id === requestId)
    if (!pending) return false
    this.ports.permissions.decide(requestId, {
      kind: kind as InteractivePermissionDecision['kind'],
    })
    return true
  }

  pendingPermissionIds(): string[] {
    return this.ports.permissions.requests().map((request) => request.id)
  }
}
