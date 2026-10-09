import {
  DIFF_PAIR_MARKERS,
  pickCopy,
  TOOL_LABELS as SHARED_TOOL_LABELS,
} from '@volund/shared/ui-copy'
/**
 * 会话事件流 reducer（§22.8.3）：SSE 信封 + 本地动作 → 聊天视图的唯一状态源。
 * 幂等去重以 (cursor) 为键；stream.delta 只追加（不落盘，刷新以 transcript 为准）。
 *
 * 渲染侧只允许消费本 hook 的 state——此前 SSE state 与 Chat 本地 state 双轨并行
 * （流式消息进了 stream、渲染读 local），是「发消息后无响应」的根因，勿再分叉。
 */
import { useCallback, useEffect, useReducer, useRef } from 'react'

import { currentLocale, translate } from './i18n'

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
  /**
   * 到达序号：会话流混排的排序键（chatFeed）——工具卡跟随其发生的时点插进
   * 消息流。live 事件建立时分配；transcript 水合按快照顺序单调分配。
   */
  seq?: number
}

export interface ToolCard {
  toolUseId: string
  tool: string
  status: 'running' | 'done' | 'error'
  /** 到达序号：工具卡在会话流中的混排位置（chatFeed 排序键）。 */
  seq?: number
  /**
   * Task 卡：派发时所在父 turn 的 id（CoreEvent.turnId）——子代理冒泡事件按
   * parentTurnId 归属到本卡（§2.7bis.5 U3 折叠行的连接键）。
   */
  turnId?: string
  /** Task 卡：tool.requested input 的展示摘要（agentType / prompt 首行）。 */
  task?: { agentType?: string; prompt?: string }
  /** tool.requested 的 input 提取的单行目标（路径/命令…）；无目标时省略。 */
  target?: string
  /** 展开卡的完整正文（Bash 命令/文件内容/入参 JSON…）；仅 requested 帧带 input 时有。 */
  body?: string
  linesAdded?: number
  linesRemoved?: number
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
  /** S1 batch 卡：MCP 来源请求携带——卡面渲染「允许此 server 全部工具」入口。 */
  mcpServer?: string
  /** 子代理来源（§2.7bis.5 U4）；主代理请求省略——无徽标回归面。 */
  lineage?: PermissionLineage
}

/** AskUserQuestion 的待决提问卡（hub ask.request 视图帧投影；web 只读队首）。 */
export interface AskCard {
  id: string
  question: string
  options: { label: string; description?: string }[]
}

export interface QueuedSend {
  id: string
  text: string
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
  /** 待决提问（AskUserQuestion）：ask.request/resolved 视图帧同写这里。 */
  ask: AskCard | undefined
  /** 发送排队：回合进行中提交的消息，回合终态后由 ChatPanel 逐条自动补发。 */
  sendQueue: QueuedSend[]
  /**
   * 本回合累计的正文流字符（stream.delta text 追加，turn.started 清零）——
   * 状态行的 ↑ tokens 估算数据源（≈ chars/4，与 TUI 同规则）。
   */
  streamedChars: number
  /**
   * 会话权限档位（ask/auto/full）：唯一来源是本 reducer——挂载/切会话拉取 +
   * SSE permission.mode 帧同写这里（TUI /mode、他端选择器、权限卡 g 授权全同步）。
   */
  permissionMode: 'ask' | 'auto' | 'full' | undefined
  notice: string | undefined
  /**
   * 用户主动中断（turn.aborted 非错误原因）：走独立友好提示 + 重试入口，
   * 不进报错 notice 槽（主动停止不是警告，黄条横幅观感差）。turn.started 清除。
   */
  interrupted: boolean
  /** 下一个到达序号（消息/工具卡的会话流排序键分配器，chatFeed 混排数据源）。 */
  nextSeq: number
}

export const initialChatState: ChatState = {
  messages: [],
  sendQueue: [],
  tools: [],
  subagents: {},
  turn: 'idle',
  usage: undefined,
  permission: undefined,
  ask: undefined,
  streamedChars: 0,
  permissionMode: undefined,
  notice: undefined,
  interrupted: false,
  nextSeq: 1,
}

