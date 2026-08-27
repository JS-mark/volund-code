import { createSession, EventBus, type Runner, type SessionState } from '@volund/core'
import type { Message } from '@volund/provider-kit'
import { VolundNormalizedError } from '@volund/shared'
import { v7 as uuidv7 } from 'uuid'

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
export type RunnerFactory = (state: SessionState, events: EventBus) => Runner | Promise<Runner>
export interface SubagentOptions {
  runnerFactory: RunnerFactory
  defaultBudget?: SubagentBudget
  maxDepth?: number
  maxConcurrency?: number
}

/** Owns child lifetimes. It never retains parent messages, permission caches, or tool output. */
export class SubagentDispatcher {
  readonly #active = new Set<Runner>()
  readonly #maxDepth: number
  readonly #maxConcurrency: number
  constructor(readonly options: SubagentOptions) {
    this.#maxDepth = Math.min(options.maxDepth ?? 3, 3)
    this.#maxConcurrency = Math.max(1, options.maxConcurrency ?? 4)
  }
  get activeCount(): number {
    return this.#active.size
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
    const runner = await this.options.runnerFactory(state, events)
    this.#active.add(runner)
    const cancel = () => runner.interrupt()
    parent.signal.addEventListener('abort', cancel, { once: true })
    try {
      const final = await runner.run(input.prompt)
      const text = lastAssistantText(final.messages)
      if (parent.signal.aborted) return { sessionId: final.id, status: 'cancelled', text }
      const budgetEvent = final.turns.at(-1)?.status === 'aborted'
      return {
        sessionId: final.id,
        status: budgetEvent ? 'partial' : 'completed',
        text: budgetEvent ? `${text}\n[budget exhausted, partial result]`.trim() : text,
      }
    } catch (cause) {
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
    }
  }
  cancelAll(): void {
    for (const runner of this.#active) runner.interrupt()
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
