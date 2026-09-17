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
  mime?: string
  /** 本地乐观回显的预览（blob objectURL）；transcript 水合/跨端消息没有它。 */
  previewUrl?: string
  /**
   * AttachmentStore 内容寻址引用——无 previewUrl 时经
   * GET /api/v1/sessions/active/attachments/:handle 取字节。
   */
  handle?: string
}

/** 回显图片的加载地址：本地预览优先；handle 引用走同源附件字节端点。 */
export function chatImageSrc(image: ChatImage): string | undefined {
  if (image.previewUrl) return image.previewUrl
  if (image.handle) return `/api/v1/sessions/active/attachments/${encodeURIComponent(image.handle)}`
  return undefined
}

export interface ChatMessage {
  id: string
  role: 'assistant' | 'system' | 'user'
  text: string
  streaming?: boolean
  images?: ChatImage[]
  /** 本地乐观回显（未收口）：message.appended 到达后由真实消息替换。 */
  local?: boolean
  /**
   * 到达本页的时间（ms 纪元）：live 事件/乐观回显打点，用于时间分隔行。
   * transcript 水合的历史消息没有时间戳（条目本就不带），不渲染分隔行。
   */
  at?: number
}

export interface ToolCard {
  toolUseId: string
  tool: string
  status: 'running' | 'done' | 'error'
  /**
   * Task 卡：派发时所在父 turn 的 id（CoreEvent.turnId）——子代理冒泡事件按
   * parentTurnId 归属到本卡（§2.7bis.5 U3 折叠行的连接键）。
   */
  turnId?: string
  /** Task 卡：tool.requested input 的展示摘要（agentType / prompt 首行）。 */
  task?: { agentType?: string; prompt?: string }
}

/**
 * 一个 Task 派发下的子代理活动聚合（key = 父 turnId，即冒泡事件的 parentTurnId）。
 * 只从冒泡 tool.* 事件累积——子代理的消息/流式/turn 事件不进主聊天流。
 */
export interface SubagentActivity {
  /** 子代理已启动的工具调用数（冒泡 tool.started 计数）。 */
  toolCalls: number
  /** 仍在运行的子代理工具数（started − completed，下界 0）。 */
  running: number
  /** 最近启动的子代理工具名（折叠行的「当前工具」）。 */
  lastTool?: string
}

/**
 * §2.7bis.5 U4 审批归属：发起权限请求的会话是子代理时携带（主代理省略）。
 * gateway 盲转透传同一字段；卡面据此渲染「子代理 · <agentType>」徽标。
 */
export interface PermissionLineage {
  sessionId: string
  agentType?: string
  parentTurnId?: string
}

export interface PermissionCard {
  id: string
  attempt: number
  display: { approvable: boolean; spec: string; toolName: string }
  /** 子代理来源（§2.7bis.5 U4）；主代理请求省略——无徽标回归面。 */
  lineage?: PermissionLineage
}

export interface ChatState {
  messages: ChatMessage[]
  tools: ToolCard[]
  /** 子代理活动聚合（key = 父 turnId）——Task 折叠行的数据源（§2.7bis.5 U3）。 */
  subagents: Record<string, SubagentActivity>
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
  /**
   * 会话权限档位（ask/auto/full）：唯一来源是本 reducer——挂载/切会话拉取 +
   * SSE permission.mode 帧同写这里（TUI /mode、他端选择器、权限卡 g 授权全同步）。
   */
  permissionMode: 'ask' | 'auto' | 'full' | undefined
  notice: string | undefined
}

export const initialChatState: ChatState = {
  messages: [],
  tools: [],
  subagents: {},
  turn: 'idle',
  usage: undefined,
  permission: undefined,
  permissionMode: undefined,
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
    /** CoreEvent 的 turnId——Task 卡与冒泡事件的归属键（tool.requested/started 携带）。 */
    turnId?: string
    /** 附录 D.3 子代理冒泡 tag：EventBus.forward 打上，两字段同时出现（§2.7bis.5 U3）。 */
    parentTurnId?: string
    parentDepth?: number
  }
}