/**
 * 会话流混排：消息气泡与工具卡按到达序号排序渲染（工具卡跟随其发生的时点，
 * 完成/失败只更新状态不挪位置）。缺 seq 的历史数据（旧持久化）排最后保底。
 */
type FlatEntry =
  | { kind: 'message'; key: string; message: ChatMessage }
  | { kind: 'tool'; key: string; tool: ToolCard }

export type FeedEntry = FlatEntry | { kind: 'tool-group'; key: string; tools: ToolCard[] }

export function chatFeed(state: ChatState): FlatEntry[] {
  const entries: FlatEntry[] = [
    ...state.messages.map((message): FlatEntry => ({ kind: 'message', key: message.id, message })),
    ...state.tools.map((tool): FlatEntry => ({ kind: 'tool', key: tool.toolUseId, tool })),
  ]
  return entries.toSorted((a, b) => {
    const seqA = a.kind === 'message' ? a.message.seq : a.tool.seq
    const seqB = b.kind === 'message' ? b.message.seq : b.tool.seq
    return (seqA ?? Number.MAX_SAFE_INTEGER) - (seqB ?? Number.MAX_SAFE_INTEGER)
  })
}

/**
 * 会话流渲染投影：在 chatFeed 混排之上把相邻 ≥2 的工具行合并成一个可折叠分组
 * （默认只显示「N 次工具调用」一行，展开才是逐行卡——长工具链不再刷屏）。
 * 单条工具保持原样（「1 次工具调用」是纯噪音）；助手/用户消息天然切断分组。
 * key 取 `grp:` + 首卡 toolUseId——运行中追加新卡不换 key，展开态跨重渲染保持。
 */
