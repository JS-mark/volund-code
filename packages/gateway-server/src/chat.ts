/**
 * OpenAI 兼容层：POST /v1/chat/completions → volund 单 runner turn。
 *
 * 映射规则（v1，文档与实现对齐）：
 * - messages 只允许文本（content 为 string 或 [{type:'text'}]）；图片等多模态
 *   part 一律 400 gateway_unsupported_content——附件能力走 WS 会话通道；
 * - 无 session_id：无状态模式，整段消息渲染成 `[role]\n内容` 逐字稿作为单个
 *   prompt，新起一次性会话（turn 结束即 detach，session jsonl 仍可经
 *   x-volund-session-id 返回的 id resume）；
 * - 有 session_id：续接模式，只取最后一条 user 消息作为本轮 prompt；会话历史
 *   由 runner 持有。指向的会话不存在 → 404 gateway_session_not_found；
 * - model：含 '/' 视为 volund 全限定 id（provider/model）；不含则补默认
 *   provider 前缀；缺省走 volund 当前生效模型；
 * - stream:true → SSE（chat.completion.chunk）；false → 聚合一次返回；
 * - volund 工具调用在服务端执行，不进 OpenAI tool_calls 字段（agent 语义）。
 */
import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'

import type { GatewayHubLike } from './hub'
import { GatewayError, TurnQueue } from './queue'

export interface ChatCompletionParsed {
  readonly prompt: string
  readonly model: string | undefined
  readonly stream: boolean
  readonly sessionId: string | undefined
  readonly includeUsage: boolean
}

interface MessagePart {
  type?: unknown
  text?: unknown
}

function textOf(content: unknown, index: number): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content as MessagePart[]) {
      if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
        parts.push(part.text)
      else
        throw new GatewayError(
          'gateway_unsupported_content',
          400,
          `messages[${index}]: only text content parts are supported`,
        )
    }
    return parts.join('\n')
  }
  throw new GatewayError(
    'gateway_schema_invalid',
    400,
    `messages[${index}].content must be a string or content parts`,
  )
}

/** body 校验 + prompt 渲染；所有拒绝都是 400/409 级别的 GatewayError。 */
export function parseChatCompletionBody(
  body: unknown,
  options: { resolveModel: (model: string) => string },
): ChatCompletionParsed {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new GatewayError('gateway_schema_invalid', 400, 'request body must be a JSON object')
  const input = body as Record<string, unknown>
  const messages = input.messages
  if (!Array.isArray(messages) || messages.length === 0)
    throw new GatewayError('gateway_schema_invalid', 400, 'messages must be a non-empty array')
  const rendered: { role: string; text: string }[] = []
  for (const [index, message] of messages.entries()) {
    if (!message || typeof message !== 'object')
      throw new GatewayError('gateway_schema_invalid', 400, `messages[${index}] must be an object`)
    const entry = message as { role?: unknown; content?: unknown }
    if (typeof entry.role !== 'string' || !entry.role)
      throw new GatewayError('gateway_schema_invalid', 400, `messages[${index}].role is required`)
    rendered.push({ role: entry.role, text: textOf(entry.content, index) })
  }
  const sessionId =
    typeof input.session_id === 'string' && input.session_id ? input.session_id : undefined
  if (input.session_id !== undefined && sessionId === undefined)
    throw new GatewayError('gateway_schema_invalid', 400, 'session_id must be a non-empty string')
  let model: string | undefined
  if (typeof input.model === 'string' && input.model) model = options.resolveModel(input.model)
  const stream = input.stream === true
  const streamOptions = input.stream_options
  const includeUsage = Boolean(
    streamOptions &&
    typeof streamOptions === 'object' &&
    (streamOptions as { include_usage?: unknown }).include_usage === true,
  )
  // 续接模式只取最后一条 user 消息；无状态模式渲染整段逐字稿。
  const prompt = sessionId
    ? (() => {
        const lastUser = [...rendered].reverse().find((message) => message.role === 'user')
        if (!lastUser || !lastUser.text.trim())
          throw new GatewayError(
            'gateway_schema_invalid',
            400,
            'a non-empty user message is required',
          )
        return lastUser.text
      })()
    : rendered.map((message) => `[${message.role}]\n${message.text}`).join('\n\n')
  return { prompt, model, stream, sessionId, includeUsage }
}

export interface TurnOutcome {
  readonly status: 'completed' | 'aborted' | 'failed'
  readonly text: string
  readonly usage:
    | { input: number; output: number; cacheRead?: number; cacheWrite?: number; costUSD?: number }
    | undefined
  readonly detail: string | undefined
}

