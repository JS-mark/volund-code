/**
 * SessionController — §22.7.1 的会话控制器（Web 计划 P1-03）。
 *
 * 从 apps/cli/src/runtime.ts 的 RuntimeSessionPort 迁入，行为保持等价，差异仅在：
 * - 落成应用级内核的 Cordis service（`app.sessions`；TS `private` 取代 # 字段——
 *   cordis 以代理转发服务访问，# 字段会品牌检查失败，见 kernel/UiService 注释）；
 * - `start` 改名 `startSession`：Cordis `Service` 保留了 protected `start()/stop()`
 *   生命周期钩子，公共会话入口同名会被类型系统拒绝（SessionPort 同步改名）；
 * - 构造从位置参数改为 options 对象；
 * - 终端接缝（TTY 探测 / 行输入）经 options.terminal 显式注入，Web adapter 不提供；
 * - 新增 turn mutex：同一会话已有 in-flight turn 时 submit 抛
 *   `session_turn_in_progress`（Web 层映射为 409 `web_turn_in_progress`，§22 W-03）。
 *   Runner.run 自身无并发守卫，此前由 TUI 的串行输入隐式保证。
 */
import { glob, readFile, realpath, rm, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

import { Service } from '@cordisjs/core'
import type { Context } from '@cordisjs/core'
import {
  createSession,
  EventBus,
  isBubbledEvent,
  MachineEventFormatter,
  replaySessionState,
  updateSession,
} from '@volund/core'
import type { Runner, SessionState } from '@volund/core'
import type { ClipboardReader, ClipboardPayload } from '@volund/native-bridge'
import { VolundError, contentPartChipLabel, type Locale } from '@volund/shared'
import { AttachmentStore } from '@volund/storage'
import { SessionStore } from '@volund/storage'
import type { ResolvedAgentDefinition } from '@volund/subagent'
import type { BackgroundShells } from '@volund/tools'
import { v7 as uuidv7 } from 'uuid'

import type {
  InteractivePermissionDecision,
  InteractivePermissionRequest,
  InteractiveSession,
  PermissionInteractionMode,
  SessionCandidate,
  SubmitOptions,
  TranscriptAttachment,
  TranscriptEntry,
  TranscriptItem,
  TranscriptToolEntry,
} from './contracts'
import {
  composeAttachmentInput,
  listWorkspaceFiles,
  mimeForAttachmentPath,
} from './session-attachments'

/** 与 @volund/subagent 的 RunnerFactory 同形；agent 为 §2.7.1 解析出的自定义定义。 */
/** W-17 F1-02：随会话启动注入的运行约束（budget 走 RunnerOptions，白名单在工具执行器收口）。 */
export interface SessionRunOverrides {
  budget?: { costUSDMax?: number; tokenMax?: number; timeMsMax?: number }
  allowedTools?: readonly string[]
  /** W-17：daemon 触发的任务运行元数据（在场时 Runner 发射 task.* 生命周期事件）。 */
  taskRun?: { taskId: string; runId: string; scheduledFor: number }
}

export type RunnerFactory = (
  state: SessionState,
  events: EventBus,
  agent?: ResolvedAgentDefinition,
  overrides?: SessionRunOverrides,
) => Runner | Promise<Runner>

/** 会话 id 的唯一合法形状（uuidv7）：拼 sessions 目录文件名前的守门。 */
export const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const terminalStatuses = new Set(['done', 'aborted', 'error'])

/** 终端能力接缝：CLI 传真实 TTY 实现；Web adapter 省略（`start` 无 prompt 时拒绝）。 */
export interface SessionTerminalHost {
  isInteractive(): boolean
  promptLine(question: string): Promise<string | undefined>
}

export interface SessionControllerOptions<TStatusView = unknown> {
  readonly sessionsDir: string
  /** [ui].locale 探针（i18n-r1）：会话列表「未命名会话」等服务端用户可见文案的取值面；缺省按 zh。 */
  readonly uiLocale?: (() => Locale | undefined) | undefined
  readonly createRunner: RunnerFactory
  readonly onSecurity?: ((input: { skipPermissions: boolean }) => void) | undefined
  readonly onPermissionInteraction?:
    | ((input: { mode: PermissionInteractionMode }) => void)
    | undefined
  readonly onEnd?: ((sessionId: string) => void | Promise<void>) | undefined
  /** 删除会话档案后的宿主清理钩子（BackupStore.purgeSession 随装配注入）。 */
  readonly onDelete?: ((sessionId: string) => void | Promise<void>) | undefined
  readonly onTerminalOutput?: ((input: { streamToStdout: boolean }) => void) | undefined
  readonly onPermissionPromptHandler?:
    | ((
        handler:
          | ((
              request: InteractivePermissionRequest,
              signal?: AbortSignal,
            ) => Promise<InteractivePermissionDecision>)
          | undefined,
      ) => void)
    | undefined
  readonly statusSnapshot?: ((state: SessionState) => Promise<TStatusView>) | undefined
  /** r13-G2：后台 shell 注册表；end() 时统一 killAll。 */
  readonly background?: BackgroundShells | undefined
  readonly terminal?: SessionTerminalHost | undefined
  /** §7.5.2 剪贴板读取器（缺省用平台实现；测试注入捕获）。 */
  readonly clipboard?: ClipboardReader | undefined
}

export class SessionController<TStatusView = unknown> extends Service {
  private runner: Runner | undefined
  private events: EventBus | undefined
  /** 会话级钉住模型（/model 选择的 provider/model id）；activate 时从 replay 的 state 回填。 */
  private sessionModel: string | undefined
  private startOverrides: SessionRunOverrides | undefined
  private readonly backgroundShells: BackgroundShells | undefined
  private output?: { json: boolean; write: (value: string) => void }
  private lastExitCode = 0
  /** turn mutex：in-flight turn 的 promise；存在即拒绝新 submit（§22 W-03）。 */
  private turnFlight: Promise<unknown> | undefined
  /** §22 W-01 嵌入式 Web：会话激活订阅（start/resumeInteractive 完成后触发）。 */
  private readonly activateListeners = new Set<(session: InteractiveSession<TStatusView>) => void>()

  constructor(
    ctx: Context,
    private readonly options: SessionControllerOptions<TStatusView>,
  ) {
    super(ctx, 'sessions', true)
    this.backgroundShells = options.background
  }

  /** 当前活动会话的 facade（嵌入式 Web hub 挂载用）；无 runner 时 undefined。 */
  getActive(): InteractiveSession<TStatusView> | undefined {
    return this.runner ? this.interactiveSession() : undefined
  }

  /** 会话激活订阅：TUI 内 resume/新建后 Web hub 重新挂载到新 facade。 */
  onActivate(listener: (session: InteractiveSession<TStatusView>) => void): () => void {
    this.activateListeners.add(listener)
    return () => {
      this.activateListeners.delete(listener)
    }
  }

  configureSecurity(input: { skipPermissions: boolean }): void {
    this.options.onSecurity?.(input)
  }
  configurePermissionInteraction(input: { mode: PermissionInteractionMode }): void {
    this.options.onPermissionInteraction?.(input)
  }
  configureOutput(input: { json: boolean; write: (value: string) => void }): void {
    this.output = input
  }
  configureTerminalOutput(input: { streamToStdout: boolean }): void {
    this.options.onTerminalOutput?.(input)
  }
  /** 是否有 turn 在途（Web 审批/状态条的投影数据源）。 */
  get turnInFlight(): boolean {
    return this.turnFlight !== undefined
  }

  /**
   * 等待在途 turn 落锁（含等待期间新启的 turn）；无在途时立即返回。turn 的终态
   * 事件（turn.completed/aborted）在 run() 内部 emit——事件总线同步转发给 SSE 订阅者，
   * 而互斥锁要等全部订阅者（含 SessionStore 落盘）await 完、run() 返回后才在
   * finally 释放。客户端收到终态立即补发的提交（发送队列补发/多端并发）会打进
   * 这扇窗口撞 session_turn_in_progress；hub submit 侧先 here 等锁再提交即闭合。
   */
  async whenTurnSettled(): Promise<void> {
    while (this.turnFlight) await this.turnFlight.catch(() => {})
  }

  async startSession(input: {
    cwd: string
    prompt?: string
  }): Promise<{ id: string; exitCode?: number }> {
    const session = await this.startInteractive({ cwd: input.cwd })
    if (input.prompt !== undefined) {
      await this.runTurnExclusive(input.prompt)
    } else {
      if (!this.options.terminal?.isInteractive())
        throw new VolundError('session_tty_required', 'Interactive chat requires a TTY or a prompt')
      for (;;) {
        const prompt = await this.options.terminal.promptLine('> ')
        if (prompt === undefined) break
        const trimmed = prompt.trim()
        if (!trimmed) continue
        if (trimmed === 'exit' || trimmed === 'quit') break
        await this.runTurnExclusive(trimmed)
      }
      await session.end()
    }
    return { id: session.id, exitCode: session.exitCode() }
  }

  async startInteractive(input: {
    cwd: string
    /** W-17 F1-02：任务约束随会话启动注入（--model / --budget / --allowed-tools）。 */
    model?: string
    budget?: { costUSDMax?: number; tokenMax?: number; timeMsMax?: number }
    allowedTools?: readonly string[]
    taskRun?: { taskId: string; runId: string; scheduledFor: number }
  }): Promise<InteractiveSession<TStatusView>> {
    const id = uuidv7()
    // overrides 须在 activate（createRunner）之前就位。
    if (input.budget || input.allowedTools || input.taskRun) {
      this.startOverrides = {
        ...(input.budget ? { budget: input.budget } : {}),
        ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
        ...(input.taskRun ? { taskRun: input.taskRun } : {}),
      }
    }
    await this.activate(
      createSession({ id, cwd: input.cwd, maxTokens: 200_000, toolRegistrySnapshot: 'builtin:l1' }),
    )
    // 钉住模型（session.model_changed 落盘，resume 由 replay 还原）。
    if (input.model) await this.setModel(input.model)
    return this.publishActive()
  }

  async resumeInteractive(id: string): Promise<InteractiveSession<TStatusView>> {
    await this.resume(id)
    return this.publishActive()
  }

  /** 建 facade + 通知激活订阅者（嵌入式 Web hub 随之重挂）。 */
  private publishActive(): InteractiveSession<TStatusView> {
    const session = this.interactiveSession()
    for (const listener of this.activateListeners) listener(session)
    return session
  }

  private interactiveSession(): InteractiveSession<TStatusView> {
    // transcript 必须是 getter：runner 消息随 turn 增长，对象创建期的快照会让
    // Web 端 hydrate 拿到过期（通常为空）的历史。
    const readTranscript = (): TranscriptItem[] => {
      const messages = this.runner?.state.messages ?? []
      // tool_use 的终态由后续 user 消息里配对的 tool_result 定（isError → error）；
      // 没有配对（中断/崩溃残留）的归属看回合：只有活跃回合起点之后的才算在途
      // （running）。回合已终结（含 resume 换 runner 后 activeTurn=null 的孤儿回合）
      // 的未配对 tool_use 是死调用，按 error 收口——否则 transcript 会把它们永远
      // 显示成「运行中」（刷新/resume 多少年都在转）。
      const toolStatus = new Map<string, 'done' | 'error'>()
      for (const message of messages)
        for (const part of message.content)
          if (part.type === 'tool_result')
            toolStatus.set(part.toolUseId, part.isError ? 'error' : 'done')
      const activeTurn = this.runner?.state.turns.find(
        (turn) => turn.id === this.runner?.state.activeTurn,
      )
      // 活跃回合的起点锚（run() 创建回合时落的 startMessageId）。锚缺失或起点消息
      // 已不在（上下文裁剪等异常面）按「无在途」收口——投影宁可误报终态，不报
      // 永恒 running。
      const anchorId = activeTurn?.startMessageId
      const liveBoundary =
        anchorId === undefined || anchorId === ''
          ? Number.MAX_SAFE_INTEGER
          : (() => {
              const index = messages.findIndex((message) => message.id === anchorId)
              return index < 0 ? Number.MAX_SAFE_INTEGER : index
            })()
      return messages.flatMap((message, messageIndex) => {
        if (message.role !== 'assistant' && message.role !== 'system' && message.role !== 'user')
          return []
        const text = messageFullText(message.content)
        const textEntries: TranscriptItem[] = text
          ? (() => {
              const attachments = transcriptAttachments(message.content)
              const entry: TranscriptEntry = {
                id: message.id,
                role: message.role,
                text,
                ...(attachments.length ? { attachments } : {}),
              }
              return [entry]
            })()
          : []
        // 只有 assistant 消息携带 tool_use（provider-kit ContentPart）。
        const toolEntries: TranscriptItem[] =
          message.role === 'assistant'
            ? message.content
                .filter(
                  (part): part is Extract<typeof part, { type: 'tool_use' }> =>
                    part.type === 'tool_use',
                )
                .map(
                  (part): TranscriptToolEntry => ({
                    id: part.id,
                    kind: 'tool',
                    tool: part.name,
                    ...(part.input !== undefined && part.input !== null
                      ? { input: part.input }
                      : {}),
                    status:
                      toolStatus.get(part.id) ??
                      (messageIndex >= liveBoundary ? 'running' : 'error'),
                  }),
                )
            : []
        return [...textEntries, ...toolEntries]
      })
    }
    return {
      id: this.runner!.state.id,
      cwd: this.runner!.state.cwd,
      events: this.events!,
      // 会话级钉住模型（/model 选择；resume 经 replay 回填）——TUI picker 回填与
      // resume 换绑的展示源；缺省 = 跟随全局配置。
      ...(this.sessionModel ? { model: this.sessionModel } : {}),
      get transcript() {
        return readTranscript()
      },
      ...(this.options.statusSnapshot
        ? { getStatus: () => this.options.statusSnapshot!(this.runner!.state) }
        : {}),
      setPermissionPromptHandler: (
        handler:
          | ((
              request: InteractivePermissionRequest,
              signal?: AbortSignal,
            ) => Promise<InteractivePermissionDecision>)
          | undefined,
      ) => {
        this.options.onPermissionPromptHandler?.(handler)
      },
      interrupt: async () => {
        this.runner?.interrupt()
      },
      // §7.5.2 Ctrl+V：读系统剪贴板 → 图片经 AttachmentStore 内容寻址落盘，
      // 文件走 path 引用（读取权限由 store 的 allowedPathRoots=cwd 把守）。
      pasteClipboardAttachment: () => this.pasteClipboardAttachment(),
      // §7.5.2 粘贴/拖拽的文件路径（bracketed paste 文本解析而来）。
      attachFilePath: (path: string) => this.attachFilePath(path),
      // §7.5.3 @ picker 的文件候选：会话 cwd 的相对路径快照（限深限量）。
      listFiles: () => listWorkspaceFiles(this.runner!.state.cwd),
      // §22 W-05 Web 上传暂存：浏览器图片字节走与粘贴相同的落盘管线。
      stageAttachment: (bytes: Uint8Array, mime: string) => this.stageImageBytes(bytes, mime),
      // 附件字节回放（移动站 transcript 图片回显）：与暂存同一个 AttachmentStore 根，
      // handle 形状由 store 把守；读不到（已清理/伪造）按 undefined → 404。
      readAttachment: async (handle: string) => {
        const runner = this.runner
        if (!runner) return undefined
        const store = new AttachmentStore(
          join(this.options.sessionsDir, runner.state.id, 'attachments'),
        )
        try {
          const bytes = await store.read({ kind: 'handle', handle })
          return { mime: mimeForAttachmentPath(handle), bytes }
        } catch {
          return undefined
        }
      },
      submit: (prompt: string, submitOptions?: SubmitOptions) =>
        this.runTurnExclusive(prompt, submitOptions),
      whenTurnSettled: () => this.whenTurnSettled(),
      end: async () => {
        await this.end()
      },
      exitCode: () => {
        const last = this.runner?.state.turns.at(-1)
        if (!this.runner) return this.lastExitCode
        return last?.status === 'aborted' ? this.lastExitCode : 0
      },
    }
  }

  async resume(id: string): Promise<{ id: string }> {
    if (!SESSION_ID_PATTERN.test(id))
      throw new VolundError('session_id_invalid', 'Invalid session id')
    const store = new SessionStore(this.path(id))
    // §8.2 D1-1（REM-74）：resume 一律走事件 replay（附录 D 形状；legacy session.snapshot
    // 行作为旧数据的基线兜底），禁止再写全量快照。
    const all = await store.load()
    // 尾窗按「父会话真实 turn」计：子代理冒泡的 turn.started 在父 JSONL 里有副本
    // （附录 D.3 tag），不计入窗口——否则一段长子代理工作就能把父会话历史挤出
    // 尾窗（窗口之前的父消息被整体丢弃，resume 后模型失去自己的近期上下文）。
    const turnStarts: number[] = []
    for (const [index, entry] of all.entries())
      if (entry.type === 'turn.started' && !isBubbledEvent(entry)) turnStarts.push(index)
    const tailTurns = 20
    const from = turnStarts.filter((index) => index >= 0).at(-tailTurns) ?? 0
    // 会话级模型事件（/model 钉住）不受尾部窗口限制：窗口前的 session.model_changed
    // 一并回放（按序，最后一条生效），否则长会话的早期选择会在 resume 时丢失。
    const entries = [
      ...all.slice(0, from).filter((entry) => entry.type === 'session.model_changed'),
      ...all.slice(from),
    ]
    const replayedTurns = entries.filter(
      (entry) => entry.type === 'turn.started' && !isBubbledEvent(entry),
    ).length
    const skippedTurns = Math.max(
      0,
      turnStarts.filter((index) => index >= 0).length - replayedTurns,
    )
    const replay = replaySessionState(id, entries, {
      maxTokens: 200_000,
      toolRegistrySnapshot: 'builtin:l1',
    })
    if (!replay.found)
      throw new VolundError(
        'session_not_found',
        `Session not found or has no resumable events: ${id}`,
      )
    const state = updateSession(replay.state, (draft) => {
      draft.activeTurn = null
      draft.pendingInterrupt = false
      draft.turns = draft.turns.map((turn) =>
        terminalStatuses.has(turn.status) ? turn : { ...turn, status: 'aborted' },
      )
    })
    await this.activate(state, { tailTurns: replayedTurns, skippedTurns })
    return { id }
  }

  async list(): Promise<readonly SessionCandidate[]> {
    const candidates: SessionCandidate[] = []
    for await (const path of glob(join(this.options.sessionsDir, '*.jsonl'))) {
      try {
        const entries = await new SessionStore(path).load()
        if (entries.length === 0) continue
        // REM-74：候选不再依赖 session.snapshot，事件 replay（附录 D）直接派生；
        // 旧 session 的 snapshot 行由 replaySessionState 作为基线兜底。文件名是
        // session id 的唯一真相（bubbled 子事件带子 sessionId，不参与）。
        const id = basename(path, '.jsonl')
        const replay = replaySessionState(id, entries, {
          maxTokens: 200_000,
          toolRegistrySnapshot: 'builtin:l1',
        })
        const state = replay.state
        if (!SESSION_ID_PATTERN.test(state.id) || typeof state.cwd !== 'string') continue
        const firstUser = state.messages.find((message) => message.role === 'user')
        const summary = firstUser ? messageText(firstUser.content) : undefined
        candidates.push({
          id: state.id,
          cwd: state.cwd,
          updatedAt: entries.at(-1)?.at ?? new Date().toISOString(),
          title:
            summary?.slice(0, 72) ||
            (this.options.uiLocale?.() === 'en' ? 'Untitled session' : '未命名会话'),
          ...(summary ? { summary } : {}),
        })
      } catch {
        // Ignore corrupt records while keeping healthy sessions available.
      }
    }
    return candidates.toSorted(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id),
    )
  }

  async interrupt(): Promise<void> {
    this.runner?.interrupt()
  }

  /**
   * /model 选择的会话级模型钉住 + 落盘：emit session.model_changed（SessionStore 随
   * 总线持久化），resume 时由 replay 还原进 SessionState.model。之后未显式指定模型
   * 的 turn 以该值为 explicitModel 生效（见 runTurnExclusive）。
   */
  async setModel(model: string): Promise<void> {
    if (!this.runner || !this.events) return
    this.sessionModel = model
    await this.events.emit({
      type: 'session.model_changed',
      version: this.runner.state.version,
      sessionId: this.runner.state.id,
      payload: { model },
    })
  }

  async end(): Promise<void> {
    if (!this.runner || !this.events) return
    const sessionId = this.runner.state.id
    // r13-G2（spec §4.3.1）：session 结束统一 kill 全部后台 shell
    this.backgroundShells?.killAll('session_ended')
    // 附录 D.2 session.ended：★reason（exit|signal|error） ?exitCode。
    await this.events.emit({
      type: 'session.ended',
      version: this.runner.state.version,
      sessionId: this.runner.state.id,
      payload: { reason: 'exit', exitCode: this.lastExitCode },
    })
    await this.options.onEnd?.(sessionId)
    this.options.onPermissionPromptHandler?.(undefined)
    this.runner = undefined
    this.events = undefined
    this.sessionModel = undefined
  }

  /**
   * 删除会话档案（<id>.jsonl + <id>/attachments/；备份目录经 onDelete 钩子清）。
   * 目标是当前活动会话时：turn 在途拒绝（session_turn_in_progress）；否则先
   * end 落 session.ended（否则后续 append 会把文件原样重建），删档后立即以原
   * cwd 冷启动新会话——单活动会话模型下进程不留悬挂的活动引用，TUI/Web/移动端
   * 经 onActivate 广播跟随切到空会话。返回 next = 冷启动的新会话 id（非活动
   * 删除省略），调用方可据此跟随切换。
   */
  async delete(id: string): Promise<{ next?: string }> {
    if (!SESSION_ID_PATTERN.test(id))
      throw new VolundError('session_id_invalid', `Invalid session id: ${id}`)
    if (this.runner?.state.id === id) {
      if (this.turnFlight)
        throw new VolundError(
          'session_turn_in_progress',
          'A turn is already in flight for this session',
        )
      const cwd = this.runner.state.cwd
      await this.end()
      await this.removeArchive(id)
      await this.options.onDelete?.(id)
      const next = await this.startInteractive({ cwd })
      return { next: next.id }
    }
    const entries = await new SessionStore(this.path(id)).load()
    if (entries.length === 0) throw new VolundError('session_not_found', `Session not found: ${id}`)
    await this.removeArchive(id)
    await this.options.onDelete?.(id)
    return {}
  }

  /** 会话档案的磁盘面：事件流本体 + 附件目录（后者可能不存在，force 静默）。 */
  private async removeArchive(id: string): Promise<void> {
    await rm(this.path(id), { force: true })
    await rm(join(this.options.sessionsDir, id), { recursive: true, force: true })
  }

  /**
   * §7.5.2 剪贴板附件粘贴：image → AttachmentStore.stage 落盘返回 handle chip；
   * file → path 引用 chip；text → 交回 UI 原样插入；empty/denied/unavailable
   * 由 UI 映射为系统消息。
   */
  private async pasteClipboardAttachment(): Promise<
    import('@volund/shared').PasteAttachmentResult
  > {
    const runner = this.runner
    if (!runner) return { kind: 'unavailable', reason: 'no active session' }
    let payload: ClipboardPayload
    try {
      payload = await (
        this.options.clipboard ?? (await import('@volund/native-bridge')).createClipboardReader()
      ).read()
    } catch (error) {
      return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
    }
    if (payload.kind === 'empty') return { kind: 'empty' }
    if (payload.kind === 'text') return { kind: 'text', text: payload.text }
    if (payload.kind === 'image') return this.stageImageBytes(payload.bytes, payload.mime)
    const target = payload.paths[0]
    if (!target) return { kind: 'empty' }
    return this.attachFilePath(target)
  }

  /**
   * §7.5.2/§22 W-05：图片字节 → AttachmentStore 内容寻址落盘返回 handle chip——
   * TUI 剪贴板粘贴与 Web 上传（stageAttachment）共用的同一条暂存管线；
   * MIME 白名单与魔数校验由 AttachmentStore.stage 把守。
   */
  private async stageImageBytes(
    bytes: Uint8Array,
    mime: string,
  ): Promise<import('@volund/shared').PasteAttachmentResult> {
    const runner = this.runner
    if (!runner) return { kind: 'unavailable', reason: 'no active session' }
    try {
      const store = new AttachmentStore(
        join(this.options.sessionsDir, runner.state.id, 'attachments'),
        20 * 1024 * 1024,
        [runner.state.cwd],
      )
      const staged = await store.stage(bytes, mime)
      return {
        kind: 'attached',
        attachment: {
          handle: staged.handle,
          kind: 'image',
          mime: staged.mime,
          size: staged.size,
        },
      }
    } catch (error) {
      return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
    }
  }
  /**
   * §7.5.2 路径附件（粘贴/拖拽文件、Finder 拷贝）：cwd 内 → path 引用；cwd 外
   * 的图片 → 读字节内容寻址落盘成 blob 引用；cwd 外的非图片不支持。
   * 不设授权门（r19 决策）：chip 只是本地引用，内容外发发生在显式提交时。
   */
  private async attachFilePath(
    target: string,
  ): Promise<import('@volund/shared').PasteAttachmentResult> {
    const runner = this.runner
    if (!runner) return { kind: 'unavailable', reason: 'no active session' }
    // @ picker 传来的是 cwd 相对路径——相对路径一律按会话工作目录解析。
    const absolute = isAbsolute(target) ? target : resolve(runner.state.cwd, target)
    let stats
    try {
      stats = await stat(absolute)
    } catch {
      return { kind: 'unavailable', reason: `not a file: ${target}` }
    }
    if (!stats.isFile()) return { kind: 'unavailable', reason: `not a file: ${target}` }
    const mime = mimeForAttachmentPath(absolute)
    const kind = mime.startsWith('image/') ? ('image' as const) : ('file' as const)
    const [realTarget, realCwd] = await Promise.all([
      realpath(absolute),
      realpath(runner.state.cwd),
    ])
    const rel = relative(realCwd, realTarget)
    const insideWorkspace = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    if (insideWorkspace)
      return {
        kind: 'attached',
        attachment: { kind, mime, path: realTarget, size: stats.size },
      }
    if (kind !== 'image') return { kind: 'unavailable', reason: 'outside workspace' }
    try {
      const store = new AttachmentStore(
        join(this.options.sessionsDir, runner.state.id, 'attachments'),
        20 * 1024 * 1024,
        [runner.state.cwd],
      )
      const staged = await store.stage(new Uint8Array(await readFile(realTarget)), mime)
      return {
        kind: 'attached',
        attachment: { handle: staged.handle, kind, mime: staged.mime, size: staged.size },
      }
    } catch (error) {
      return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
    }
  }
  private path(id: string): string {
    return join(this.options.sessionsDir, `${id}.jsonl`)
  }

  /**
   * turn 串行门（§22 W-03 / P1-03）：Runner.run 没有并发守卫，重复 submit 会
   * 覆盖 turnAbort 并腐蚀 turn 状态。在途时 fail closed 抛
   * `session_turn_in_progress`——多标签/多客户端提交由调用方重试或排队。
   */
  private async runTurnExclusive(prompt: string, options?: SubmitOptions): Promise<void> {
    if (this.turnFlight)
      throw new VolundError(
        'session_turn_in_progress',
        'A turn is already in flight for this session',
      )
    const attachments = options?.attachments ?? []
    const input = attachments.length === 0 ? prompt : composeAttachmentInput(prompt, attachments)
    // 当轮显式模型（/model 当轮覆盖）优先；缺省回落会话钉住值（resume 恢复的那条）。
    const model = options?.model ?? this.sessionModel
    const flight = Promise.resolve().then(() =>
      this.runner!.run(input, model ? { explicitModel: model } : undefined),
    )
    this.turnFlight = flight
    try {
      await flight
    } finally {
      if (this.turnFlight === flight) this.turnFlight = undefined
    }
  }

  private async activate(
    state: SessionState,
    resumed?: { tailTurns: number; skippedTurns: number },
  ): Promise<void> {
    // 换 runner 前收口在途前任：turn 中途 resume/冷启动会整体替换 runner，旧 run()
    // 若不打断将永远 await 在工具执行上——turn.aborted 与在途 tool.completed 从此
    // 不发（transcript 把那些工具永远显示成运行中）。interrupt 让旧栈在 abort 边界
    // 解开（审批队列对 abort 立即 settle deny），终态事件经旧总线照常落盘；收口是
    // 异步的，不阻塞换绑。旧航班引用一并作废：它可能永不 settle，留着会把新会话的
    // submit 用 session_turn_in_progress 永久锁死。
    if (this.runner && this.turnFlight) {
      this.runner.interrupt()
      const stale = this.turnFlight
      void stale.catch(() => {})
      this.turnFlight = undefined
    }
    const events = new EventBus()
    // r13-G2：后台 shell 事件按附录 D 形状上本 session 总线（每 session 重挂）
    if (this.backgroundShells) {
      this.backgroundShells.events.started = (payload) => {
        void events.emit({
          type: 'shell.background_started',
          version: state.version,
          sessionId: state.id,
          payload: { ...payload },
        })
      }
      this.backgroundShells.events.exited = (payload) => {
        void events.emit({
          type: 'shell.background_exited',
          version: state.version,
          sessionId: state.id,
          payload: { ...payload },
        })
      }
    }
    const store = new SessionStore(this.path(state.id))
    store.attach(events)
    const runner = await this.options.createRunner(state, events, undefined, this.startOverrides)
    let lastExitCode = 0
    events.subscribe((event) => {
      if (event.type !== 'turn.aborted') return
      // 附录 D.2 turn.aborted：{turnId, reason}——exitCode 由 reason 派生（130=用户中断）。
      const reason = (event.payload as { reason?: unknown }).reason
      lastExitCode = reason === 'user_interrupt' ? 130 : 1
      if (this.events === events) this.lastExitCode = lastExitCode
    })
    if (this.output?.json) {
      const formatter = new MachineEventFormatter()
      events.subscribe((event) => {
        const line = formatter.encode(event)
        if (line) this.output?.write(line)
      })
    }
    this.events = events
    this.runner = runner
    this.lastExitCode = lastExitCode
    // resume 恢复会话钉住模型；冷启动 state.model 缺省 → undefined（跟随全局配置）。
    this.sessionModel = state.model
    // 附录 D.2：冷启动 session.started {cwd}；恢复 session.resumed {tailTurns, skippedTurns}
    // 替代 session.started（W10）。
    await events.emit({
      type: resumed ? 'session.resumed' : 'session.started',
      version: state.version,
      sessionId: state.id,
      payload: resumed
        ? { tailTurns: resumed.tailTurns, skippedTurns: resumed.skippedTurns }
        : { cwd: state.cwd },
    })
  }
}

