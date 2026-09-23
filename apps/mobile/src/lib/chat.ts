/**
 * 聊天状态 reducer（移植自 apps/web 的 session-stream，裁剪移动场景）：
 * 网关 WS 信封（与 web 控制台同一套 envelope）+ 本地动作 → 聊天视图唯一状态源。
 * 幂等键 = message id；stream.delta 只追加（刷新以 transcript 水合为准）。
 */

export interface ChatMessageImage {
  chip: string
  /** 本机发送的乐观回显预览（blob objectURL）；transcript 水合/跨端消息没有它。 */
  previewUrl?: string
  /** AttachmentStore 内容寻址引用——无 previewUrl 时经 GET /v1/attachments/:handle 取字节。 */
  handle?: string
  mime?: string
}

export interface ChatMessage {
  id: string
  role: 'assistant' | 'system' | 'user'
  text: string
  /** 思考流（stream.delta kind=thinking）——移动端渲染成默认折叠的「思考过程」摘要条。 */
  thinking?: string
  streaming?: boolean
  /** 用户消息携带的图片缩略图（仅本地回显；transcript 水合面只有文本）。 */
  images?: readonly ChatMessageImage[]
  /** 本地乐观回显；message.appended 到达后被真实消息替换。 */
  local?: boolean
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
 * 经 gateway 盲转透传（与 Web 控制台同字段）；卡面据此渲染「子代理 · <agentType>」徽标。
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
  permission: PermissionCard | undefined
  notice: string | undefined
}

export const initialChatState: ChatState = {
  messages: [],
  tools: [],
  subagents: {},
  turn: 'idle',
  permission: undefined,
  notice: undefined,
}

/** 本机离线提示文案（machine.online 到达时按文案匹配清除，不误清其他提示）。 */
export const MACHINE_OFFLINE_NOTICE = '本机离线：桌面端隧道已断开，恢复后自动重连'

/** 信封事件面：CoreEvent 透传（附录 D.3 冒泡 tag 在事件顶层，§2.7bis.5 U3）。 */
export interface EnvelopeEvent {
  type: string
  payload?: Record<string, unknown>
  /** view 帧（kind='view'）的权限请求面——`permission.request` 携带（§2.7bis.5 U4：lineage 经此盲转透传）。 */
  request?: PermissionCard
  /** CoreEvent 的 turnId——Task 卡与冒泡事件的归属键（tool.requested/started 携带）。 */
  turnId?: string
  /** 子代理冒泡 tag：EventBus.forward 打上，两字段同时出现。 */
  parentTurnId?: string
  parentDepth?: number
}

export type StreamAction =
  | { type: 'envelope'; envelope: { kind: string; sessionId?: string; event: EnvelopeEvent } }
  | { type: 'hydrate'; transcript: readonly unknown[] }
  | { type: 'echo'; text: string; images?: readonly ChatMessageImage[] }
  | { type: 'notice'; notice: string | undefined }
  | { type: 'reset' }

/** 只取 text part（thinking part 也有 text 字段，混进来会把思考内容粘进正文、破坏 markdown 结构）。 */
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

