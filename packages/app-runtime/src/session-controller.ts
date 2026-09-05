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
import { glob } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { Service } from '@cordisjs/core'
import type { Context } from '@cordisjs/core'
import {
  createSession,
  EventBus,
  MachineEventFormatter,
  replaySessionState,
  updateSession,
} from '@volund/core'
import type { Runner, SessionState } from '@volund/core'
import { VolundError } from '@volund/shared'
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
  TranscriptEntry,
} from './contracts'

/** 与 @volund/subagent 的 RunnerFactory 同形；agent 为 §2.7.1 解析出的自定义定义。 */
export type RunnerFactory = (
  state: SessionState,
  events: EventBus,
  agent?: ResolvedAgentDefinition,
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
  readonly createRunner: RunnerFactory
  readonly onSecurity?: ((input: { skipPermissions: boolean }) => void) | undefined
  readonly onPermissionInteraction?:
    | ((input: { mode: PermissionInteractionMode }) => void)
    | undefined
  readonly onEnd?: ((sessionId: string) => void | Promise<void>) | undefined
  readonly onTerminalOutput?: ((input: { streamToStdout: boolean }) => void) | undefined
  readonly onPermissionPromptHandler?:
    | ((
        handler:
          | ((request: InteractivePermissionRequest) => Promise<InteractivePermissionDecision>)
          | undefined,
      ) => void)
    | undefined
  readonly statusSnapshot?: ((state: SessionState) => Promise<TStatusView>) | undefined
  /** r13-G2：后台 shell 注册表；end() 时统一 killAll。 */
  readonly background?: BackgroundShells | undefined
  readonly terminal?: SessionTerminalHost | undefined
}

export class SessionController<TStatusView = unknown> extends Service {
  private runner: Runner | undefined
  private events: EventBus | undefined
  private readonly backgroundShells: BackgroundShells | undefined
  private output?: { json: boolean; write: (value: string) => void }
  private lastExitCode = 0
  /** turn mutex：in-flight turn 的 promise；存在即拒绝新 submit（§22 W-03）。 */
  private turnFlight: Promise<unknown> | undefined

  constructor(
    ctx: Context,
    private readonly options: SessionControllerOptions<TStatusView>,
  ) {
    super(ctx, 'sessions', true)
    this.backgroundShells = options.background
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

  async startSession(input: {
    cwd: string
    prompt?: string
  }): Promise<{ id: string; exitCode?: number }> {
    const session = await this.startInteractive({ cwd: input.cwd })
    if (input.prompt !== undefined) {
      await this.runTurnExclusive(input.prompt)
    } else {
      if (!this.options.terminal?.isInteractive())
        throw new Error('Interactive chat requires a TTY or a prompt')
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

  async startInteractive(input: { cwd: string }): Promise<InteractiveSession<TStatusView>> {
    const id = uuidv7()
    await this.activate(
      createSession({ id, cwd: input.cwd, maxTokens: 200_000, toolRegistrySnapshot: 'builtin:l1' }),
    )
    return this.interactiveSession()
  }

  async resumeInteractive(id: string): Promise<InteractiveSession<TStatusView>> {
    await this.resume(id)
    return this.interactiveSession()
  }

  private interactiveSession(): InteractiveSession<TStatusView> {
    return {
      id: this.runner!.state.id,
      cwd: this.runner!.state.cwd,
      events: this.events!,
      transcript: this.runner!.state.messages.flatMap((message) => {
        const text = messageFullText(message.content)
        if (
          !text ||
          (message.role !== 'assistant' && message.role !== 'system' && message.role !== 'user')
        )
          return []
        const entry: TranscriptEntry = { id: message.id, role: message.role, text }
        return [entry]
      }),
      ...(this.options.statusSnapshot
        ? { getStatus: () => this.options.statusSnapshot!(this.runner!.state) }
        : {}),
      setPermissionPromptHandler: (
        handler:
          | ((request: InteractivePermissionRequest) => Promise<InteractivePermissionDecision>)
          | undefined,
      ) => {
        this.options.onPermissionPromptHandler?.(handler)
      },
      interrupt: async () => {
        this.runner?.interrupt()
      },
      submit: (prompt: string, submitOptions?: SubmitOptions) =>
        this.runTurnExclusive(prompt, submitOptions),
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
    if (!SESSION_ID_PATTERN.test(id)) throw new Error('Invalid session id')
    const store = new SessionStore(this.path(id))
    // §8.2 D1-1（REM-74）：resume 一律走事件 replay（附录 D 形状；legacy session.snapshot
    // 行作为旧数据的基线兜底），禁止再写全量快照。
    const all = await store.load()
    const turnStarts = all.map((entry, index) => (entry.type === 'turn.started' ? index : -1))
    const tailTurns = 20
    const from = turnStarts.filter((index) => index >= 0).at(-tailTurns) ?? 0
    const entries = all.slice(from)
    const replayedTurns = entries.filter((entry) => entry.type === 'turn.started').length
    const skippedTurns = Math.max(
      0,
      turnStarts.filter((index) => index >= 0).length - replayedTurns,
    )
    const replay = replaySessionState(id, entries, {
      maxTokens: 200_000,
      toolRegistrySnapshot: 'builtin:l1',
    })
    if (!replay.found) throw new Error(`Session not found or has no resumable events: ${id}`)
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
          title: summary?.slice(0, 72) || `Session in ${state.cwd}`,
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
    const flight = Promise.resolve().then(() =>
      this.runner!.run(prompt, options?.model ? { explicitModel: options.model } : undefined),
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
    const runner = await this.options.createRunner(state, events)
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
function messageFullText(content: SessionState['messages'][number]['content']): string {
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim()
}
