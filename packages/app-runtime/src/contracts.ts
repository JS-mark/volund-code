/**
 * UI-neutral 会话/权限交互契约（§22.7.1 / Web 计划 P1-02）。
 *
 * 这些类型从 apps/cli/src/ports.ts 与 packages/ui 迁入：它们是 transport-neutral
 * DTO——TUI（Ink）与 Web（HTTP/SSE）共用同一份契约，本包不依赖任何渲染层。
 * `packages/ui` 与 `apps/cli/src/ports.ts` 以 re-export 保持既有引用兼容。
 */

export type InteractivePermissionDecisionKind =
  | 'allow-once'
  | 'allow-session'
  | 'allow-all-session'
  | 'allow-project'
  | 'allow-forever'
  | 'deny'
  | 'deny-forever'

export interface InteractivePermissionDecision {
  kind: InteractivePermissionDecisionKind
}

export interface InteractivePermissionRequest {
  display: {
    approvable: boolean
    spec: string
    toolName: string
  }
  id: string
  attempt: number
  input: unknown
  spec: unknown
  toolName: string
}

export type PermissionPromptListener = (requests: readonly InteractivePermissionRequest[]) => void

/**
 * 待决权限请求队列：TUI 渲染为审批卡片，Web 渲染为全局审批队列（§22 W-07）。
 * 决策按 request id 精确匹配；重复/过期 decision 静默忽略（调用方幂等）。
 */
export class PermissionPromptController {
  private readonly pending: PendingPermissionRequest[] = []
  private readonly listeners = new Set<PermissionPromptListener>()

  subscribe(listener: PermissionPromptListener): () => void {
    this.listeners.add(listener)
    listener(this.requests())
    return () => this.listeners.delete(listener)
  }

  request(request: InteractivePermissionRequest): Promise<InteractivePermissionDecision> {
    return new Promise((resolve) => {
      this.pending.push({ request, resolve })
      this.notify()
    })
  }

  decide(id: string, decision: InteractivePermissionDecision): void {
    const index = this.pending.findIndex((item) => item.request.id === id)
    if (index < 0) return
    const [pending] = this.pending.splice(index, 1)
    pending?.resolve(decision)
    this.notify()
  }

  requests(): readonly InteractivePermissionRequest[] {
    return this.pending.map((item) => item.request)
  }

  private notify(): void {
    const requests = this.requests()
    for (const listener of this.listeners) listener(requests)
  }
}

interface PendingPermissionRequest {
  request: InteractivePermissionRequest
  resolve(decision: InteractivePermissionDecision): void
}

export type PermissionInteractionMode = 'none' | 'line' | 'tui'

export interface SubmitOptions {
  model?: string
}

export interface SessionCandidate {
  id: string
  cwd: string
  updatedAt: string
  title: string
  summary?: string
}

export interface TranscriptEntry {
  id: string
  role: 'assistant' | 'system' | 'user'
  text: string
  /** B7（r13-G5）：该 assistant 消息因 max_tokens 截断，UI 渲染续写提示 */
  truncated?: boolean
}

/**
 * 一个进行中的会话句柄（SessionController 的返回值）。
 * `TStatusView` 由宿主装配决定：CLI 传 StatusViewModel；Web 在 P1-06 状态视图
 * 模型迁入前使用各自视图类型。
 */
export interface InteractiveSession<TStatusView = unknown> {
  id: string
  events: import('@volund/core').EventBus
  cwd?: string
  transcript?: readonly TranscriptEntry[]
  getStatus?(): Promise<TStatusView>
  /** Interrupts the in-flight turn (esc in the TUI). Optional: esc stays inert without it. */
  interrupt?(): Promise<void>
  setPermissionPromptHandler?(
    handler:
      | ((request: InteractivePermissionRequest) => Promise<InteractivePermissionDecision>)
      | undefined,
  ): void
  submit(input: string, options?: SubmitOptions): Promise<void>
  end(): Promise<void>
  exitCode(): number
}