export function chatFeedGrouped(state: ChatState): FeedEntry[] {
  const grouped: FeedEntry[] = []
  let run: ToolCard[] = []
  const flush = () => {
    const first = run[0]
    if (first === undefined) {
      run = []
      return
    }
    if (run.length === 1) grouped.push({ kind: 'tool', key: first.toolUseId, tool: first })
    else grouped.push({ kind: 'tool-group', key: `grp:${first.toolUseId}`, tools: run })
    run = []
  }
  for (const entry of chatFeed(state)) {
    if (entry.kind === 'tool') {
      run.push(entry.tool)
      continue
    }
    flush()
    grouped.push(entry)
  }
  flush()
  return grouped
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
  | { type: 'queue-push'; id: string; text: string }
  | { type: 'queue-remove'; id: string }
  | { type: 'queue-reorder'; order: readonly string[] }
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

/** 各工具最具辨识度的参数名（与 @volund/ui activityTarget 同一选择规则）。 */
const TOOL_TARGET_KEYS: Record<string, string> = {
  Read: 'path',
  Write: 'path',
  Edit: 'path',
  MultiEdit: 'path',
  Bash: 'command',
  Glob: 'pattern',
  Grep: 'pattern',
  WebFetch: 'url',
  WebSearch: 'query',
  ShellOutput: 'shellId',
  KillShell: 'shellId',
  Task: 'agentType',
}
const FALLBACK_TARGET_KEYS = ['path', 'file_path', 'command', 'pattern', 'url', 'query'] as const
const TARGET_MAX = 72

/**
 * tool.requested 的 input → 单行展示目标（tool row 的 path/command 列）。
 * input 是模型产出：剥控制字符、压空白、截断；绝不取 content/old_string 等正文参数。
 */
export function toolTargetLabel(tool: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const record = input as Record<string, unknown>
  const pick = (key: string): string | undefined => {
    const value = record[key]
    return typeof value === 'string' && value.trim() ? value : undefined
  }
  const raw =
    (TOOL_TARGET_KEYS[tool] ? pick(TOOL_TARGET_KEYS[tool]) : undefined) ??
    FALLBACK_TARGET_KEYS.map(pick).find((value) => value !== undefined)
  if (!raw) return undefined
  // 控制字符与换行压成单行（React 文本节点本身无注入面，这里只为可读性）。
  const oneLine = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .split(/\s+/)
    .join(' ')
    .trim()
  if (!oneLine) return undefined
  return oneLine.length > TARGET_MAX ? `${oneLine.slice(0, TARGET_MAX - 1)}…` : oneLine
}

/**
 * mcp__〈server〉__〈tool〉 拆解（SKILLS-MCPS-r1 §S3.5 双下划线命名）；非 MCP 工具
 * 回 undefined。server/tool 名在注册时已做字符清洗，这里只做切分展示。
 */
export function mcpToolParts(tool: string): { server: string; name: string } | undefined {
  if (!tool.startsWith('mcp__')) return undefined
  const rest = tool.slice('mcp__'.length)
  const sep = rest.indexOf('__')
  if (sep <= 0 || sep === rest.length - 2) return undefined
  return { server: rest.slice(0, sep), name: rest.slice(sep + 2) }
}

/** 工具的折叠行展示名（shared 跨端文案表权威，i18n-r1 收编三份手抄）；MCP 工具显示 server/tool；未知工具原样展示。 */
export function toolLabel(tool: string): string {
  const mcp = mcpToolParts(tool)
  if (mcp) return `MCP · ${mcp.server}/${mcp.name}`
  const entry = SHARED_TOOL_LABELS[tool]
  return entry ? pickCopy(entry, currentLocale()) : tool
}

/** 多段正文拼接（空段丢弃）；无有效段时省略。 */
function joinBody(...parts: (string | undefined)[]): string | undefined {
  const body = parts.filter((part) => part !== undefined).join('\n\n')
  return body || undefined
}

/** 编辑类正文的新旧对照段（标记走 shared 跨端文案表）。 */
function diffPair(oldString?: string, newString?: string): string | undefined {
  if (oldString === undefined && newString === undefined) return undefined
  const locale = currentLocale()
  return `${pickCopy(DIFF_PAIR_MARKERS.old, locale)}\n${oldString ?? ''}\n\n${pickCopy(DIFF_PAIR_MARKERS.new, locale)}\n${newString ?? ''}`
}

/** 展开卡正文上限（字符）：超大 input（Write 全文等）截断，避免撑爆消息流。 */
const BODY_MAX = 4000

/**
 * tool.requested 的 input → 展开卡正文（保留多行：Bash 命令/文件内容/新旧对照…）。
 * 只拼展示面参数，未知工具退回入参 JSON 全量；超长截断。
 */
export function toolBodyLabel(tool: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const record = input as Record<string, unknown>
  const str = (key: string): string | undefined => {
    const value = record[key]
    return typeof value === 'string' && value.trim() ? value : undefined
  }
  const num = (key: string): number | undefined => {
    const value = record[key]
    return typeof value === 'number' ? value : undefined
  }
  let body: string | undefined
  switch (tool) {
    case 'Bash':
    case 'ShellOutput':
    case 'KillShell':
      body = str('command') ?? str('shellId')
      break
    case 'Read': {
      const offset = num('offset')
      const limit = num('limit')
      const range =
        offset !== undefined || limit !== undefined
          ? `offset: ${offset ?? 0}${limit !== undefined ? ` · limit: ${limit}` : ''}`
          : undefined
      body = joinBody(str('path'), range)
      break
    }
    case 'Write':
      body = joinBody(str('path'), str('content'))
      break
    case 'Edit':
      body = joinBody(str('path'), diffPair(str('old_string'), str('new_string')))
      break
    case 'MultiEdit': {
      const edits = Array.isArray(record.edits) ? record.edits : []
      const pairs = edits
        .map((edit) => {
          if (!edit || typeof edit !== 'object') return undefined
          const item = edit as Record<string, unknown>
          const oldString = typeof item.old_string === 'string' ? item.old_string : undefined
          const newString = typeof item.new_string === 'string' ? item.new_string : undefined
          return diffPair(oldString, newString)
        })
        .filter((pair): pair is string => pair !== undefined)
      body = joinBody(str('path'), pairs.length > 0 ? pairs.join('\n\n') : undefined)
      break
    }
    case 'Glob':
    case 'Grep':
      body = joinBody(str('pattern'), str('path'))
      break
    case 'WebFetch':
      body = joinBody(str('url'), str('prompt'))
      break
    case 'WebSearch':
      body = str('query')
      break
    case 'Task':
      body = joinBody(str('prompt'), str('description'))
      break
    default:
      try {
        body = JSON.stringify(input, null, 2)
      } catch {
        body = undefined
      }
  }
  if (!body) return undefined
  return body.length > BODY_MAX
    ? `${body.slice(0, BODY_MAX)}\n${translate(currentLocale(), 'chat.truncated')}`
    : body
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

/** 回合终态清扫：仍 running 的工具卡按失败收口（正常路径 tool.completed 已先行；
 * 回合死了卡还挂着 = 执行栈异常/中断残留，不能让「运行中」永恒悬挂）。 */
function settleRunningTools(state: ChatState): ToolCard[] {
  return state.tools.some((tool) => tool.status === 'running')
    ? state.tools.map((tool) => (tool.status === 'running' ? { ...tool, status: 'error' } : tool))
    : state.tools
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
      // 流式中已存在的同 id 流式消息：以持久化完整消息收口（保留到达时间与 seq）。
      const messages = exists
        ? base.map((message) =>
            message.id === id
              ? { ...message, text, streaming: false, ...(images.length ? { images } : {}) }
              : message,
          )
        : [
            ...base,
            {
              id,
              role,
              text,
              at: Date.now(),
              seq: state.nextSeq,
              ...(images.length ? { images } : {}),
            },
          ]
      return { ...state, messages, ...(exists ? {} : { nextSeq: state.nextSeq + 1 }) }
    }
    case 'stream.delta': {
      if (payload.kind !== 'text') return state
      const id = String(payload.messageId)
      const fragment = String(payload.fragment)
      const exists = state.messages.some((message) => message.id === id)
      const messages = exists
        ? state.messages.map((message) =>
            message.id === id
              ? { ...message, text: message.text + fragment, streaming: true }
              : message,
          )
        : [
            ...state.messages,
            {
              id,
              role: 'assistant' as const,
              text: fragment,
              streaming: true,
              at: Date.now(),
              seq: state.nextSeq,
            },
          ]
      return {
        ...state,
        messages,
        streamedChars: state.streamedChars + fragment.length,
        ...(exists ? {} : { nextSeq: state.nextSeq + 1 }),
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
      return { ...state, turn: 'running', usage: undefined, streamedChars: 0, interrupted: false }
    case 'turn.completed':
      return {
        ...state,
        turn: 'idle',
        usage: payload.usage as ChatState['usage'],
        tools: settleRunningTools(state),
      }
    case 'turn.aborted': {
      // reason=error 时 error.raised 通常已给出具体原因，不覆盖；
      // user_interrupt 才是「用户中断」语义——走 interrupted 友好提示（可重试），
      // 不与报错 notice 同槽（报错文案一律英文+code，中断提示是 UI chrome 中文）。
      const reason = payload.reason
      const tools = settleRunningTools(state)
      if (reason === 'error')
        return {
          ...state,
          turn: 'idle',
          tools,
          notice: state.notice ?? 'turn aborted due to an error',
        }
      if (reason === 'stream_interrupted')
        return { ...state, turn: 'idle', tools, notice: state.notice ?? 'stream interrupted' }
      return { ...state, turn: 'idle', tools, interrupted: true }
    }
    case 'tool.requested': {
      // 附录 D.2：input 携带工具参数——requested 帧建卡并提取单行目标 + 展开正文
      // （started 帧不带 input，对齐 TUI 活动行「先于权限判定建条目」的时序）；
      // Task 卡同时摘 agentType / prompt 首行摘要（§2.7bis.5 U3 折叠行）。
      const id = String(payload.toolUseId)
      const tool = String(payload.tool)
      // MCP 工具的入参无统一 target 语义（fallback 键多为猜测），只留 JSON 正文。
      const target = mcpToolParts(tool) ? undefined : toolTargetLabel(tool, payload.input)
      const body = toolBodyLabel(tool, payload.input)
      const extras = {
        ...(target === undefined ? {} : { target }),
        ...(body === undefined ? {} : { body }),
      }
      if (tool !== 'Task') {
        const exists = state.tools.some((card) => card.toolUseId === id)
        if (exists)
          return {
            ...state,
            // 重复 requested 原位补 target/body——filter 重建会把卡挪到列表尾，混排序就乱了。
            tools: state.tools.map((card) =>
              card.toolUseId === id ? { ...card, status: 'running' as const, ...extras } : card,
            ),
          }
        return {
          ...state,
          nextSeq: state.nextSeq + 1,
          tools: [
            ...state.tools,
            { toolUseId: id, tool, status: 'running' as const, seq: state.nextSeq, ...extras },
          ],
        }
      }
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
      const exists = state.tools.some((card) => card.toolUseId === id)
      if (exists)
        return {
          ...state,
          tools: state.tools.map((card) =>
            card.toolUseId === id ? { ...card, task, ...extras } : card,
          ),
        }
      return {
        ...state,
        nextSeq: state.nextSeq + 1,
        tools: [
          ...state.tools,
          { toolUseId: id, tool: 'Task', status: 'running', task, seq: state.nextSeq, ...extras },
        ],
      }
    }
    case 'tool.started': {
      // turnId 只在 Task 卡上是归属键，但顺手全记——数据来自 CoreEvent 顶层，零成本。
      // requested 阶段已建的卡（target/task）经 spread 保留，仅拨状态。
      const turnId = typeof event.turnId === 'string' ? event.turnId : undefined
      const id = String(payload.toolUseId)
      const exists = state.tools.some((tool) => tool.toolUseId === id)
      if (exists)
        return {
          ...state,
          tools: state.tools.map((tool) =>
            tool.toolUseId === id
              ? { ...tool, status: 'running', ...(turnId ? { turnId } : {}) }
              : tool,
          ),
        }
      return {
        ...state,
        nextSeq: state.nextSeq + 1,
        tools: [
          ...state.tools,
          {
            toolUseId: id,
            tool: String(payload.tool),
            status: 'running',
            seq: state.nextSeq,
            ...(turnId ? { turnId } : {}),
          },
        ],
      }
    }
    case 'tool.completed': {
      const id = String(payload.toolUseId)
      const failed = payload.isError === true
      const linesAdded = typeof payload.linesAdded === 'number' ? payload.linesAdded : undefined
      const linesRemoved =
        typeof payload.linesRemoved === 'number' ? payload.linesRemoved : undefined
      return {
        ...state,
        tools: state.tools.map((tool) =>
          tool.toolUseId === id
            ? {
                ...tool,
                status: failed ? 'error' : 'done',
                ...(linesAdded === undefined ? {} : { linesAdded }),
                ...(linesRemoved === undefined ? {} : { linesRemoved }),
              }
            : tool,
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
        // 通知格式 = `code: 细节`：code 面向 grep/遥测，细节由 runner 出英文人话。
        notice: `${String(payload.code ?? '')}: ${String(detail)}`,
      }
    }
    default:
      break
  }
  if (envelope.kind === 'view') {
    const view = event as unknown as {
      type: string
      request?: PermissionCard | AskCard
      message?: string
      mode?: unknown
    }
    if (view.type === 'permission.request' && view.request)
      return { ...state, permission: view.request as PermissionCard }
    if (view.type === 'permission.resolved') return { ...state, permission: undefined }
    if (view.type === 'ask.request' && view.request)
      return { ...state, ask: view.request as AskCard }
    if (view.type === 'ask.resolved') return { ...state, ask: undefined }
    if (view.type === 'permission.mode') {
      if (view.mode === 'ask' || view.mode === 'auto' || view.mode === 'full')
        return { ...state, permissionMode: view.mode }
      return state
    }
    if (view.type === 'turn.failed')
      return {
        ...state,
        turn: 'idle',
        tools: settleRunningTools(state),
        notice: view.message ?? 'turn failed',
      }
    // 会话重挂（TUI 侧 resume 等）：聊天状态归零，但进程级权限档位保留
    // （SSE permission.mode 帧会持续纠正，不需要随会话切换清空）。
    if (view.type === 'session.attached')
      return {
        ...initialChatState,
        permissionMode: state.permissionMode,
        notice: translate(currentLocale(), 'chat.attachedNotice'),
      }
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
      // 快照里的 tool 条目（TranscriptToolEntry）重建折叠卡：target/body 从快照
      // 携带的 input 现算，展开面与 live 卡一致；与 live 卡同 id 时以 live 为准。
      // seq 按快照顺序单调分配（消息与工具卡保序，混排跟 live 一致）。
      const messages: ChatMessage[] = []
      const tools: ToolCard[] = []
      let seq = state.nextSeq
      for (const entry of action.transcript) {
        const item = entry as {
          id?: string
          role?: string
          text?: string
          kind?: string
          tool?: string
          input?: unknown
          status?: string
          attachments?: readonly { chip?: string; kind?: string; mime?: string; handle?: string }[]
        }
        if (!item.id) continue
        if (item.kind === 'tool') {
          if (typeof item.tool !== 'string') continue
          const status: ToolCard['status'] =
            item.status === 'error' ? 'error' : item.status === 'running' ? 'running' : 'done'
          const target = toolTargetLabel(item.tool, item.input)
          const body = toolBodyLabel(item.tool, item.input)
          tools.push({
            toolUseId: item.id,
            tool: item.tool,
            status,
            seq: seq++,
            ...(target === undefined ? {} : { target }),
            ...(body === undefined ? {} : { body }),
          })
          continue
        }
        if (!item.role || !item.text) continue
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
          seq: seq++,
          ...(images.length ? { images } : {}),
        })
      }
      const hydratedIds = new Set(messages.map((message) => message.id))
      const tail = state.messages.filter(
        (message) => !message.local && !hydratedIds.has(message.id),
      )
      const liveToolIds = new Set(state.tools.map((tool) => tool.toolUseId))
      const hydratedTools = tools.filter((tool) => !liveToolIds.has(tool.toolUseId))
      return {
        ...state,
        messages: [...messages, ...tail],
        tools: [...hydratedTools, ...state.tools],
        nextSeq: seq,
      }
    }
    case 'echo':
      return {
        ...state,
        nextSeq: state.nextSeq + 1,
        messages: [
          ...state.messages,
          {
            id: `local-${Date.now()}`,
            role: 'user',
            text: action.text,
            at: Date.now(),
            seq: state.nextSeq,
            ...(action.images.length ? { images: action.images } : {}),
            local: true,
          },
        ],
      }
    case 'notice':
      return { ...state, notice: action.notice }
    // 发送排队（回合进行中提交的消息）：回合终态后由 ChatPanel 逐条自动补发。
    case 'queue-push':
      return { ...state, sendQueue: [...state.sendQueue, { id: action.id, text: action.text }] }
    case 'queue-remove':
      return {
        ...state,
        sendQueue: state.sendQueue.filter((item) => item.id !== action.id),
      }
    case 'queue-reorder': {
      const rank = new Map(action.order.map((id, index) => [id, index]))
      const ordered = state.sendQueue
        .map((item, index) => [rank.get(item.id) ?? index, item] as const)
        .sort((left, right) => left[0] - right[0])
        .map(([, item]) => item)
      return { ...state, sendQueue: ordered }
    }
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
  queuePush(id: string, text: string): void
  queueRemove(id: string): void
  queueReorder(order: readonly string[]): void
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
    queuePush: useCallback(
      (id: string, text: string) => dispatch({ type: 'queue-push', id, text }),
      [],
    ),
    queueRemove: useCallback((id: string) => dispatch({ type: 'queue-remove', id }), []),
    queueReorder: useCallback(
      (order: readonly string[]) => dispatch({ type: 'queue-reorder', order }),
      [],
    ),
    reset: useCallback(() => dispatch({ type: 'reset' }), []),
  }
}

/** 从 transcript 快照恢复（刷新场景）——保留导出兼容既有引用，内部走 hydrate。 */
export function hydrateFromTranscript(state: ChatState, transcript: readonly unknown[]): ChatState {
  return reduceChatState(state, { type: 'hydrate', transcript })
}