/**
 * 订阅 hub 事件流直至本 turn 终态（turn.completed / turn.aborted / view turn.failed）。
 * 单 runner 模型下同一时间只有一个在途 turn，不需按 turnId 区分。
 */
export function observeTurn(
  hub: GatewayHubLike,
  onDelta?: (text: string) => void,
): { done: Promise<TurnOutcome>; detach(): void } {
  let text = ''
  // error.raised 不是终态（runner 可能重试）；turn.aborted(reason≠user_interrupt)
  // 时把最近一条 error 作为失败详情透出——否则客户端只能拿到空的 200。
  let lastError: string | undefined
  let resolve!: (outcome: TurnOutcome) => void
  const done = new Promise<TurnOutcome>((res) => {
    resolve = res
  })
  const detach = hub.subscribe((envelope) => {
    const event = envelope.event as { type?: unknown; payload?: unknown }
    if (!event || typeof event.type !== 'string') return
    if (envelope.kind === 'core' && event.type === 'stream.delta') {
      const payload = event.payload as { kind?: unknown; fragment?: unknown }
      if (payload?.kind === 'text' && typeof payload.fragment === 'string') {
        text += payload.fragment
        onDelta?.(payload.fragment)
      }
      return
    }
    if (envelope.kind === 'core' && event.type === 'error.raised') {
      const payload = event.payload as { code?: unknown; context?: { message?: unknown } }
      const message = payload?.context?.message
      lastError =
        typeof message === 'string'
          ? message
          : typeof payload?.code === 'string'
            ? payload.code
            : 'unknown runner error'
      return
    }
    if (envelope.kind === 'core' && event.type === 'turn.completed') {
      const payload = event.payload as { usage?: TurnOutcome['usage'] }
      resolve({ status: 'completed', text, usage: payload?.usage, detail: undefined })
      return
    }
    if (envelope.kind === 'core' && event.type === 'turn.aborted') {
      const payload = event.payload as { reason?: unknown }
      const reason = typeof payload?.reason === 'string' ? payload.reason : undefined
      if (reason === 'user_interrupt') {
        resolve({ status: 'aborted', text, usage: undefined, detail: reason })
        return
      }
      resolve({
        status: 'failed',
        text,
        usage: undefined,
        detail: lastError ?? reason ?? 'turn aborted',
      })
      return
    }
    if (envelope.kind === 'view' && event.type === 'turn.failed') {
      const payload = event as { message?: unknown }
      resolve({
        status: 'failed',
        text,
        usage: undefined,
        detail: typeof payload.message === 'string' ? payload.message : 'turn failed',
      })
    }
  })
  return { done, detach }
}

/** hub 异常 → 网关状态码（resume 的 "Session not found" 是纯 Error，按消息归类 404）。 */
export function classifyHubError(cause: unknown): GatewayError {
  if (cause instanceof GatewayError) return cause
  const message = cause instanceof Error ? cause.message : String(cause)
  const code = (cause as { code?: unknown } | undefined)?.code
  if (code === 'session_turn_in_progress' || /busy|in flight/i.test(message))
    return new GatewayError('gateway_session_busy', 409, message)
  if (/not found|invalid session/i.test(message))
    return new GatewayError('gateway_session_not_found', 404, message)
  return new GatewayError('gateway_upstream_failed', 502, message)
}

function writeSse(res: ServerResponse, data: string): void {
  // 客户端已断开（或响应已结束）时静默丢弃——observeTurn 的终态由 hub 事件驱动，
  // 与 socket 生命周期解耦。
  if (res.writableEnded || res.destroyed) return
  res.write(`data: ${data}\n\n`)
}

function openAiUsage(usage: TurnOutcome['usage']) {
  if (!usage) return undefined
  return {
    prompt_tokens: usage.input,
    completion_tokens: usage.output,
    total_tokens: usage.input + usage.output,
  }
}

export interface ChatHandlerDeps {
  readonly hub: GatewayHubLike
  readonly queue: TurnQueue
  readonly workspaceCwd: string
  /** model 名归一（别名→全限定、裸名→补 provider 前缀）；由装配侧注入。 */
  readonly resolveModel: (model: string) => string
  readonly queueTimeoutMs: number
  /** 客户端断开时是否 interrupt 在途 turn（默认 true）。 */
  readonly interruptOnDisconnect?: boolean
}

/**
 * chat/completions 主流程。写响应前的失败抛 GatewayError（路由层映射 JSON 错误）；
 * SSE 已开始后的失败落成 `data: {"error": ...}` + [DONE]。
 */
