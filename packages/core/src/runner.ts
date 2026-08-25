import type {
  ContentPart,
  ContextPolicy,
  Message,
  ProviderChunk,
  ProviderClient,
  ProviderError,
  StopReason,
  ToolSchema,
  Usage,
} from '@apollo-code/provider-kit'
import type { RouterDecision, RouterHint, RouterPolicy } from '@apollo-code/router'
import type { EventContent, JsonValue } from '@apollo-code/shared'
import { v7 as uuidv7 } from 'uuid'

import { EventBus } from './event-bus'
import type { PromptComposer } from './prompt-composer'
import { updateSession, type SessionState } from './session'

export interface ToolExecution {
  toolUseId: string
  toolName?: string
  content: ContentPart[]
  isError?: boolean
  durationMs?: number
  /** 附录 D.2 tool.completed ?linesAdded/?linesRemoved：文件改写工具上报的行级变更量。 */
  linesAdded?: number
  linesRemoved?: number
}
export interface RunnerToolPort {
  schemas(provider: ProviderClient): ToolSchema[]
  execute(
    toolUse: Extract<ContentPart, { type: 'tool_use' }>,
    signal: AbortSignal,
  ): Promise<ToolExecution>
}
export interface RunnerOptions {
  maxToolLoopsPerTurn?: number
  budget?: { tokenMax?: number; costUSDMax?: number; timeMsMax?: number; toolCallMax?: number }
}
/**
 * tool_use 流式聚合条目（spec 03-provider-router §3.2 rule 1）：
 * `fragments` 即 `Map<toolUseId, string[]>` 的 per-id 片段列表，delta 按 id 追加，
 * `tool_use.end` 时 join 全文并做一次性 `JSON.parse`。
 */
interface AggregatingToolUse {
  id: string
  name: string
  fragments: string[]
  raw?: string // join 结果，end 时定稿
  input?: JsonValue // parse 成功时定稿；undefined = 未 parse 或 parse 失败
  ended?: boolean
}
interface InProgress {
  text: string
  thinking: string
  tools: Map<string, AggregatingToolUse>
  invalidTools: Set<string> // parse 失败的 toolUseId（§3.2 rule 2：不执行）
  usage?: Usage
  stopReason?: StopReason
}

/**
 * 附录 D.2 `message.appended` 的引用式 content：provider-kit ContentPart 中 inline 二进制
 * 附件（附录 D.1「大 payload 不进事件，只传引用」）递归替换为占位 text part（tool_result
 * 内容可嵌套），其余结构原样透传（text/thinking/tool_use/tool_result 与引用式 image/file）。
 */
export function toEventContent(parts: readonly ContentPart[]): EventContent[] {
  return parts.map((part): EventContent => {
    if (part.type === 'tool_result') return { ...part, content: toEventContent(part.content) }
    if (part.type !== 'image' && part.type !== 'file') return part
    if (part.source.kind === 'inline')
      return {
        type: 'text',
        text: `[Attachment omitted from event: inline ${part.type} (${part.mime}) not referenceable]`,
      }
    // 引用式附件原样透传（TS 对负向判别的窄化不足，显式重构）。
    if (part.type === 'image') return { type: 'image', source: part.source, mime: part.mime }
    return { type: 'file', source: part.source, mime: part.mime, filename: part.filename }
  })
}

