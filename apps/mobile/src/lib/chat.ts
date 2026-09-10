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
  permission: PermissionCard | undefined
  notice: string | undefined
}

export const initialChatState: ChatState = {
  messages: [],
  tools: [],
  turn: 'idle',
  permission: undefined,
  notice: undefined,
}

/** 本机离线提示文案（machine.online 到达时按文案匹配清除，不误清其他提示）。 */
export const MACHINE_OFFLINE_NOTICE = '本机离线：桌面端隧道已断开，恢复后自动重连'

export type StreamAction =
  | { type: 'envelope'; envelope: { kind: string; sessionId?: string; event: unknown } }
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

type Event = { type?: unknown; payload?: Record<string, unknown> }

/** turn 终态/被取代时，把还卡在 streaming 的消息收口（否则 spinner 永久转）。 */
function finalizeStreaming(messages: ChatMessage[]): ChatMessage[] {
  if (!messages.some((message) => message.streaming)) return messages
  return messages.map((message) => (message.streaming ? { ...message, streaming: false } : message))
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
    if (view.type === 'session.attached') return { ...initialChatState, notice: '已连接会话' }
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
