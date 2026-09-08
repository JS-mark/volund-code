/**
 * 会话事件流 reducer（§22.8.3）：SSE 信封 + 本地动作 → 聊天视图的唯一状态源。
 * 幂等去重以 (cursor) 为键；stream.delta 只追加（不落盘，刷新以 transcript 为准）。
 *
 * 渲染侧只允许消费本 hook 的 state——此前 SSE state 与 Chat 本地 state 双轨并行
 * （流式消息进了 stream、渲染读 local），是「发消息后无响应」的根因，勿再分叉。
 */
import { useCallback, useEffect, useReducer, useRef } from 'react'

export interface ChatImage {
  chip: string
  mime: string
  /** 本地乐观回显的预览（blob objectURL）；transcript 回放只有 chip 文本。 */
  previewUrl?: string
}

export interface ChatMessage {
  id: string
  role: 'assistant' | 'system' | 'user'
  text: string
  streaming?: boolean
  images?: ChatImage[]
  /** 本地乐观回显（未收口）：message.appended 到达后由真实消息替换。 */
  local?: boolean
}

export interface ToolCard {
  toolUseId: string
  tool: string
  status: 'running' | 'done' | 'error'
}

export interface PermissionCard {
  id: string
  attempt: number
  display: { approvable: boolean; spec: string; toolName: string }
}

export interface ChatState {
  messages: ChatMessage[]
  tools: ToolCard[]
  turn: 'idle' | 'running'
  /** turn.completed 的 usage 形状（core）：{input, output, cacheRead, cacheWrite, costUSD}。 */
  usage:
    | {
        input: number
        output: number
        cacheRead?: number
        cacheWrite?: number
        costUSD: number | null
      }
    | undefined
  permission: PermissionCard | undefined
  notice: string | undefined
}

export const initialChatState: ChatState = {
  messages: [],
  tools: [],
  turn: 'idle',
  usage: undefined,
  permission: undefined,
  notice: undefined,
}

type Envelope = {
  streamVersion: number
  cursor: string
  kind: 'core' | 'view' | 'control'
  sessionId?: string
  event: {
    type: string
    payload: Record<string, unknown>
  }
}

/** 视图动作：SSE 信封之外的状态入口（transcript 水合 / 乐观回显 / 本地提示）。 */
export type StreamAction =
  | { type: 'envelope'; envelope: Envelope }
  | { type: 'hydrate'; transcript: readonly unknown[] }
  | { type: 'echo'; text: string; images: ChatImage[] }
  | { type: 'notice'; notice: string | undefined }
  | { type: 'reset' }

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      typeof part === 'object' && part !== null && (part as { text?: unknown }).text
        ? String((part as { text: unknown }).text)
        : '',
    )
    .join('')
}

function reduceEnvelope(state: ChatState, envelope: Envelope): ChatState {
  const { event } = envelope
  const payload = event.payload ?? {}
  switch (event.type) {
    case 'message.appended': {
      const id = String(payload.messageId)
      const text = textOfContent(payload.content)
      const role = payload.role as ChatMessage['role']
      // 真实 user 消息到达 = 乐观回显已收口：清掉 local 回声，避免双份。
      const base =
        role === 'user' ? state.messages.filter((message) => !message.local) : state.messages
      // 流式中已存在的同 id 流式消息：以持久化完整消息收口。
      const messages = base.some((message) => message.id === id)
        ? base.map((message) =>
            message.id === id ? { ...message, text, streaming: false } : message,
          )
        : [...base, { id, role, text }]
      return { ...state, messages }
    }
    case 'stream.delta': {
      if (payload.kind !== 'text') return state
      const id = String(payload.messageId)
      const fragment = String(payload.fragment)
      const messages = state.messages.some((message) => message.id === id)
        ? state.messages.map((message) =>
            message.id === id
              ? { ...message, text: message.text + fragment, streaming: true }
              : message,
          )
        : [...state.messages, { id, role: 'assistant' as const, text: fragment, streaming: true }]
      return { ...state, messages }
    }
    case 'stream.completed': {
      const id = String(payload.messageId)
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === id ? { ...message, streaming: false } : message,
        ),
      }
    }
    case 'turn.started':
      return { ...state, turn: 'running', usage: undefined }
    case 'turn.completed':
      return {
        ...state,
        turn: 'idle',
        usage: payload.usage as ChatState['usage'],
      }
    case 'turn.aborted': {
      // reason=error 时 error.raised 通常已给出具体原因，不覆盖；
      // user_interrupt 才是「用户中断」语义。
      const reason = payload.reason
      if (reason === 'error')
        return { ...state, turn: 'idle', notice: state.notice ?? '本轮因错误中止' }
      if (reason === 'stream_interrupted')
        return { ...state, turn: 'idle', notice: state.notice ?? '本轮流式中断' }
      return { ...state, turn: 'idle', notice: '本轮已中断' }
    }
    case 'tool.started':
      return {
        ...state,
        tools: [
          ...state.tools.filter((tool) => tool.toolUseId !== payload.toolUseId),
          { toolUseId: String(payload.toolUseId), tool: String(payload.tool), status: 'running' },
        ],
      }
    case 'tool.completed': {
      const id = String(payload.toolUseId)
      const failed = payload.isError === true
      return {
        ...state,
        tools: state.tools.map((tool) =>
          tool.toolUseId === id ? { ...tool, status: failed ? 'error' : 'done' } : tool,
        ),
      }
    }
    case 'error.raised': {
      // runner 的错误载荷是 {code, context:{message?}}（附录 D）——message 在 context 里。
      const context = payload.context as { message?: unknown } | undefined
      const detail = context?.message ?? payload.message ?? ''
      return {
        ...state,
        notice: `错误 ${String(payload.code ?? '')}: ${String(detail)}`,
      }
    }
    default:
      break
  }
  if (envelope.kind === 'view') {
    const view = event as unknown as { type: string; request?: PermissionCard; message?: string }
    if (view.type === 'permission.request' && view.request)
      return { ...state, permission: view.request }
    if (view.type === 'permission.resolved') return { ...state, permission: undefined }
    if (view.type === 'turn.failed')
      return { ...state, turn: 'idle', notice: view.message ?? 'turn 失败' }
    if (view.type === 'session.attached') return { ...initialChatState, notice: '已连接会话' }
  }
  return state
}