/** 视图动作：SSE 信封之外的状态入口（trаnscript 水合 / 乐观回显 / 本地提示）。 */
export type StreamAction =
  | { type: 'envelope'; envelope: Envelope }
  | { type: 'hydrate'; transcript: readonly unknown[] }
  | { type: 'echo'; text: string; images: ChatImage[] }
  | { type: 'notice'; notice: string | undefined }
  /** mode 原样传入（string）；非法值在 reducer 内忽略。 */
  | { type: 'permission-mode'; mode: string }
  | { type: 'reset' }

/** 只取 text part——thinking part 也有 text 字段，混进来会把思考内容粘进正文。 */
function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
        ? String((part as { text?: unknown }).text ?? '')
        : '',
    )
    .join('')
}

/** [image: <digest8>.<ext>]——与 @volund/shared attachmentChipLabel 同规则的本地副本。 */
function chipFromHandle(handle: string): string {
  const dot = handle.lastIndexOf('.')
  const digest = dot > 0 ? handle.slice(0, dot) : handle
  const ext = dot > 0 ? handle.slice(dot + 1) : ''
  return `[image: ${digest.slice(0, 8)}${ext ? `.${ext}` : ''}]`
}

/** message.appended content 的 image part → 回显图片（仅 handle 引用式可取字节）。 */
function imagesOfContent(content: unknown): ChatImage[] {
  if (!Array.isArray(content)) return []
  const images: ChatImage[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const candidate = part as { type?: unknown; source?: unknown; mime?: unknown }
    if (candidate.type !== 'image') continue
    const source = candidate.source as { kind?: unknown; handle?: unknown } | undefined
    if (source?.kind !== 'handle' || typeof source.handle !== 'string') continue
    images.push({
      chip: chipFromHandle(source.handle),
      handle: source.handle,
      ...(typeof candidate.mime === 'string' ? { mime: candidate.mime } : {}),
    })
  }
  return images
}

/**
 * §2.7bis.5 U3 / 附录 D.3：子代理冒泡事件的归约——不碰消息流/工具列表/turn 状态
 * （对齐 TUI app.tsx 的过滤），只把 tool.* 聚合进 subagents（Task 折叠行的数据源）。
 * 归属键 = parentTurnId（父 turnId，与 Task 卡 tool.started 的 event.turnId 相同）。
 */
function reduceBubbledEvent(state: ChatState, event: Envelope['event']): ChatState {
  const { parentTurnId } = event
  if (!parentTurnId) return state
  const payload = event.payload ?? {}
  switch (event.type) {
    case 'tool.started': {
      const current = state.subagents[parentTurnId] ?? { toolCalls: 0, running: 0 }
      const activity: SubagentActivity = {
        ...current,
        toolCalls: current.toolCalls + 1,
        running: current.running + 1,
        lastTool: typeof payload.tool === 'string' ? payload.tool : '',
      }
      return { ...state, subagents: { ...state.subagents, [parentTurnId]: activity } }
    }
    case 'tool.completed': {
      const current = state.subagents[parentTurnId]
      if (!current) return state
      return {
        ...state,
        subagents: {
          ...state.subagents,
          [parentTurnId]: { ...current, running: Math.max(0, current.running - 1) },
        },
      }
    }
    default:
      return state
  }
}

