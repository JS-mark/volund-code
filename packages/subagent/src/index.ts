import { createSession, EventBus, type Runner, type SessionState } from '@volund/core'
import type { Message } from '@volund/provider-kit'
import { VolundNormalizedError } from '@volund/shared'
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

export type SubagentRunStatus = 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'

/** SUBAGENTS-UI-r1：/subagents 面板的数据行（一次 Task 派发 = 一条）。 */
export interface SubagentRunEntry {
  readonly sessionId: string
  readonly parentSessionId: string
  readonly agentType?: string
  readonly depth: number
  status: SubagentRunStatus
  readonly startedAt: number
  endedAt?: number
  /** prompt 首行（截断到 80 字符）。 */
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
      prompt: (() => {
        const firstLine = input.prompt.split('\n', 1)[0] ?? input.prompt
        return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine
      })(),
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
    const cancel = () => runner.interrupt()
    parent.signal.addEventListener('abort', cancel, { once: true })
    try {
      const final = await runner.run(input.prompt)
      const text = lastAssistantText(final.messages)
      if (parent.signal.aborted) {
        this.#finishRun(entry, 'cancelled', final)
        return { sessionId: final.id, status: 'cancelled', text }
      }
      const budgetEvent = final.turns.at(-1)?.status === 'aborted'
      if (budgetEvent) this.#finishRun(entry, 'partial', final, 'budget exhausted, partial result')
      else this.#finishRun(entry, 'completed', final)
      return {
        sessionId: final.id,
        status: budgetEvent ? 'partial' : 'completed',
        text: budgetEvent ? `${text}\n[budget exhausted, partial result]`.trim() : text,
      }
    } catch (cause) {
      this.#finishRun(
        entry,
        'failed',
        undefined,
        cause instanceof Error ? cause.message : String(cause),
      )
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
function resourceError(code: string, message: string): VolundNormalizedError {
  return new VolundNormalizedError({
    category: 'resource_exhausted',
    code,
    message,
    retryable: false,
    source: { kind: 'core' },
  })
}