/** thinking part 的 text ——收口时回填进思考摘要（流式期间已由 thinking delta 累积）。 */
function thinkingOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'thinking'
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
function imagesOfContent(content: unknown): ChatMessageImage[] {
  if (!Array.isArray(content)) return []
  const images: ChatMessageImage[] = []
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

type Event = {
  type?: unknown
  payload?: Record<string, unknown>
  turnId?: unknown
  parentTurnId?: unknown
  parentDepth?: unknown
}

/** turn 终态/被取代时，把还卡在 streaming 的消息收口（否则 spinner 永久转）。 */
function finalizeStreaming(messages: ChatMessage[]): ChatMessage[] {
  if (!messages.some((message) => message.streaming)) return messages
  return messages.map((message) => (message.streaming ? { ...message, streaming: false } : message))
}

/**
 * §2.7bis.5 U3 / 附录 D.3：子代理冒泡事件的归约——不碰消息流/工具列表/turn 状态
 * （对齐 TUI 的过滤），只把 tool.* 聚合进 subagents（Task 折叠行的数据源）。
 * 归属键 = parentTurnId（父 turnId，与 Task 卡 tool.started 的 event.turnId 相同）。
 */
function reduceBubbledEvent(state: ChatState, event: Event): ChatState {
  const parentTurnId = typeof event.parentTurnId === 'string' ? event.parentTurnId : undefined
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

function reduceEnvelope(
  state: ChatState,
  envelope: {
    kind: string
    event: unknown
  },
): ChatState {
  const event = envelope.event as Event
  if (!event || typeof event.type !== 'string') return state
  const payload = event.payload ?? {}
  // §2.7bis.5 U3：子代理冒泡事件（附录 D.3 tag）不进主聊天流——stream.delta 不再
  // 混成无标注的 assistant 气泡，tool.* 不再平铺进工具 chip 列表，turn.* 不再拨动
  // 主会话的 turn 状态；tool.* 聚合到对应 Task 卡的折叠行。主会话事件无 tag，不受影响。
  if ('parentTurnId' in event || (typeof event.parentDepth === 'number' && event.parentDepth > 0))
    return reduceBubbledEvent(state, event)
  switch (event.type) {
    case 'message.appended': {
      const id = String(payload.messageId)
      const text = textOfContent(payload.content)
      const thinking = thinkingOfContent(payload.content)
      const role = payload.role as ChatMessage['role']
      const contentImages = imagesOfContent(payload.content)
      // 无可见内容的消息（tool_use-only 的 assistant、tool_result 的 user）不产生
      // 气泡——工具活动由工具卡承担，空气泡是纯噪音。已存在的同 id 气泡（流式
      // 期间由 delta 建立）照常收口。
      const existing = state.messages.find((message) => message.id === id)
      if (!existing && !text && !thinking && contentImages.length === 0) return state
      // 真实 user 消息到达 = 乐观回显收口：清掉 local 回声，但把最早一条回声带的
      // 图片转交给确认消息（否则图片一闪即没）；跨端来的消息无回声，从 content 的
      // image part 取 handle 引用（经网关按需取字节）。
      const echoImages =
        role === 'user'
          ? state.messages.find((message) => message.local && message.images?.length)?.images
          : undefined
      const base =
        role === 'user' ? state.messages.filter((message) => !message.local) : state.messages
      const images = echoImages?.length ? echoImages : contentImages
      const messages = existing
        ? base.map((message) =>
            message.id === id
              ? { ...message, text, ...(thinking ? { thinking } : {}), streaming: false }
              : message,
          )
        : [
            ...base,
            {
              id,
              role,
              text,
              ...(thinking ? { thinking } : {}),
              ...(images.length ? { images } : {}),
            } satisfies ChatMessage,
          ]
      return { ...state, messages }
    }
    case 'stream.delta': {
      const kind = payload.kind
      // text = 正文流；thinking = 思考流（正文出现前的整段等待期，不渲染会像卡死）。
      if (kind !== 'text' && kind !== 'thinking') return state
      const id = String(payload.messageId)
      const fragment = String(payload.fragment)
      const apply = (message: ChatMessage): ChatMessage =>
        kind === 'text'
          ? { ...message, text: message.text + fragment, streaming: true }
          : { ...message, thinking: (message.thinking ?? '') + fragment, streaming: true }
      const messages = state.messages.some((message) => message.id === id)
        ? state.messages.map((message) => (message.id === id ? apply(message) : message))
        : [...state.messages, apply({ id, role: 'assistant' as const, text: '' })]
      return { ...state, messages }
    }
    case 'stream.started': {
      // 新一轮流开始（流中断重试会换新 messageId）：把仍卡在 streaming 的旧消息
      // 收口为静态——它们的 stream.completed 永远不会来，不收口会永久转圈。
      const id = String(payload.messageId)
      if (!state.messages.some((message) => message.streaming && message.id !== id)) return state
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.streaming && message.id !== id ? { ...message, streaming: false } : message,
        ),
      }
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
      return { ...state, turn: 'running' }
    case 'turn.completed':
      return { ...state, turn: 'idle', messages: finalizeStreaming(state.messages) }
    case 'turn.aborted': {
      const messages = finalizeStreaming(state.messages)
      const reason = payload.reason
      if (reason === 'error')
        return { ...state, turn: 'idle', messages, notice: state.notice ?? '本轮因错误中止' }
      if (reason === 'stream_interrupted')
        return { ...state, turn: 'idle', messages, notice: state.notice ?? '本轮流式中断' }
      return { ...state, turn: 'idle', messages, notice: '本轮已中断' }
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
      // runner 的错误细节在 context.message（runner_error）或 context.reason
      //（stream_interrupted，如 'read ECONNRESET'）——两个键都要兜。
      const context = payload.context as { message?: unknown; reason?: unknown } | undefined
      const detail = context?.message ?? context?.reason ?? payload.message ?? ''
      return { ...state, notice: `错误 ${String(payload.code ?? '')}: ${String(detail)}` }
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
      return {
        ...state,
        turn: 'idle',
        messages: finalizeStreaming(state.messages),
        notice: view.message ?? 'turn 失败',
      }
    // session.attached 不在这里清屏：多设备共用单活动会话时它是对全员广播的
    // （任何一台设备 resume，哪怕同一个会话，都会触发）——重置交由 page 层
    // 判定「同会话忽略 / 异会话跟随 + hydrate 全量重建」，这里动 messages
    // 会把其他设备的上下文打空（还能发消息，但历史看不见）。
    if (view.type === 'session.attached') return state
    // 网关合成的机器在线状态（uplink 断开/重连）：离线即提示，上线仅清离线条。
    if (view.type === 'machine.offline') return { ...state, notice: MACHINE_OFFLINE_NOTICE }
    if (view.type === 'machine.online')
      return state.notice === MACHINE_OFFLINE_NOTICE ? { ...state, notice: undefined } : state
  }
  return state
}

export function reduceChatState(state: ChatState, action: StreamAction): ChatState {
  if (action.type === 'envelope') {
    const event = action.envelope.event as Partial<Event>
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return state
    return reduceEnvelope(state, action.envelope)
  }
  switch (action.type) {
    case 'hydrate': {
      const messages: ChatMessage[] = []
      for (const entry of action.transcript) {
        const item = entry as {
          id?: string
          role?: string
          text?: string
          attachments?: readonly {
            chip?: string
            kind?: string
            mime?: string
            handle?: string
          }[]
        }
        if (item.id && item.role && item.text) {
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
          const images: ChatMessageImage[] = attachments.map((attachment) => ({
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
            local: true,
            ...(action.images?.length ? { images: action.images } : {}),
          },
        ],
      }
    case 'notice':
      return { ...state, notice: action.notice }
    case 'reset':
      return initialChatState
  }
}