export async function handleChatCompletion(
  deps: ChatHandlerDeps,
  body: unknown,
  res: ServerResponse,
  disconnectSignal: { disconnected: () => boolean; onDisconnect(listener: () => void): void },
): Promise<void> {
  const parsed = parseChatCompletionBody(body, { resolveModel: deps.resolveModel })
  const release = await deps.queue.acquire(deps.queueTimeoutMs)
  const requestId = `chatcmpl-${randomUUID().replaceAll('-', '').slice(0, 24)}`
  const created = Math.floor(Date.now() / 1000)
  const modelForPayload = parsed.model ?? 'volund/default'
  let sseStarted = false
  let oneShot = false
  try {
    if (parsed.sessionId) {
      if (deps.hub.active && deps.hub.active.id !== parsed.sessionId)
        throw new GatewayError(
          'gateway_session_busy',
          409,
          'a different session is active on this gateway',
        )
      if (!deps.hub.active)
        await deps.hub.resume(parsed.sessionId).catch((cause) => {
          throw classifyHubError(cause)
        })
    } else {
      if (deps.hub.active)
        throw new GatewayError(
          'gateway_session_busy',
          409,
          'an interactive session is active; pass its session_id or end it first',
        )
      await deps.hub.start({ cwd: deps.workspaceCwd }).catch((cause) => {
        throw classifyHubError(cause)
      })
      oneShot = true
    }
    const sessionId = deps.hub.active?.id

    if (parsed.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        ...(sessionId ? { 'x-volund-session-id': sessionId } : {}),
      })
      sseStarted = true
      writeSse(
        res,
        JSON.stringify({
          id: requestId,
          object: 'chat.completion.chunk',
          created,
          model: modelForPayload,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        }),
      )
    }

    const observer = observeTurn(
      deps.hub,
      parsed.stream
        ? (fragment) =>
            writeSse(
              res,
              JSON.stringify({
                id: requestId,
                object: 'chat.completion.chunk',
                created,
                model: modelForPayload,
                choices: [{ index: 0, delta: { content: fragment }, finish_reason: null }],
              }),
            )
        : undefined,
    )
    const interruptOnDisconnect = deps.interruptOnDisconnect !== false
    const onDisconnect = () => {
      if (interruptOnDisconnect) void deps.hub.interrupt().catch(() => {})
    }
    disconnectSignal.onDisconnect(onDisconnect)
    try {
      await deps.hub
        .submit({
          prompt: parsed.prompt,
          ...(parsed.model ? { model: parsed.model } : {}),
        })
        .catch((cause) => {
          throw classifyHubError(cause)
        })
    } catch (error) {
      observer.detach()
      throw error
    }
    const outcome = await observer.done
    observer.detach()

    if (parsed.stream) {
      if (outcome.status === 'failed') {
        writeSse(
          res,
          JSON.stringify({
            error: { code: 'gateway_upstream_failed', message: outcome.detail ?? 'turn failed' },
          }),
        )
      } else {
        writeSse(
          res,
          JSON.stringify({
            id: requestId,
            object: 'chat.completion.chunk',
            created,
            model: modelForPayload,
            // 中断与正常结束都落 'stop'——中断细节经 x-volund-finish / 帧内 error 区分。
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }),
        )
        if (parsed.includeUsage)
          writeSse(
            res,
            JSON.stringify({
              id: requestId,
              object: 'chat.completion.chunk',
              created,
              model: modelForPayload,
              choices: [],
              usage: openAiUsage(outcome.usage) ?? null,
            }),
          )
      }
      writeSse(res, '[DONE]')
      res.end()
      return
    }

    if (outcome.status === 'failed')
      throw new GatewayError('gateway_upstream_failed', 502, outcome.detail ?? 'turn failed')
    const responseBody = JSON.stringify({
      id: requestId,
      object: 'chat.completion',
      created,
      model: modelForPayload,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: outcome.text },
          finish_reason: 'stop',
        },
      ],
      usage: openAiUsage(outcome.usage) ?? null,
    })
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(responseBody),
      ...(sessionId ? { 'x-volund-session-id': sessionId } : {}),
      ...(outcome.status === 'aborted' ? { 'x-volund-finish': 'aborted' } : {}),
    })
    res.end(responseBody)
  } catch (error) {
    const failure = classifyHubError(error)
    if (sseStarted) {
      // 流已开始：错误只能作为流内错误帧下发。
      writeSse(res, JSON.stringify({ error: { code: failure.code, message: failure.message } }))
      writeSse(res, '[DONE]')
      res.end()
      return
    }
    throw failure
  } finally {
    if (oneShot) await deps.hub.closeActive().catch(() => {})
    release()
  }
}