/** 聊天状态的总归约（SSE 信封 + 视图动作）；导出供单测直驱。 */
export function reduceChatState(state: ChatState, action: StreamAction): ChatState {
  // control 帧（hello/heartbeat）不是业务信封：reducer 在 dispatch 后异步执行，
  // 这里的形状守卫必须在管道入口（try/catch 兜不住 useReducer 的延迟求值）。
  if (action.type === 'envelope') {
    const event = (action.envelope as Partial<Envelope>).event
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return state
    return reduceEnvelope(state, action.envelope)
  }
  switch (action.type) {
    case 'hydrate': {
      // 合并而非整体替换：hydrate 与 SSE 并发（会话刚创建即发消息）时，
      // 快照后到达的 message.appended/stream.delta 不能被 transcript 冲掉；
      // 本地回声一律丢弃——其真实副本要么已在快照里，要么会经 appended 到达。
      const messages: ChatMessage[] = []
      for (const entry of action.transcript) {
        const item = entry as { id?: string; role?: string; text?: string }
        if (item.id && item.role && item.text)
          messages.push({ id: item.id, role: item.role as ChatMessage['role'], text: item.text })
      }
      const hydratedIds = new Set(messages.map((message) => message.id))
      const tail = state.messages.filter(
        (message) => !message.local && !hydratedIds.has(message.id),
      )
      return { ...state, messages: [...messages, ...tail] }
    }
    case 'echo':
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: `local-${Date.now()}`,
            role: 'user',
            text: action.text,
            ...(action.images.length ? { images: action.images } : {}),
            local: true,
          },
        ],
      }
    case 'notice':
      return { ...state, notice: action.notice }
    case 'reset':
      return initialChatState
  }
}

export interface SessionStream {
  state: ChatState
  echo(text: string, images: ChatImage[]): void
  hydrate(transcript: readonly unknown[]): void
  setNotice(notice: string | undefined): void
  reset(): void
}

/**
 * 订阅 /api/v1/events 并归约为聊天状态（引用稳定：仅在事件到达时更新）。
 * sessionId 过滤掉残留信封（单活动会话模型下 attach 前后的旧会话事件）。
 */
export function useSessionStream(enabled: boolean, sessionId: string | undefined): SessionStream {
  const [state, dispatch] = useReducer(reduceChatState, initialChatState)
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId

  useEffect(() => {
    if (!enabled) return
    const source = new EventSource('/api/v1/events')
    const handler = (raw: MessageEvent) => {
      try {
        const data = JSON.parse(raw.data as string) as Partial<Envelope>
        // hello/heartbeat 等控制帧不是业务信封：不进 reducer。
        if (!data || typeof data !== 'object' || !('event' in data)) return
        const envelope = data as Envelope
        const wanted = sessionRef.current
        if (wanted && envelope.sessionId && envelope.sessionId !== wanted) return
        dispatch({ type: 'envelope', envelope })
      } catch {
        // 无法解析的帧忽略。
      }
    }
    source.addEventListener('core', handler as EventListener)
    source.addEventListener('view', handler as EventListener)
    source.addEventListener('control', handler as EventListener)
    return () => source.close()
  }, [enabled])

  return {
    state,
    echo: useCallback(
      (text: string, images: ChatImage[]) => dispatch({ type: 'echo', text, images }),
      [],
    ),
    hydrate: useCallback(
      (transcript: readonly unknown[]) => dispatch({ type: 'hydrate', transcript }),
      [],
    ),
    setNotice: useCallback(
      (notice: string | undefined) => dispatch({ type: 'notice', notice }),
      [],
    ),
    reset: useCallback(() => dispatch({ type: 'reset' }), []),
  }
}

/** 从 transcript 快照恢复（刷新场景）——保留导出兼容既有引用，内部走 hydrate。 */
export function hydrateFromTranscript(state: ChatState, transcript: readonly unknown[]): ChatState {
  return reduceChatState(state, { type: 'hydrate', transcript })
}