export class Runner {
  #state: SessionState
  #turnAbort?: AbortController
  // r13-G5（B7）：上一 turn 的 provider/model 与 stopReason——上一条回复被 max_tokens
  // 截断时，下一条消息（典型：用户输入 continue）的 router hint 优先沿用同 provider，
  // 防止续写换 provider 造成风格断裂。turn 边界 sticky 已清空（§3.7.1 规则 4），故走 hint。
  #lastTurn?: { provider: string; model: string; stopReason?: StopReason }
  constructor(
    state: SessionState,
    readonly router: RouterPolicy,
    readonly promptComposer: PromptComposer,
    readonly tools: RunnerToolPort,
    readonly events = new EventBus(),
    readonly options: RunnerOptions = {},
    readonly contextPolicy?: ContextPolicy,
  ) {
    this.#state = state
  }
  get state(): SessionState {
    return this.#state
  }
  interrupt(): void {
    this.#state = updateSession(this.#state, (draft) => {
      draft.pendingInterrupt = true
    })
    this.#turnAbort?.abort()
  }
  async run(input: string | readonly ContentPart[], hint?: RouterHint): Promise<SessionState> {
    const turnId = uuidv7()
    this.#turnAbort = new AbortController()
    const signal = this.#turnAbort.signal
    this.#state = updateSession(this.#state, (draft) => {
      draft.pendingInterrupt = false
      draft.activeTurn = turnId
      draft.turns = [
        ...draft.turns,
        {
          id: turnId,
          startMessageId: '',
          status: 'streaming',
          parentDepth: this.#state.lineage?.depth ?? 0,
          ...(this.#state.lineage?.parentTurnId
            ? { parentTurnId: this.#state.lineage.parentTurnId }
            : {}),
          ...(this.#state.lineage?.agentType ? { agentType: this.#state.lineage.agentType } : {}),
        },
      ]
    })
    await this.emit('turn.started', turnId, {
      turnId,
      ...(this.#state.lineage?.parentTurnId
        ? { parentTurnId: this.#state.lineage.parentTurnId }
        : {}),
      ...(this.#state.lineage?.agentType ? { agentType: this.#state.lineage.agentType } : {}),
    })
    const user = this.message(
      'user',
      typeof input === 'string' ? [{ type: 'text', text: input }] : [...input],
    )
    this.append(user)
    await this.emit('message.appended', turnId, {
      messageId: user.id,
      role: user.role,
      content: toEventContent(user.content),
    })
    let sticky: ProviderClient | undefined
    let decision: RouterDecision | undefined
    let retryDecision: RouterDecision | undefined
    let attempts = 0
    let loops = 0
    let toolCalls = 0
    let failed = false
    // 附录 D.2 turn.aborted reason（user_interrupt | error | stream_interrupted）
    let abortReason: 'user_interrupt' | 'error' | 'stream_interrupted' | undefined
    const turnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0 }
    let lastStopReason: StopReason | undefined
    const turnStartedAt = Date.now()
    const agentType = this.#state.lineage?.agentType
    const lineageRole: RouterHint['role'] =
      agentType === 'planner' || agentType === 'coder' || agentType === 'reviewer'
        ? agentType
        : undefined
    // B7：上一 turn 以 max_tokens 截断 → 本条消息优先沿用其 provider/model
    //（调用方显式指定的 explicitModel / hint 优先于 B7 推断）
    const b7 = this.#lastTurn?.stopReason === 'max_tokens' ? this.#lastTurn : undefined
    const hasB7Preference = b7 !== undefined && hint?.explicitModel === undefined
    const b7Preference = hasB7Preference
      ? { preferredProvider: b7.provider, explicitModel: b7.model }
      : {}
    const routerHint: RouterHint | undefined =
      hasB7Preference || lineageRole !== undefined || hint !== undefined
        ? { ...b7Preference, ...(lineageRole ? { role: lineageRole } : {}), ...hint }
        : undefined
    try {
      outer: while (!signal.aborted) {
        const exhausted = this.exhaustedBudget(turnStartedAt, toolCalls)
        if (exhausted) {
          await this.emit('error.raised', turnId, {
            code: 'subagent_budget_exhausted',
            context: {
              dimension: exhausted,
              consumed: {
                input: this.#state.cumulativeUsage.input,
                output: this.#state.cumulativeUsage.output,
                costUSD: this.#state.cumulativeUsage.costUSD,
                timeMs: Date.now() - turnStartedAt,
                toolCalls,
              },
              budget: this.options.budget ?? this.#state.resourceBudget ?? {},
            },
          })
          abortReason = 'error'
          this.#turnAbort.abort('budget')
          break
        }
        if (loops >= (this.options.maxToolLoopsPerTurn ?? 25)) {
          await this.emit('error.raised', turnId, {
            code: 'tool_loop_exhausted',
            context: { loopCount: loops },
          })
          break
        }
        loops += 1
        decision =
          retryDecision ??
          (sticky
            ? { provider: sticky, model: decision?.model ?? '', reason: 'sticky-provider' }
            : await this.router.pick(
                this.routerContext(turnId, attempts, turnStartedAt, signal),
                routerHint,
              ))
        retryDecision = undefined
        const system = await this.promptComposer.compose({
          cwd: this.#state.cwd,
          model: decision.model,
          provider: decision.provider.name,
        })
        if (this.#state.systemPromptSnapshot !== system)
          this.#state = updateSession(this.#state, (draft) => {
            draft.systemPromptSnapshot = system
          })
        let requestMessages = this.#state.messages
        if (this.contextPolicy) {
          const context = {
            session: this.#state,
            capabilities: decision.provider.capabilities,
            turnId,
            model: decision.model,
            systemTokens: this.contextPolicy.estimateTokens(system, decision.model),
            toolSchemaTokens: Math.ceil(
              JSON.stringify(this.tools.schemas(decision.provider)).length / 3.5,
            ),
          }
          if (this.contextPolicy.shouldCompact(context)) {
            this.#state = updateSession(this.#state, (draft) => {
              const turn = draft.turns.find((item) => item.id === turnId)
              if (turn) turn.status = 'compacting'
            })
            const snapshot = await this.contextPolicy.compact(context)
            this.#state = updateSession(this.#state, (draft) => {
              draft.messages = [...snapshot.messages]
              const turn = draft.turns.find((item) => item.id === turnId)
              if (turn) turn.status = 'streaming'
            })
            await this.emit('context.compacted', turnId, {
              before: snapshot.beforeTokens,
              after: snapshot.afterTokens,
              strategy: snapshot.strategy,
              removedMessageIds: snapshot.compactedMessageIds,
            })
          }
          requestMessages = this.contextPolicy.buildPrompt({
            ...context,
            session: this.#state,
          }).messages
        }
        requestMessages = messagesForCapabilities(
          requestMessages,
          decision.provider.name,
          decision.provider.capabilities,
        )
        // 附录 D.2 stream.started/delta/completed 共用的 messageId：在流发起前生成，
        // assistant message 定稿时复用（事件流与消息 id 对齐）。
        const messageId = uuidv7()
        await this.emit('stream.started', turnId, {
          messageId,
          provider: decision.provider.name,
          model: decision.model,
        })
        const current: InProgress = {
          text: '',
          thinking: '',
          tools: new Map(),
          invalidTools: new Set(),
        }
        let interrupted = false
        for await (const chunk of decision.provider.stream(
          {
            model: decision.model,
            messages: requestMessages,
            system,
            tools: this.tools.schemas(decision.provider),
          },
          signal,
        )) {
          if (signal.aborted) break outer
          if (chunk.kind === 'tool_use.start') sticky ??= decision.provider
          if (chunk.kind === 'message.interrupted') {
            interrupted = true
            const hadPartialToolUse = current.tools.size > 0
            // §3.2 rule 4：interrupted 到达时所有聚合 entry（含已 end 的）连同所在 message 作废，
            // 不落盘、不执行、不产生 tool_result（见 §3.9a）。
            current.tools.clear()
            current.invalidTools.clear()
            await this.emit('error.raised', turnId, {
              code: 'stream_interrupted',
              context: { reason: chunk.reason, hadPartialToolUse },
            })
            if (hadPartialToolUse) {
              failed = true
              abortReason = 'stream_interrupted'
              await this.emit('error.raised', turnId, {
                code: 'stream_resume_unsafe_partial_tool_use',
                context: { reason: 'partial tool_use cannot be resumed or replayed safely' },
              })
              break outer
            }
            const error = Object.assign(new Error(chunk.reason), {
              provider: decision.provider.name,
              model: decision.model,
              category: 'stream_truncated',
              retryable: true,
            }) as ProviderError
            const next = await this.router.onError(
              error,
              this.routerContext(turnId, attempts++, turnStartedAt, signal, sticky?.name),
            )
            if (next === 'give-up') {
              failed = true
              abortReason = 'stream_interrupted'
              break outer
            }
            if (sticky && next.provider !== sticky) {
              failed = true
              abortReason = 'stream_interrupted'
              await this.emit('error.raised', turnId, {
                code: 'provider_sticky_violation',
                context: { reason: 'tool_use already in flight, cannot switch provider' },
              })
              break outer
            }
            if (next.provider !== decision.provider)
              await this.emit('router.switched', turnId, {
                from: decision.provider.name,
                to: next.provider.name,
                reason: next.reason,
              })
            retryDecision = next
            continue outer
          }
          this.merge(current, chunk)
          // 附录 D.2 stream.delta：只传增量片段（kind + fragment），不塞整 chunk。
          const fragment = deltaFragment(chunk)
          if (fragment)
            await this.emit('stream.delta', turnId, {
              messageId,
              kind: fragment.kind,
              fragment: fragment.text,
            })
        }
        if (interrupted) continue
        if (signal.aborted) break
        await this.router.onSuccess?.(
          decision,
          this.routerContext(turnId, attempts, turnStartedAt, signal, sticky?.name),
        )
        const assistant = this.finish(current, decision, messageId)
        this.append(assistant)
        if (current.usage) {
          turnUsage.input += current.usage.input
          turnUsage.output += current.usage.output
          turnUsage.cacheRead += current.usage.cacheRead ?? 0
          turnUsage.cacheWrite += current.usage.cacheWrite ?? 0
          turnUsage.costUSD += current.usage.costUSD ?? 0
          this.#state = updateSession(this.#state, (draft) => {
            draft.cumulativeUsage.input += current.usage!.input
            draft.cumulativeUsage.output += current.usage!.output
            draft.cumulativeUsage.cacheRead =
              (draft.cumulativeUsage.cacheRead ?? 0) + (current.usage!.cacheRead ?? 0)
            draft.cumulativeUsage.cacheWrite =
              (draft.cumulativeUsage.cacheWrite ?? 0) + (current.usage!.cacheWrite ?? 0)
            draft.cumulativeUsage.costUSD += current.usage!.costUSD ?? 0
          })
        }
        if (current.stopReason) lastStopReason = current.stopReason
        await this.emit('stream.completed', turnId, {
          messageId: assistant.id,
          ...(current.usage ? { usage: current.usage } : {}),
        })
        await this.emit('message.appended', turnId, {
          messageId: assistant.id,
          role: assistant.role,
          content: toEventContent(assistant.content),
        })
        const toolUses = assistant.content.filter(
          (part): part is Extract<ContentPart, { type: 'tool_use' }> => part.type === 'tool_use',
        )
        if (toolUses.length === 0) break
        toolCalls += toolUses.length
        // 附录 D.2 tool.requested（§2.3 触发时机：assistant 输出 tool_use）——
        // 在任何执行/权限判定之前 emit，ui / hooks(PreToolUse) 订阅者可见。
        for (const tool of toolUses)
          await this.emit('tool.requested', turnId, {
            toolUseId: tool.id,
            tool: tool.name,
            input: tool.input,
          })
        const toolNames = new Map(toolUses.map((tool) => [tool.id, tool.name]))
        const results = await Promise.all(
          toolUses.map(async (tool) => {
            if (current.invalidTools.has(tool.id)) {
              // §3.2 rule 2：parse 失败的 tool_use 不执行，直接以固定格式的 error tool_result 返模型。
              const raw = current.tools.get(tool.id)?.raw ?? ''
              const invalid: ToolExecution = {
                toolUseId: tool.id,
                toolName: tool.name,
                content: [
                  {
                    type: 'text',
                    text: `Invalid JSON arguments for tool ${tool.name} (stream truncated?): ${raw.slice(0, 200)}...`,
                  },
                ],
                isError: true,
              }
              return invalid
            }
            await this.emit('tool.started', turnId, { toolUseId: tool.id, tool: tool.name })
            const startedAt = Date.now()
            const execution = await this.tools.execute(tool, signal)
            return { ...execution, durationMs: Date.now() - startedAt }
          }),
        )
        for (const result of results) {
          const message = this.message('user', [
            {
              type: 'tool_result',
              toolUseId: result.toolUseId,
              content: wrapUntrusted(
                result.content,
                `tool:${result.toolName ?? 'unknown'}`,
                result.toolUseId,
              ),
              ...(result.isError === undefined ? {} : { isError: result.isError }),
            },
          ])
          this.append(message)
          await this.emit('tool.completed', turnId, {
            toolUseId: result.toolUseId,
            tool: toolNames.get(result.toolUseId) ?? result.toolName ?? 'unknown',
            isError: result.isError ?? false,
            ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
            ...(result.linesAdded === undefined ? {} : { linesAdded: result.linesAdded }),
            ...(result.linesRemoved === undefined ? {} : { linesRemoved: result.linesRemoved }),
          })
          await this.emit('message.appended', turnId, {
            messageId: message.id,
            role: message.role,
            content: toEventContent(message.content),
          })
        }
      }
    } catch (error) {
      failed = true
      abortReason = 'error'
      await this.emit('error.raised', turnId, {
        code: 'runner_error',
        context: {
          message: error instanceof Error ? error.message : String(error),
          ...(decision ? { provider: decision.provider.name, model: decision.model } : {}),
        },
      })
    }
    const aborted = failed || signal.aborted || this.#state.pendingInterrupt
    this.#state = updateSession(this.#state, (draft) => {
      draft.activeTurn = null
      const turn = draft.turns.find((item) => item.id === turnId)
      if (turn) turn.status = aborted ? 'aborted' : 'done'
    })
    if (aborted)
      await this.emit('turn.aborted', turnId, {
        turnId,
        reason:
          abortReason === 'stream_interrupted'
            ? 'stream_interrupted'
            : failed
              ? 'error'
              : 'user_interrupt',
      })
    else {
      if (decision)
        this.#lastTurn = {
          provider: decision.provider.name,
          model: decision.model,
          ...(lastStopReason ? { stopReason: lastStopReason } : {}),
        }
      await this.emit('turn.completed', turnId, {
        turnId,
        usage: {
          input: turnUsage.input,
          output: turnUsage.output,
          cacheRead: turnUsage.cacheRead,
          cacheWrite: turnUsage.cacheWrite,
          costUSD: turnUsage.costUSD,
        },
        ...(lastStopReason ? { stopReason: lastStopReason } : {}),
      })
    }
    return this.#state
  }
  private exhaustedBudget(
    startedAt: number,
    toolCalls: number,
  ): 'token' | 'cost' | 'time' | 'tool-call' | undefined {
    const budget = this.options.budget ?? this.#state.resourceBudget
    if (!budget) return
    if (
      budget.tokenMax !== undefined &&
      this.#state.cumulativeUsage.input + this.#state.cumulativeUsage.output >= budget.tokenMax
    )
      return 'token'
    if (budget.costUSDMax !== undefined && this.#state.cumulativeUsage.costUSD >= budget.costUSDMax)
      return 'cost'
    if (budget.timeMsMax !== undefined && Date.now() - startedAt >= budget.timeMsMax) return 'time'
    if (budget.toolCallMax !== undefined && toolCalls >= budget.toolCallMax) return 'tool-call'
  }
  private routerContext(
    turnId: string,
    attemptCount: number,
    startedAt: number,
    signal: AbortSignal,
    stickyProvider?: string,
  ) {
    const budget = this.options.budget ?? this.#state.resourceBudget
    return {
      session: {
        id: this.#state.id,
        cumulativeCostUSD: this.#state.cumulativeUsage.costUSD,
        ...(stickyProvider === undefined ? {} : { stickyProvider }),
      },
      turnId,
      attemptCount,
      ...(budget
        ? {
            budget: {
              ...(budget.costUSDMax === undefined ? {} : { costUSDMax: budget.costUSDMax }),
              ...(budget.timeMsMax === undefined ? {} : { timeMsMax: budget.timeMsMax }),
            },
          }
        : {}),
      elapsedTimeMs: Date.now() - startedAt,
      signal,
    }
  }
  private message(role: Message['role'], content: ContentPart[]): Message {
    return { id: uuidv7(), role, content, createdAt: Date.now() }
  }
  private append(message: Message): void {
    this.#state = updateSession(this.#state, (draft) => {
      draft.messages = [...draft.messages, message]
    })
  }
  /**
   * 附录 D.2 payload 出口。payload 以普通对象传入（结构由 EventBus 出口的
   * EVENT_SCHEMAS[type].parse 强制，r13-I8：schema 为唯一裁判）。
   */
  private async emit(
    type: Parameters<EventBus['emit']>[0]['type'],
    turnId: string,
    payload: object,
  ): Promise<void> {
    await this.events.emit({
      type,
      version: this.#state.version,
      sessionId: this.#state.id,
      turnId,
      payload: payload as JsonValue,
    })
  }
  private merge(current: InProgress, chunk: ProviderChunk): void {
    if (chunk.kind === 'text.delta') current.text += chunk.text
    else if (chunk.kind === 'thinking.delta') current.thinking += chunk.text
    else if (chunk.kind === 'tool_use.start')
      current.tools.set(chunk.id, { id: chunk.id, name: chunk.name, fragments: [] })
    else if (chunk.kind === 'tool_use.delta') {
      current.tools.get(chunk.id)?.fragments.push(chunk.argsFragment)
    } else if (chunk.kind === 'tool_use.end') this.endToolUse(current, chunk.id)
    else if (chunk.kind === 'usage') current.usage = chunk.usage
    else if (chunk.kind === 'message.stop') current.stopReason = chunk.stopReason
  }
  /** §3.2 rule 1/2：合并全文，一次性 JSON.parse；失败仅标记 invalid，不在此构造 tool_result。 */
  private endToolUse(current: InProgress, id: string): void {
    const tool = current.tools.get(id)
    if (!tool || tool.ended) return
    tool.ended = true
    tool.raw = tool.fragments.join('')
    try {
      tool.input = JSON.parse(tool.raw) as JsonValue
    } catch {
      current.invalidTools.add(tool.id)
    }
  }
  private finish(current: InProgress, decision: RouterDecision, messageId: string): Message {
    const content: ContentPart[] = []
    if (current.thinking) content.push({ type: 'thinking', text: current.thinking })
    if (current.text) content.push({ type: 'text', text: current.text })
    for (const tool of current.tools.values()) {
      // 防御：provider 流缺 tool_use.end 就 message.stop 时，仍按累计片段定稿
      this.endToolUse(current, tool.id)
      content.push({
        type: 'tool_use',
        id: tool.id,
        name: tool.name,
        input: tool.input !== undefined ? tool.input : { parseError: true, raw: tool.raw ?? '' },
      })
    }
    const message: Message = { id: messageId, role: 'assistant', content, createdAt: Date.now() }
    message.meta = {
      provider: decision.provider.name,
      model: decision.model,
      ...(current.usage ? { usage: current.usage } : {}),
      ...(current.stopReason ? { stopReason: current.stopReason } : {}),
    }
    return message
  }
}

