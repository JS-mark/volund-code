import { createSession, EventBus, type Runner, type SessionState } from '@volund/core'
import type { Message } from '@volund/provider-kit'
import {
  VolundNormalizedError,
  subagentDispatchedPayloadSchema,
  subagentSettledPayloadSchema,
  type JsonValue,
} from '@volund/shared'
import { v7 as uuidv7 } from 'uuid'

import { AgentDefinitionRegistry, type ResolvedAgentDefinition } from './agent-registry'

export { AgentDefinitionRegistry, untrustedAgentBody } from './agent-registry'
export type { AgentRegistryOptions, ResolvedAgentDefinition } from './agent-registry'

export interface SubagentBudget {
  tokenMax?: number
  costUSDMax?: number
  timeMsMax?: number
  toolCallMax?: number
}
export interface DispatchParent {
  state: SessionState
  events: EventBus
  turnId: string
  signal: AbortSignal
}
export interface DispatchInput {
  prompt: string
  agentType?: string
  budget?: SubagentBudget
}
export interface DispatchResult {
  sessionId: string
  status: 'completed' | 'partial' | 'failed' | 'cancelled'
  text: string
  error?: VolundNormalizedError
}
export type RunnerFactory = (
  state: SessionState,
  events: EventBus,
  agent?: ResolvedAgentDefinition,
) => Runner | Promise<Runner>
export interface SubagentOptions {
  runnerFactory: RunnerFactory
  defaultBudget?: SubagentBudget
  maxDepth?: number
  maxConcurrency?: number
  /** §2.7.1 自定义 agent 定义；缺省时 agentType 校验退回放行（core 测试路径）。 */
  agents?: AgentDefinitionRegistry
  /** SUBAGENTS-UI-r1：运行注册表变更回调（面板热更新）。 */
  onRunsChange?: () => void
  /** 运行历史保留条数（最旧淘汰；默认 100）。 */
  runHistoryLimit?: number
}

export type SubagentRunStatus =
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  /**
   * SAG-03 §2.7bis.4：crash 合成标记——重放重建时 dispatched 无 settled 的运行。
   * 不是 settled status（附录 D.2 枚举无此值），不发事件，只在注册表内存在。
   */
  | 'interrupted'

/**
 * SAG-03 §2.7bis.4：重放重建的输入行（SessionStore.load() 结果的结构子集——
 * subagent 包不依赖 storage，JSONL 读取面由调用方（apps/cli runtime）提供）。
 */
export interface SubagentJournalEvent {
  type: string
  sessionId: string
  /** 附录 D.1 envelope.at 的落盘形（ISO 字符串）。 */
  at: string
  payload: JsonValue
}

/** SUBAGENTS-UI-r1：/subagents 面板的数据行（一次 Task 派发 = 一条）。 */
export interface SubagentRunEntry {
  readonly sessionId: string
  readonly parentSessionId: string
  readonly agentType?: string
  readonly depth: number
  status: SubagentRunStatus
  readonly startedAt: number
  endedAt?: number
  /** prompt 首行预览（截断到 80 字符；列表行用）。 */
  readonly promptPreview: string
  /** 完整 prompt（截断到 2000 字符；详情页用）。 */
  readonly prompt: string
  readonly budget?: SubagentBudget
  usage?: { input: number; output: number; costUSD: number }
  toolCalls?: number
  /** 终态补充信息（失败原因 / partial 原因）。 */
  detail?: string
}

/**
 * §2.7.1 Task 校验的内置 agentType。`planner`/`coder`/`reviewer` 是现行
 * RouterHint role 词汇（runner.ts）；`main`/`task-agent`/`review-agent` 是
 * spec 枚举，接受但不改变行为。
 */
export const BUILTIN_AGENT_TYPES = [
  'main',
  'task-agent',
  'review-agent',
  'planner',
  'coder',
  'reviewer',
] as const

