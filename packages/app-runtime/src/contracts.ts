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
  /** S1 batch 卡（§11.3.9）：仅 MCP 来源请求；语义见 permission 域 record()。 */
  | 'allow-mcp-server'
  | 'allow-batch-once'
  | 'deny-batch'

export interface InteractivePermissionDecision {
  kind: InteractivePermissionDecisionKind
  /**
   * 结构化拒绝原因（SessionHub.decide 透传）；语义同 PermissionDecision.reason
   * （timeout = 网关审批卡超时；fatigue = MCP server 弹窗限速）。
   */
  reason?: 'timeout' | 'fatigue'
}

/**
 * 审批归属血统（§2.7bis.5 U4）：发起权限请求的会话是子代理时携带，
 * 主代理（lineage.depth === 0）请求省略本字段——三端审批卡据此渲染
 * 「子代理 · <agentType>」徽标，主代理卡面无徽标。
 */
export interface PermissionRequestLineage {
  /** 发起请求的子代理会话 id（与请求经路的根会话 envelope.sessionId 不同）。 */
  sessionId: string
  agentType?: string
  parentTurnId?: string
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
  /** 子代理来源（§2.7bis.5 U4）；主代理请求省略。 */
  lineage?: PermissionRequestLineage
}

export type PermissionPromptListener = (requests: readonly InteractivePermissionRequest[]) => void

/** 审批/提问卡无人决策的默认超时：到点自动 deny/关闭（网关卡同钟语义下沉到核心队列）。 */
export const DEFAULT_PROMPT_TIMEOUT_MS = 120_000

export interface PromptControllerOptions {
  /**
   * 无人决策的自动兜底超时（毫秒）。默认 {@link DEFAULT_PROMPT_TIMEOUT_MS}；
   * 0 = 不兜底（卡挂到回合中断/进程退出为止）。
   */
  timeoutMs?: number
}

/**
 * 待决权限请求队列：TUI 渲染为审批卡片，Web 渲染为全局审批队列（§22 W-07）。
 * 决策按 request id 精确匹配；重复/过期 decision 静默忽略（调用方幂等）。
 * 无人决策的卡到点由队列自动 deny（reason=timeout）——走正常 decide 通道，
 * 订阅端照常收队列更新（全端清卡），权限链拿到带码拒绝（模型侧 permission_timeout）。
 */
export class PermissionPromptController {
  private readonly pending: PendingPermissionRequest[] = []
  private readonly listeners = new Set<PermissionPromptListener>()
  private timeoutMs: number

  constructor(options: PromptControllerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS
  }

  /** 运行时调整超时（启动期 config 异步装载后回填；只影响其后入队的卡）。 */
  configure(input: PromptControllerOptions): void {
    if (typeof input.timeoutMs === 'number') this.timeoutMs = input.timeoutMs
  }

  subscribe(listener: PermissionPromptListener): () => void {
    this.listeners.add(listener)
    listener(this.requests())
    return () => this.listeners.delete(listener)
  }