/**
 * 附录 D.2 stream.delta 的增量片段提取：只有 text/thinking/tool_use 三类 chunk 产生
 * delta 事件，其余 chunk（message.start/stop、usage、tool_use.start/end、interrupted、
 * error）不产生增量片段。
 */
function deltaFragment(
  chunk: ProviderChunk,
): { kind: 'text' | 'thinking' | 'tool_use'; text: string } | undefined {
  if (chunk.kind === 'text.delta') return { kind: 'text', text: chunk.text }
  if (chunk.kind === 'thinking.delta') return { kind: 'thinking', text: chunk.text }
  if (chunk.kind === 'tool_use.delta') return { kind: 'tool_use', text: chunk.argsFragment }
  return undefined
}

export function messagesForCapabilities(
  messages: readonly Message[],
  provider: string,
  capabilities: ProviderClient['capabilities'],
): readonly Message[] {
  let changed = false
  const mapped = messages.map((message) => {
    const content = message.content.flatMap((part): ContentPart[] => {
      if (part.type === 'image' && capabilities.vision === false) {
        changed = true
        return [
          {
            type: 'text',
            text: `[Attachment omitted: provider ${provider} does not support vision (${part.mime})]`,
          },
        ]
      }
      if (part.type === 'file' && capabilities.files === false) {
        changed = true
        return [
          {
            type: 'text',
            text: `[Attachment omitted: provider ${provider} does not support files (${part.filename}, ${part.mime})]`,
          },
        ]
      }
      return [part]
    })
    return content === message.content ? message : { ...message, content }
  })
  return changed ? mapped : messages
}

export function wrapUntrusted(
  parts: ContentPart[],
  source: string,
  toolUseId?: string,
): ContentPart[] {
  const escape = (text: string) =>
    text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const body = parts
    .map((part) => (part.type === 'text' ? part.text : JSON.stringify(part)))
    .join('\n')
  const id = toolUseId ? ` toolUseId="${escape(toolUseId)}"` : ''
  return [
    {
      type: 'text',
      text: `<untrusted source="${escape(source)}"${id}>\n${escape(body)}\n</untrusted>`,
    },
  ]
}