declare module '@cordisjs/core' {
  interface Context {
    /** 应用级会话控制器（单 active session 形态；多会话注册表是 Web P2 的后续切片）。 */
    sessions: SessionController
  }
}

/** 会话选择器的单行摘要：折叠所有空白，保证标题不折行。 */
function messageText(content: SessionState['messages'][number]['content']): string {
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * resume transcript 的全保真提取：markdown 的块级结构（标题/列表/表格/代码块）
 * 全靠换行界定，折叠空白会把整段塌成一行流水文本。
 */
/**
 * resume transcript 的全保真提取：markdown 的块级结构全靠换行界定。
 * §7.5.2：image/file part 渲染回 chip 文本，resume 后用户消息仍可见附件占位。
 */
function messageFullText(content: SessionState['messages'][number]['content']): string {
  return content
    .map((part) => {
      if (part.type === 'text') return part.text
      const chip = contentPartChipLabel(part)
      return chip ? `${chip} ` : ''
    })
    .join('')
    .trim()
}

/**
 * transcript 条目的图片附件提取：image part → chip + handle 引用
 * （path 引用无 handle——字节不落 AttachmentStore，远程客户端无从回放，chip 文本兜底）。
 */
function transcriptAttachments(
  content: SessionState['messages'][number]['content'],
): TranscriptAttachment[] {
  const out: TranscriptAttachment[] = []
  for (const part of content) {
    if (part.type !== 'image') continue
    const chip = contentPartChipLabel(part)
    if (!chip) continue
    out.push({
      chip,
      kind: 'image',
      mime: part.mime,
      ...(part.source.kind === 'handle' ? { handle: part.source.handle } : {}),
    })
  }
  return out
}