  request(
    request: InteractivePermissionRequest,
    signal?: AbortSignal,
  ): Promise<InteractivePermissionDecision> {
    return new Promise((resolve) => {
      const entry: PendingPermissionRequest = { request, resolve }
      // 回合中断 → 撤卡并立即 settle deny：否则中断被在途审批挂住（三端一直
      // 「运行中」，点中断像没反应）。订阅者随 notify 收到空队列，全端清卡。
      const settle = (decision: InteractivePermissionDecision): void => {
        const index = this.pending.indexOf(entry)
        if (index < 0) return
        this.pending.splice(index, 1)
        if (entry.timer) clearTimeout(entry.timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        resolve(decision)
        this.notify()
      }
      const onAbort = () => settle({ kind: 'deny' })
      if (signal?.aborted) {
        onAbort()
        return
      }
      if (signal) {
        entry.signal = signal
        entry.onAbort = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
      }
      if (this.timeoutMs > 0) {
        const timer = setTimeout(() => settle({ kind: 'deny', reason: 'timeout' }), this.timeoutMs)
        timer.unref?.()
        entry.timer = timer
      }
      this.pending.push(entry)
      this.notify()
    })
  }

  decide(id: string, decision: InteractivePermissionDecision): void {
    const index = this.pending.findIndex((item) => item.request.id === id)
    if (index < 0) return
    const [pending] = this.pending.splice(index, 1)
    if (pending?.timer) clearTimeout(pending.timer)
    if (pending?.signal && pending.onAbort)
      pending.signal.removeEventListener('abort', pending.onAbort)
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
  /** 无人决策自动 deny 的兜底钟（decide/abort 落定时拆除）。 */
  timer?: ReturnType<typeof setTimeout>
  /** 回合中断撤卡监听（decide 正常落定时拆除）。 */
  signal?: AbortSignal
  onAbort?: () => void
}

/** 提问卡的一个候选项（AskUserQuestion 工具的 options 投影）。 */
export interface InteractiveAskOption {
  label: string
  description?: string
}

/**
 * 待决提问（AskUserQuestion 工具发起）：与权限卡同款跨端语义——TUI 渲染为
 * 选项卡，Web/Mobile 渲染为问答卡；answer 按 request id 精确匹配。
 */
export interface InteractiveAskRequest {
  id: string
  question: string
  options: readonly InteractiveAskOption[]
}

export type AskPromptListener = (requests: readonly InteractiveAskRequest[]) => void

/**
 * 待决提问队列（§22 W-07 同款多路分发）：TUI/Web/Mobile 都订阅它——任一端
 * 作答全端清卡。decide 的 value 为 undefined = 用户关闭/未作答；重复/过期
 * answer 静默忽略（调用方幂等）。无人作答的卡到点自动关闭（reason=timeout，
 * 与权限卡同钟；消费侧经 consumeTimedOut 给出 ask_timeout 带码文案）。
 */
export class AskPromptController {
  private readonly pending: PendingAskRequest[] = []
  private readonly listeners = new Set<AskPromptListener>()
  /** 网关超时自动关闭的提问 id：交互层在 await request() 后消费，模型侧据此给出 ask_timeout。 */
  private readonly timedOut = new Set<string>()
  private timeoutMs: number

  constructor(options: PromptControllerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS
  }

  /** 运行时调整超时（启动期 config 异步装载后回填；只影响其后入队的卡）。 */
  configure(input: PromptControllerOptions): void {
    if (typeof input.timeoutMs === 'number') this.timeoutMs = input.timeoutMs
  }

  subscribe(listener: AskPromptListener): () => void {
    this.listeners.add(listener)
    listener(this.requests())
    return () => this.listeners.delete(listener)
  }

  request(request: InteractiveAskRequest, signal?: AbortSignal): Promise<string | undefined> {
    return new Promise((resolve) => {
      const entry: PendingAskRequest = { request, resolve }
      // 同权限卡：回合中断撤卡并 settle undefined（=未作答），工具立即返回、
      // 回合以 user_interrupt 收尾；订阅者收到空队列，全端清卡。
      const settle = (value: string | undefined, reason?: 'timeout'): void => {
        const index = this.pending.indexOf(entry)
        if (index < 0) return
        this.pending.splice(index, 1)
        if (reason === 'timeout' && value === undefined) this.timedOut.add(entry.request.id)
        if (entry.timer) clearTimeout(entry.timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        resolve(value)
        this.notify()
      }
      const onAbort = () => settle(undefined)
      if (signal?.aborted) {
        onAbort()
        return
      }
      if (signal) {
        entry.signal = signal
        entry.onAbort = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
      }
      if (this.timeoutMs > 0) {
        const timer = setTimeout(() => settle(undefined, 'timeout'), this.timeoutMs)
        timer.unref?.()
        entry.timer = timer
      }
      this.pending.push(entry)
      this.notify()
    })
  }

  decide(id: string, value: string | undefined, reason?: 'timeout'): void {
    const index = this.pending.findIndex((item) => item.request.id === id)
    if (index < 0) return
    const [pending] = this.pending.splice(index, 1)
    if (pending?.timer) clearTimeout(pending.timer)
    if (pending?.signal && pending.onAbort)
      pending.signal.removeEventListener('abort', pending.onAbort)
    if (reason === 'timeout' && value === undefined) this.timedOut.add(id)
    pending?.resolve(value)
    this.notify()
  }

  /** 该次关闭是否网关超时（消费即清除；与 decide 的 reason 标记配对）。 */
  consumeTimedOut(id: string): boolean {
    return this.timedOut.delete(id)
  }

  requests(): readonly InteractiveAskRequest[] {
    return this.pending.map((item) => item.request)
  }

  private notify(): void {
    const requests = this.requests()
    for (const listener of this.listeners) listener(requests)
  }
}

interface PendingAskRequest {
  request: InteractiveAskRequest
  resolve(value: string | undefined): void
  /** 无人作答自动关闭的兜底钟（decide/abort 落定时拆除）。 */
  timer?: ReturnType<typeof setTimeout>
  /** 回合中断撤卡监听（decide 正常落定时拆除）。 */
  signal?: AbortSignal
  onAbort?: () => void
}

export type PermissionInteractionMode = 'none' | 'line' | 'tui'

export interface SubmitOptions {
  /** §7.5.2：输入行 chip 对应的已暂存附件；提交时展开成 image/file ContentPart。 */
  attachments?: readonly import('@volund/shared').SubmitAttachment[]
  model?: string
}

export interface SessionCandidate {
  id: string
  cwd: string
  updatedAt: string
  title: string
  summary?: string
}

/** transcript 条目携带的图片引用（chip = text 里的占位 token；handle = AttachmentStore 引用）。 */
export interface TranscriptAttachment {
  chip: string
  kind: 'image'
  mime: string
  /** 内容寻址落盘引用；path 引用的图片无 handle（字节不可回放）。 */
  handle?: string
}

export interface TranscriptEntry {
  id: string
  role: 'assistant' | 'system' | 'user'
  text: string
  /** B7（r13-G5）：该 assistant 消息因 max_tokens 截断，UI 渲染续写提示 */
  truncated?: boolean
  /** 消息里的图片附件（远程/移动客户端经 readAttachment 通路取字节回显）。 */
  attachments?: readonly TranscriptAttachment[]
}

/**
 * transcript 里的工具调用条目（快照重建折叠卡用）：来自 assistant 消息的
 * tool_use part，input 原样携带（web/mobile 展开卡正文的数据面）。终态由配对的
 * tool_result 定（isError → error）；没有 tool_result（中断/崩溃残留）保持 running。
 */
export interface TranscriptToolEntry {
  id: string
  kind: 'tool'
  tool: string
  input?: unknown
  status: 'running' | 'done' | 'error'
}

export type TranscriptItem = TranscriptEntry | TranscriptToolEntry

export function isTranscriptToolEntry(item: TranscriptItem): item is TranscriptToolEntry {
  return (item as { kind?: unknown }).kind === 'tool'
}

/**
 * §21 动态反思的会话门面（v1 core 实现）：TUI `/reflect` 命令族经它操作控制器，
 * 远端（web/gateway）后续同接口接入。宿主装配注入；headless 会话可省略。
 */
export interface ReflectionLessonView {
  id: string
  title: string
  confidence: 'low' | 'medium' | 'high'
  createdAt: number
  promoted?: { memoryId: string; scope: 'global' | 'project' }
}

export interface SessionReflectionPort {
  runNow(): Promise<{ ok: boolean; lessonCount?: number; reason?: string }>
  setEnabled(enabled: boolean): void
  list(): readonly ReflectionLessonView[]
  show(id: string):
    | {
        title: string
        body: string
        tags: readonly string[]
        confidence: 'low' | 'medium' | 'high'
        evidenceTurnIds: readonly string[]
        createdAt: number
      }
    | undefined
  save(
    id: string,
    scope: 'global' | 'project',
  ): Promise<{ ok: boolean; memoryId?: string; reason?: string }>
  remove(id: string): boolean
  clear(): void
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
  /**
   * 会话级钉住模型（/model 选择的 provider/model 显式 id，随 session.model_changed
   * 落盘；resume 时 replay 回填）。缺省 = 未钉住，turn 跟随全局配置解析。
   */
  model?: string
  transcript?: readonly TranscriptItem[]
  getStatus?(): Promise<TStatusView>
  /** Interrupts the in-flight turn (esc in the TUI). Optional: esc stays inert without it. */
  interrupt?(): Promise<void>
  setPermissionPromptHandler?(
    handler:
      | ((
          request: InteractivePermissionRequest,
          signal?: AbortSignal,
        ) => Promise<InteractivePermissionDecision>)
      | undefined,
  ): void
  /**
   * §7.5.2 Ctrl+V：读系统剪贴板 → 首次弹会话级授权 → 图片经 AttachmentStore
   * 落盘返回 handle chip，文件返回 path 引用 chip；纯文本剪贴板原样返回文本。
   * 可选：headless / 非交互会话不实现，UI 隐藏该手势。
   */
  pasteClipboardAttachment?(): Promise<import('@volund/shared').PasteAttachmentResult>
  /**
   * §7.5.2 粘贴/拖拽的文件路径（bracketed paste 进来的文本解析为文件）：
   * cwd 内返回 path 引用 chip；cwd 外的图片读字节落盘成 blob chip。
   * 不可附加（不存在/目录/超限制）时返回非 'attached'，UI 回退为插入原文本。
   */
  attachFilePath?(path: string): Promise<import('@volund/shared').PasteAttachmentResult>
  /** §7.5.3 @ picker 的文件候选：会话 cwd 的相对路径快照（限量排序）。 */
  listFiles?(): Promise<readonly string[]>
  /**
   * §22 W-05 Web 上传暂存：浏览器读出的图片字节 → AttachmentStore 内容寻址
   * 落盘返回 handle chip 信息（与 pasteClipboardAttachment 的 image 分支同管线；
   * 字节永不进事件流/日志）。可选：headless / 非交互会话不实现。
   */
  stageAttachment?(
    bytes: Uint8Array,
    mime: string,
  ): Promise<import('@volund/shared').PasteAttachmentResult>
  /**
   * 附件字节回放（移动站 transcript 图片回显）：内容寻址 handle → 字节+mime；
   * 会话不在场/handle 不存在时回 undefined（调用方按 404 处理）。
   */
  readAttachment?(handle: string): Promise<{ mime: string; bytes: Uint8Array } | undefined>
  /** §21 /reflect 命令族的操作面（宿主未装配反思时缺省，UI 隐藏命令）。 */
  reflection?: SessionReflectionPort
  submit(input: string, options?: SubmitOptions): Promise<void>
  /**
   * 等待在途 turn 落锁（turn 终态事件先于互斥释放出站——客户端收到终态立即
   * 提交会撞 session_turn_in_progress；排队补发先 here 等锁再 submit）。
   * 可选：旧宿主 facade 未实现时调用方按「直接提交」回退。
   */
  whenTurnSettled?(): Promise<void>
  end(): Promise<void>
  exitCode(): number
}

export interface SlashSubmitView {
  kind: 'submit'
  text: string
}

export function isSlashSubmitView(value: unknown): value is SlashSubmitView {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as { kind?: unknown }).kind === 'submit' &&
    typeof (value as { text?: unknown }).text === 'string' &&
    (value as { text: string }).text !== '',
  )
}

/**
 * 斜杠命令注册表的最小结构面：MutableSlashCommandRegistry（@volund/ui）结构上
 * 满足它——app-runtime 不反向依赖渲染层，组装侧在边界做一次结构校验即可。
 */
export interface SlashCommandLike {
  name: string
  description: string
  aliases?: readonly string[]
  order?: number
  run(input: { args: readonly string[] }): unknown
}

export interface SlashCommandRegistryLike {
  register(command: SlashCommandLike, source: { kind: string; plugin?: string }): () => void
}