/** Owns child lifetimes. It never retains parent messages, permission caches, or tool output. */
export class SubagentDispatcher {
  readonly #active = new Set<Runner>()
  /** SUBAGENTS-UI-r1：sessionId → 活跃 runner（供 cancel 单个）。 */
  readonly #activeBySession = new Map<string, Runner>()
  readonly #runs: SubagentRunEntry[] = []
  readonly #cancelledRuns = new Set<string>()
  readonly #maxDepth: number
  readonly #maxConcurrency: number
  constructor(readonly options: SubagentOptions) {
    this.#maxDepth = Math.min(options.maxDepth ?? 3, 3)
    this.#maxConcurrency = Math.max(1, options.maxConcurrency ?? 4)
  }
  get activeCount(): number {
    return this.#active.size
  }
  /** SUBAGENTS-UI-r1：运行/近期完成的快照（新者在前；插入序即时间序）。 */
  list(): readonly SubagentRunEntry[] {
    return [...this.#runs].reverse()
  }
  /** 取消一个运行中的 subagent；不在运行中返回 false。 */
  cancel(sessionId: string): boolean {
    const runner = this.#activeBySession.get(sessionId)
    if (!runner) return false
    this.#cancelledRuns.add(sessionId)
    runner.interrupt()
    this.#touchRuns()
    return true
  }
  /** 全停当前运行（等价原 cancelAll；面板 a 键）。 */
  cancelAllRunning(): number {
    let cancelled = 0
    for (const sessionId of this.#activeBySession.keys()) {
      this.#cancelledRuns.add(sessionId)
      cancelled += 1
    }
    if (cancelled > 0) for (const runner of this.#active) runner.interrupt()
    this.#touchRuns()
    return cancelled
  }
  #touchRuns(): void {
    this.options.onRunsChange?.()
  }
  #beginRun(
    sessionId: string,
    parentSessionId: string,
    input: DispatchInput,
    depth: number,
  ): SubagentRunEntry {
    const entry: SubagentRunEntry = {
      sessionId,
      parentSessionId,
      ...(input.agentType ? { agentType: input.agentType } : {}),
      depth,
      status: 'running',
      startedAt: Date.now(),
      promptPreview: promptDigestOf(input.prompt),
      prompt: input.prompt.length > 2000 ? `${input.prompt.slice(0, 1999)}…` : input.prompt,
      ...(input.budget || this.options.defaultBudget
        ? { budget: { ...this.options.defaultBudget, ...input.budget } }
        : {}),
    }
    this.#runs.push(entry)
    const limit = this.options.runHistoryLimit ?? 100
    if (this.#runs.length > limit) this.#runs.splice(0, this.#runs.length - limit)
    this.#touchRuns()
    return entry
  }
  #finishRun(
    entry: SubagentRunEntry,
    status: SubagentRunStatus,
    final: SessionState | undefined,
    detail?: string,
  ): void {
    // marker 只由显式 cancel()/cancelAllRunning() 写入——存在即用户主动取消，
    // 无论底层以 aborted turn 还是异常收尾，'cancelled' 都是真实状态。
    entry.status = this.#cancelledRuns.has(entry.sessionId) ? 'cancelled' : status
    entry.endedAt = Date.now()
    if (final) {
      const usage = final.cumulativeUsage
      entry.usage = {
        input: usage.input,
        output: usage.output,
        costUSD: usage.costUSD,
      }
      entry.toolCalls = final.messages.reduce(
        (count, message) =>
          count + message.content.filter((part) => part.type === 'tool_use').length,
        0,
      )
    }
    if (detail) entry.detail = detail
    this.#cancelledRuns.delete(entry.sessionId)
    this.#touchRuns()
  }
  /**
   * §2.7bis.4 / 附录 D.2：收尾发 `subagent.settled`（父总线，与 dispatched 同一归属）。
   * 账本唯一数据源——usage/ctxOut/toolCalls/durationMs 全在本事件。
   * `partial`（budget 耗尽）归入 `completed` 并以 detail 注记：附录 D 枚举只有
   * completed|failed|cancelled，partial 的运行实际产生了回传结果与真实账本。
   */
  async #emitSettled(
    parent: DispatchParent,
    entry: SubagentRunEntry,
    ctxOut: number,
  ): Promise<void> {
    const status: 'completed' | 'failed' | 'cancelled' =
      entry.status === 'failed'
        ? 'failed'
        : entry.status === 'cancelled'
          ? 'cancelled'
          : 'completed'
    const usage = entry.usage
    await parent.events.emit({
      type: 'subagent.settled',
      version: parent.state.version,
      sessionId: parent.state.id,
      turnId: parent.turnId,
      payload: {
        sessionId: entry.sessionId,
        status,
        usage: {
          input: usage?.input ?? 0,
          output: usage?.output ?? 0,
          ...(usage?.costUSD === undefined ? {} : { costUSD: usage.costUSD }),
        },
        ctxOut,
        toolCalls: entry.toolCalls ?? 0,
        durationMs: Math.max(0, (entry.endedAt ?? Date.now()) - entry.startedAt),
        ...(entry.detail ? { detail: entry.detail } : {}),
      },
    })
  }
  /**
   * SAG-03 §2.7bis.4：从父会话 JSONL 的 subagent.* 事件重放重建运行注册表
   * （resume / 面板首次打开时由调用方触发）。独立 JSONL 全扫，**不经** session
   * replay 的尾部 20-turn 窗口——subagent.* 是会话级运行史事件，落在窗口前的
   * 一样是注册表历史（参照 session.model_changed 的窗口外回放语义，但走全扫而非
   * prepend，因为重建目标是注册表而非 SessionState）。
   * dispatched 无 settled → `interrupted`（crash 合成标记，不发事件）。
   * 内存 live 条目优先：已知 sessionId 跳过；嵌套孙代理事件经冒泡落同一父 JSONL，
   * payload.parentSessionId/depth 原样还原。返回新补进的条数。
   */
  rebuildFromJournal(events: readonly SubagentJournalEvent[]): number {
    const known = new Set(this.#runs.map((entry) => entry.sessionId))
    const replayed: SubagentRunEntry[] = []
    const bySession = new Map<string, SubagentRunEntry>()
    for (const event of events) {
      if (event.type === 'subagent.dispatched') {
        const parsed = subagentDispatchedPayloadSchema.safeParse(event.payload)
        if (!parsed.success) continue
        const payload = parsed.data
        if (known.has(payload.sessionId) || bySession.has(payload.sessionId)) continue
        const startedAt = Date.parse(event.at)
        // JSONL 只存 ≤80 字符的 promptDigest——重放行没有完整 prompt 可还原。
        const entry: SubagentRunEntry = {
          sessionId: payload.sessionId,
          parentSessionId: payload.parentSessionId,
          ...(payload.agentType ? { agentType: payload.agentType } : {}),
          depth: payload.depth,
          status: 'running',
          startedAt: Number.isNaN(startedAt) ? Date.now() : startedAt,
          promptPreview: payload.promptDigest,
          prompt: payload.promptDigest,
          budget: eventBudgetOf(payload.budget),
        }
        bySession.set(payload.sessionId, entry)
        replayed.push(entry)
      } else if (event.type === 'subagent.settled') {
        const parsed = subagentSettledPayloadSchema.safeParse(event.payload)
        if (!parsed.success) continue
        const payload = parsed.data
        // settled 无配对的 dispatched（窗口截断/旧数据残缺）——无从还原行，跳过。
        const entry = bySession.get(payload.sessionId)
        if (!entry) continue
        const endedAt = Date.parse(event.at)
        entry.status = payload.status
        entry.endedAt = Number.isNaN(endedAt) ? entry.startedAt : endedAt
        entry.usage = {
          input: payload.usage.input,
          output: payload.usage.output,
          costUSD: payload.usage.costUSD ?? 0,
        }
        entry.toolCalls = payload.toolCalls
        if (payload.detail) entry.detail = payload.detail
      }
    }
    if (replayed.length === 0) return 0
    for (const entry of replayed) if (entry.status === 'running') entry.status = 'interrupted'
    this.#runs.push(...replayed)
    // 插入序 = 时间序（list() 依赖）：重放行按 startedAt 归位（重放可能晚于 live 运行触发）。
    this.#runs.sort((a, b) => a.startedAt - b.startedAt)
    const limit = this.options.runHistoryLimit ?? 100
    if (this.#runs.length > limit) this.#runs.splice(0, this.#runs.length - limit)
    this.#touchRuns()
    return replayed.length
  }
  /**
   * SAG-03：dispatcher 整体替换（config reload）时保留运行史——接管 previous 的
   * 条目（sessionId 去重、浅拷贝防别名）。调用方保证 previous 已无活跃运行
   * （activeCount === 0 才允许替换），接管的都是终态历史。
   */
  inheritRuns(previous: SubagentDispatcher): number {
    const known = new Set(this.#runs.map((entry) => entry.sessionId))
    const inherited: SubagentRunEntry[] = []
    for (const entry of previous.#runs) {
      if (known.has(entry.sessionId)) continue
      inherited.push({ ...entry })
    }
    if (inherited.length === 0) return 0
    this.#runs.push(...inherited)
    this.#runs.sort((a, b) => a.startedAt - b.startedAt)
    const limit = this.options.runHistoryLimit ?? 100
    if (this.#runs.length > limit) this.#runs.splice(0, this.#runs.length - limit)
    this.#touchRuns()
    return inherited.length
  }
  async dispatch(parent: DispatchParent, input: DispatchInput): Promise<DispatchResult> {
    const depth = (parent.state.lineage?.depth ?? 0) + 1
    if (depth > this.#maxDepth)
      throw resourceError(
        'VOLUND_SUBAGENT_DEPTH_EXCEEDED',
        `Subagent depth ${depth} exceeds ${this.#maxDepth}`,
      )
    if (this.#active.size >= this.#maxConcurrency)
      throw resourceError(
        'VOLUND_SUBAGENT_CONCURRENCY_EXCEEDED',
        'Subagent concurrency budget exhausted',
      )
    // §2.7.1 Task 校验：agentType 枚举 = 内置 + 已扫描定义。注册表缺席时放行
    // （core 单测/旧调用路径维持原行为——agentType 仅作 lineage 标签）。
    const agent =
      input.agentType && this.options.agents ? this.#resolveAgentType(input.agentType) : undefined
    if (parent.signal.aborted) return { sessionId: '', status: 'cancelled', text: '' }
    const events = new EventBus()
    // 附录 D.3 / r13-D1：冒泡保留原 event.id 与 payload，只在 envelope 加
    // parentTurnId / parentDepth tag——seen-set 去重与 JSONL 重放幂等以 event.id 为键。
    const unsubscribe = events.subscribe(async (event) => {
      await parent.events.forward(event, { parentTurnId: parent.turnId, parentDepth: depth })
    })
    const state = createSession({
      id: uuidv7(),
      cwd: parent.state.cwd,
      maxTokens: parent.state.contextBudget.maxTokens,
      toolRegistrySnapshot: parent.state.toolRegistrySnapshot,
      lineage: {
        depth,
        parentSessionId: parent.state.id,
        parentTurnId: parent.turnId,
        ...(input.agentType ? { agentType: input.agentType } : {}),
      },
      resourceBudget: { ...this.options.defaultBudget, ...input.budget },
    })
    const runner = await this.options.runnerFactory(state, events, agent)
    this.#active.add(runner)
    this.#activeBySession.set(state.id, runner)
    const entry = this.#beginRun(state.id, parent.state.id, input, depth)
    // §2.7bis.4 / 附录 D.2：发父总线落父 JSONL（非冒泡——D.3 tag 不加），
    // envelope 归属父会话（sessionId/turnId 取父），payload.sessionId 是子。
    await parent.events.emit({
      type: 'subagent.dispatched',
      version: parent.state.version,
      sessionId: parent.state.id,
      turnId: parent.turnId,
      payload: {
        sessionId: state.id,
        parentSessionId: parent.state.id,
        parentTurnId: parent.turnId,
        ...(input.agentType ? { agentType: input.agentType } : {}),
        depth,
        // SAG-20/批次 4 前占位：Tier 0 共享树、非 fork；writePaths 缺省省略。
        isolationTier: 0,
        fork: false,
        budget: eventBudgetOf({ ...this.options.defaultBudget, ...input.budget }),
        promptDigest: entry.promptPreview,
        // v1 估算（字符数/4）；fork/handoff 落地后快照注入量也计此（§2.7bis.1 ledger）。
        ctxIn: estimateTokens(input.prompt),
      },
    })
    const cancel = () => runner.interrupt()
    parent.signal.addEventListener('abort', cancel, { once: true })
    try {
      const final = await runner.run(input.prompt)
      const text = lastAssistantText(final.messages)
      if (parent.signal.aborted) {
        this.#finishRun(entry, 'cancelled', final)
        await this.#emitSettled(parent, entry, estimateTokens(text))
        return { sessionId: final.id, status: 'cancelled', text }
      }
      const budgetEvent = final.turns.at(-1)?.status === 'aborted'
      if (budgetEvent) this.#finishRun(entry, 'partial', final, 'budget exhausted, partial result')
      else this.#finishRun(entry, 'completed', final)
      const resultText = budgetEvent ? `${text}\n[budget exhausted, partial result]`.trim() : text
      await this.#emitSettled(parent, entry, estimateTokens(resultText))
      return {
        sessionId: final.id,
        status: budgetEvent ? 'partial' : 'completed',
        text: resultText,
      }
    } catch (cause) {
      this.#finishRun(
        entry,
        'failed',
        undefined,
        cause instanceof Error ? cause.message : String(cause),
      )
      await this.#emitSettled(parent, entry, 0)
      const error = new VolundNormalizedError({
        category: 'unknown',
        code: 'VOLUND_SUBAGENT_FAILED',
        message: cause instanceof Error ? cause.message : String(cause),
        retryable: false,
        source: { kind: 'core' },
        cause,
      })
      return { sessionId: state.id, status: 'failed', text: '', error }
    } finally {
      parent.signal.removeEventListener('abort', cancel)
      unsubscribe()
      this.#active.delete(runner)
      this.#activeBySession.delete(state.id)
      this.#touchRuns()
    }
  }
  cancelAll(): void {
    this.cancelAllRunning()
  }
  /** Task 工具 inputSchema 的 agentType 枚举（内置 + 已扫描定义名）。 */
  agentTypeNames(): string[] {
    return [
      ...BUILTIN_AGENT_TYPES,
      ...(this.options.agents?.list().map((a) => a.definition.name) ?? []),
    ]
  }
  #resolveAgentType(agentType: string): ResolvedAgentDefinition | undefined {
    const resolved = this.options.agents?.get(agentType)
    if (resolved) return resolved
    // 内置名（RouterHint role / lineage 标签）无附加定义：返回 undefined，
    // 工厂侧不得为其注册 system prompt 槽位或白名单。
    if ((BUILTIN_AGENT_TYPES as readonly string[]).includes(agentType)) return undefined
    throw new VolundNormalizedError({
      category: 'invalid_request',
      code: 'VOLUND_SUBAGENT_UNKNOWN_AGENT',
      message: `Unknown agentType '${agentType}'; known: ${this.agentTypeNames().join(', ')}`,
      retryable: false,
      source: { kind: 'core' },
    })
  }
}

function lastAssistantText(messages: readonly Message[]): string {
  const message = messages.findLast((item) => item.role === 'assistant')
  return (
    message?.content
      .filter(
        (part): part is Extract<Message['content'][number], { type: 'text' }> =>
          part.type === 'text',
      )
      .map((part) => part.text)
      .join('\n') ?? ''
  )
}
/**
 * prompt 摘要：`subagent.dispatched` ★promptDigest 与注册表行预览共用——首行 ≤80 字符。
 * schema 要求 min(1)：空首行（空白 prompt）退回原文前 80 字符兜底，再空给占位串。
 */
function promptDigestOf(prompt: string): string {
  const firstLine = prompt.split('\n', 1)[0] ?? prompt
  const digest = firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine
  return digest || prompt.slice(0, 80) || '(empty prompt)'
}
/** v1 token 估算（字符数/4，向上取整）——ctxIn/ctxOut 字段位共用，模型侧无新调用。 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
/**
 * dispatched 事件的 budget 位 = 合并后生效预算（default ⊕ input）。
 * 附录 D.2 schema 只登记 tokenMax/costUSDMax/timeMsMax 三维（toolCallMax 不在契约内），
 * 且维度值以正数登记——非正维度不进事件（0/负预算是无意义配置，不伪造账本）。
 */
function eventBudgetOf(merged: {
  tokenMax?: number | undefined
  costUSDMax?: number | undefined
  timeMsMax?: number | undefined
}): {
  tokenMax?: number
  costUSDMax?: number
  timeMsMax?: number
} {
  return {
    ...(merged.tokenMax !== undefined && merged.tokenMax > 0
      ? { tokenMax: Math.floor(merged.tokenMax) }
      : {}),
    ...(merged.costUSDMax !== undefined && merged.costUSDMax > 0
      ? { costUSDMax: merged.costUSDMax }
      : {}),
    ...(merged.timeMsMax !== undefined && merged.timeMsMax > 0
      ? { timeMsMax: Math.floor(merged.timeMsMax) }
      : {}),
  }
}
function resourceError(code: string, message: string): VolundNormalizedError {
  return new VolundNormalizedError({
    category: 'resource_exhausted',
    code,
    message,
    retryable: false,
    source: { kind: 'core' },
  })
}