function reduceEnvelope(state: ChatState, envelope: Envelope): ChatState {
  const { event } = envelope
  const payload = event.payload ?? {}
  // §2.7bis.5 U3：子代理冒泡事件（附录 D.3 tag）不进主聊天流——stream.delta 不再
  // 混成无标注的 assistant 气泡，tool.* 不再平铺进工具卡列表，turn.* 不再拨动主
  // 会话的 turn 状态；tool.* 聚合到对应 Task 卡的折叠行。主会话事件无 tag，不受影响。
  if ('parentTurnId' in event || (event.parentDepth ?? 0) > 0)
    return reduceBubbledEvent(state, event)
  switch (event.type) {
    case 'message.appended': {
      const id = String(payload.messageId)
      const text = textOfContent(payload.content)
      const role = payload.role as ChatMessage['role']
      const contentImages = imagesOfContent(payload.content)
      // 无可见内容的消息（tool_use-only 的 assistant、tool_result 的 user）不产生
      // 空气泡——工具活动由工具卡承担；已有同 id 流式气泡照常收口。
      const exists = state.messages.some((message) => message.id === id)
      if (!exists && !text && contentImages.length === 0) return state
      // 真实 user 消息到达 = 乐观回显已收口：清掉 local 回声，但把最早一条回声带的
      // 图片转交给确认消息（否则图片一闪即没）；无回声的消息（跨端/重放）从
      // content 的 image part 取 handle 引用，经附件字节端点按需加载。
      const echoImages =
        role === 'user'
          ? state.messages.find((message) => message.local && message.images?.length)?.images
          : undefined
      const base =
        role === 'user' ? state.messages.filter((message) => !message.local) : state.messages
      const images = echoImages?.length ? echoImages : contentImages
      // 流式中已存在的同 id 流式消息：以持久化完整消息收口（保留到达时间）。
      const messages = exists
        ? base.map((message) =>
            message.id === id
              ? { ...message, text, streaming: false, ...(images.length ? { images } : {}) }
              : message,
          )
        : [...base, { id, role, text, at: Date.now(), ...(images.length ? { images } : {}) }]
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
        : [
            ...state.messages,
            { id, role: 'assistant' as const, text: fragment, streaming: true, at: Date.now() },
          ]
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
    case 'tool.requested': {
      // 只摘 Task 的 input 摘要（agentType / prompt 首行）供折叠行展示；其他工具
      // 的 requested 帧不产生卡片（卡片由 tool.started 建立，保持既有时序语义）。
      if (payload.tool !== 'Task') return state
      const input: unknown = payload.input
      const record = input !== null && typeof input === 'object' ? input : undefined
      const agentType =
        record && 'agentType' in record && typeof record.agentType === 'string'
          ? record.agentType
          : undefined
      const prompt =
        record && 'prompt' in record && typeof record.prompt === 'string'
          ? record.prompt
          : undefined
      const task: ToolCard['task'] = {
        ...(agentType ? { agentType } : {}),
        ...(prompt ? { prompt: prompt.split('\n', 1)[0]!.slice(0, 80) } : {}),
      }
      const exists = state.tools.some((tool) => tool.toolUseId === payload.toolUseId)
      if (exists)
        return {
          ...state,
          tools: state.tools.map((tool) =>
            tool.toolUseId === payload.toolUseId ? { ...tool, task } : tool,
          ),
        }
      return {
        ...state,
        tools: [
          ...state.tools,
          { toolUseId: String(payload.toolUseId), tool: 'Task', status: 'running', task },
        ],
      }
    }
    case 'tool.started': {
      // turnId 只在 Task 卡上是归属键，但顺手全记——数据来自 CoreEvent 顶层，零成本。
      const turnId = typeof event.turnId === 'string' ? event.turnId : undefined
      const exists = state.tools.some((tool) => tool.toolUseId === payload.toolUseId)
      if (exists)
        return {
          ...state,
          tools: state.tools.map((tool) =>
            tool.toolUseId === payload.toolUseId
              ? { ...tool, status: 'running', ...(turnId ? { turnId } : {}) }
              : tool,
          ),
        }
      return {
        ...state,
        tools: [
          ...state.tools,
          {
            toolUseId: String(payload.toolUseId),
            tool: String(payload.tool),
            status: 'running',
            ...(turnId ? { turnId } : {}),
          },
        ],
      }
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
      // runner 的错误载荷是 {code, context}（附录 D）：runner_error 的细节在
      // context.message，stream_interrupted 的在 context.reason——两个键都要兜。
      const context = payload.context as { message?: unknown; reason?: unknown } | undefined
      const detail = context?.message ?? context?.reason ?? payload.message ?? ''
      return {
        ...state,
        notice: `错误 ${String(payload.code ?? '')}: ${String(detail)}`,
      }
    }
    default:
      break
  }
  if (envelope.kind === 'view') {
    const view = event as unknown as {
      type: string
      request?: PermissionCard
      message?: string
      mode?: unknown
    }
    if (view.type === 'permission.request' && view.request)
      return { ...state, permission: view.request }
    if (view.type === 'permission.resolved') return { ...state, permission: undefined }
    if (view.type === 'permission.mode') {
      if (view.mode === 'ask' || view.mode === 'auto' || view.mode === 'full')
        return { ...state, permissionMode: view.mode }
      return state
    }
    if (view.type === 'turn.failed')
      return { ...state, turn: 'idle', notice: view.message ?? 'turn 失败' }
    // 会话重挂（TUI 侧 resume 等）：聊天状态归零，但进程级权限档位保留
    // （SSE permission.mode 帧会持续纠正，不需要随会话切换清空）。
    if (view.type === 'session.attached')
      return { ...initialChatState, permissionMode: state.permissionMode, notice: '已连接会话' }
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
        const item = entry as {
          id?: string
          role?: string
          text?: string
          attachments?: readonly { chip?: string; kind?: string; mime?: string; handle?: string }[]
        }
        if (!item.id || !item.role || !item.text) continue
        // 图片附件：handle 在 → 渲染真图并剥掉 text 里的 chip 占位；无 handle
        // （path 引用）字节不可回放，保留 chip 文本兜底。
        const attachments = (item.attachments ?? []).filter(
          (attachment): attachment is { chip: string; mime?: string; handle: string } =>
            attachment.kind === 'image' &&
            typeof attachment.handle === 'string' &&
            typeof attachment.chip === 'string',
        )
        let text = item.text
        for (const attachment of attachments) text = text.split(attachment.chip).join(' ')
        const images: ChatImage[] = attachments.map((attachment) => ({
          chip: attachment.chip,
          handle: attachment.handle,
          ...(attachment.mime ? { mime: attachment.mime } : {}),
        }))
        messages.push({
          id: item.id,
          role: item.role as ChatMessage['role'],
          text: text.replace(/[^\S\n]+/g, ' ').trim(),
          ...(images.length ? { images } : {}),
        })
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
            at: Date.now(),
            ...(action.images.length ? { images: action.images } : {}),
            local: true,
          },
        ],
      }
    case 'notice':
      return { ...state, notice: action.notice }
    case 'permission-mode': {
      const mode = action.mode
      if (mode !== 'ask' && mode !== 'auto' && mode !== 'full') return state
      return { ...state, permissionMode: mode }
    }
    case 'reset':
      return initialChatState
  }
}

export interface SessionStream {
  state: ChatState
  echo(text: string, images: ChatImage[]): void
  hydrate(transcript: readonly unknown[]): void
  setNotice(notice: string | undefined): void
  /** 写入权限档位（非法值忽略）；SSE permission.mode 帧同写这里。 */
  setPermissionMode(mode: string): void
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
    setPermissionMode: useCallback(
      (mode: string) => dispatch({ type: 'permission-mode', mode }),
      [],
    ),
    reset: useCallback(() => dispatch({ type: 'reset' }), []),
  }
}

/** 从 transcript 快照恢复（刷新场景）——保留导出兼容既有引用，内部走 hydrate。 */
export function hydrateFromTranscript(state: ChatState, transcript: readonly unknown[]): ChatState {
  return reduceChatState(state, { type: 'hydrate', transcript })
}
