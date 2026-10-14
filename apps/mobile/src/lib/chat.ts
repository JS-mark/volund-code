/**
 * 聊天状态 reducer（移植自 apps/web 的 session-stream，裁剪移动场景）：
 * 网关 WS 信封（与 web 控制台同一套 envelope）+ 本地动作 → 聊天视图唯一状态源。
 * 幂等键 = message id；stream.delta 只追加（刷新以 transcript 水合为准）。
 */

import {
  DIFF_PAIR_MARKERS,
  pickCopy,
  TOOL_LABELS as SHARED_TOOL_LABELS,
} from '@volund/shared/ui-copy'

import { currentLocale, translate } from './i18n'

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
  /** 到达序号：会话流混排（消息+工具卡）的排序键；更新保留原值（位置不漂）。 */
  seq?: number
}

export interface ToolCard {
  toolUseId: string
  tool: string
  status: 'running' | 'done' | 'error'
  /** 到达序号：工具卡在会话流中的位置（tool.started/requested 建立时分配）。 */
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
}

/** 一条子代理工具调用（冒泡 tool.requested/started/completed 的展示投影，旧→新）。 */
export interface SubagentToolRun {
  toolUseId: string
  tool: string
  status: 'running' | 'done' | 'error'
  /** 单行目标（requested 帧带 input 时提取；started 兜底建条目时缺席）。 */
  target?: string
}

/**
 * 一个 Task 派发下的子代理活动聚合（key = 父 turnId，即冒泡事件的 parentTurnId）。
 * 只从冒泡 tool.* 事件累积——子代理的消息/流式/turn 事件不进主聊天流。
 */
export interface SubagentActivity {
  /** 子代理已启动的工具调用数（冒泡 tool.requested/started 去重计数）。 */
  toolCalls: number
  /** 仍在运行的子代理工具数（started − completed，下界 0）。 */
  running: number
  /** 最近启动的子代理工具名（折叠行的「当前工具」）。 */
  lastTool?: string
  /** 工具调用轨迹（Task 卡展开面的时间线；上限之外丢最旧，计数不随之丢失）。 */
  runs: SubagentToolRun[]
}

/** 轨迹保留上限：手机展开面刷 50 行足够定位上下文，再早的看计数即可。 */
const SUBAGENT_RUNS_MAX = 50

/** 追加/更新一条轨迹；超上限丢最旧（更新不改变位置）。 */
function upsertRun(
  runs: readonly SubagentToolRun[],
  id: string,
  tool: string,
  target: string | undefined,
): SubagentToolRun[] {
  const known = runs.some((run) => run.toolUseId === id)
  const patch = { tool, status: 'running' as const, ...(target ? { target } : {}) }
  const next = known
    ? runs.map((run) => (run.toolUseId === id ? { ...run, ...patch } : run))
    : [...runs, { toolUseId: id, ...patch }]
  return next.length > SUBAGENT_RUNS_MAX ? next.slice(next.length - SUBAGENT_RUNS_MAX) : next
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
  /**
   * 网关审批超时兜底的绝对截止（epoch ms）：自动 deny 的时钟权威在网关，
   * permission.request 帧经手时盖章；旧网关缺省 → 不渲染倒计时。
   */
  expiresAt?: number
}

export interface QueuedSend {
  id: string
  text: string
}

/** AskUserQuestion 的待决提问卡（hub ask.request 视图帧投影）。 */
export interface AskCard {
  id: string
  question: string
  options: { label: string; description?: string }[]
  /** 网关超时自动关闭的绝对截止（epoch ms）；旧网关帧无此字段。 */
  expiresAt?: number
}

export interface ChatState {
  messages: ChatMessage[]
  tools: ToolCard[]
  /** 子代理活动聚合（key = 父 turnId）——Task 折叠行的数据源（§2.7bis.5 U3）。 */
  subagents: Record<string, SubagentActivity>
  turn: 'idle' | 'running'
  /** 待审批队列（hub 全量投影）：审批卡多 tab 切换的数据源；空 = 无待审批。 */
  permissions: PermissionCard[]
  /** 待决提问队列（AskUserQuestion；hub 全量投影）：问答卡的数据源。 */
  asks: AskCard[]
  /** 发送排队：回合进行中提交的消息，回合终态后自动逐条补发（支持拖拽排序）。 */
  sendQueue: QueuedSend[]
  /**
   * 本回合累计的正文流字符（stream.delta text 追加，turn.started 清零）——
   * 状态提示的 ↑ tokens 估算数据源（≈ chars/4，与 TUI/web 同规则）。
   */
  streamedChars: number
  notice: string | undefined
  /**
   * 用户主动中断（turn.aborted 非错误原因）：走独立友好提示 + 重试入口，
   * 不进报错 notice 槽（主动停止不是警告，警示条观感差）。turn.started 清除。
   */
  interrupted: boolean
  /** 下一个到达序号（消息/工具卡的会话流排序键分配器）。 */
  nextSeq: number
  /**
   * 最近一封信封/恢复动作的到达时刻（epoch ms）：停摆兜底的时钟基准——
   * turn 在跑而它长期不动 = 终态帧大概率丢了。
   */
  lastEventAt: number
}

export const initialChatState: ChatState = {
  messages: [],
  tools: [],
  subagents: {},
  turn: 'idle',
  permissions: [],
  asks: [],
  sendQueue: [],
  streamedChars: 0,
  notice: undefined,
  interrupted: false,
  nextSeq: 1,
  lastEventAt: 0,
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
  return entries.sort((a, b) => {
    const seqA = a.kind === 'message' ? a.message.seq : a.tool.seq
    const seqB = b.kind === 'message' ? b.message.seq : b.tool.seq
    return (seqA ?? Number.MAX_SAFE_INTEGER) - (seqB ?? Number.MAX_SAFE_INTEGER)
  })
}

/**
 * 会话流渲染投影：在 chatFeed 混排之上把相邻 ≥2 的工具行合并成一个可折叠分组
 * （默认只显示「N 次工具调用」一行，展开才是逐行卡——长工具链不再刷屏）。
 * 单条工具保持原样（「1 次工具调用」是纯噪音）；助手/用户消息天然切断分组。
 * key 取 `grp:` + 首卡 toolUseId——运行中追加新卡不换 key，Virtuoso 复用项不闪。
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

/** 本机离线提示文案（machine.online 到达时按文案匹配清除，不误清其他提示）。 */
/** 通知文案（i18n-r1）：经 currentLocale() 即时取值，勿在模块层缓存。 */
export function machineOfflineNotice(): string {
  return translate(currentLocale(), 'chat.offlineNotice')
}

/** 停摆兜底提示（turn-stalled 时若已有其他提示则不覆盖）。 */
export function turnStalledNotice(): string {
  return translate(currentLocale(), 'chat.stalledNotice')
}

/** 各工具最具辨识度的参数名（与 apps/web session-stream 同一选择规则）。 */
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
 * tool.requested 的 input → 单行展示目标（折叠行的 path/command 列）。
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
 * 回 undefined。与 apps/web 同规则。
 */
export function mcpToolParts(tool: string): { server: string; name: string } | undefined {
  if (!tool.startsWith('mcp__')) return undefined
  const rest = tool.slice('mcp__'.length)
  const sep = rest.indexOf('__')
  if (sep <= 0 || sep === rest.length - 2) return undefined
  return { server: rest.slice(0, sep), name: rest.slice(sep + 2) }
}

/** 工具的折叠行中文标签（Task 由组件走 🤖 特例，不在表内）；MCP 工具显示 server/tool；未知工具原样展示。 */
/** 工具展示名（shared 跨端文案表权威，i18n-r1 收编三份手抄）。 */
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

/** 编辑类正文的新旧对照段。 */
function diffPair(oldString?: string, newString?: string): string | undefined {
  if (oldString === undefined && newString === undefined) return undefined
  const locale = currentLocale()
  return `${pickCopy(DIFF_PAIR_MARKERS.old, locale)}\n${oldString ?? ''}\n\n${pickCopy(DIFF_PAIR_MARKERS.new, locale)}\n${newString ?? ''}`
}

/** 展开卡正文上限（字符）：超大 input（Write 全文等）截断，避免撑爆消息流。 */
const BODY_MAX = 4000

/**
 * tool.requested 的 input → 展开卡正文（保留多行：Bash 命令/文件内容/新旧对照…）。
 * 只拼展示面参数，未知工具退回入参 JSON 全量；超长截断。与 apps/web 同规则。
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

/** Task 入参 → 卡面摘要（agentType / prompt 首行截 80）：requested 帧与 hydrate 共用。 */
function taskSummaryOf(input: unknown): ToolCard['task'] | undefined {
  const record = input !== null && typeof input === 'object' ? input : undefined
  const agentType =
    record && 'agentType' in record && typeof record.agentType === 'string'
      ? record.agentType
      : undefined
  const prompt =
    record && 'prompt' in record && typeof record.prompt === 'string' ? record.prompt : undefined
  if (!agentType && !prompt) return undefined
  return {
    ...(agentType ? { agentType } : {}),
    ...(prompt ? { prompt: prompt.split('\n', 1)[0]!.slice(0, 80) } : {}),
  }
}

/** 信封事件面：CoreEvent 透传（附录 D.3 冒泡 tag 在事件顶层，§2.7bis.5 U3）。 */ export interface EnvelopeEvent {
  type: string
  payload?: Record<string, unknown>
  /**
   * view 帧（kind='view'）的卡面——`permission.request` 携带 PermissionCard
   * （§2.7bis.5 U4：lineage 经此盲转透传），`ask.request` 携带 AskCard。
   */
  request?: PermissionCard | AskCard
  /** view 帧队列全量投影（hub pending*Requests）：多 tab 切换数据源；旧网关缺省。 */
  requests?: (PermissionCard | AskCard)[]
  /** CoreEvent 的 turnId——Task 卡与冒泡事件的归属键（tool.requested/started 携带）。 */
  turnId?: string
  /** 子代理冒泡 tag：EventBus.forward 打上，两字段同时出现。 */
  parentTurnId?: string
  parentDepth?: number
  /** permission.request 帧的审批超时截止（网关盖章，epoch ms）；其余帧缺省。 */
  expiresAt?: number
}

export type StreamAction =
  | { type: 'envelope'; envelope: { kind: string; sessionId?: string; event: EnvelopeEvent } }
  | { type: 'hydrate'; transcript: readonly unknown[] }
  | { type: 'turn-restored' }
  | { type: 'turn-stalled' }
  | { type: 'echo'; text: string; images?: readonly ChatMessageImage[] }
  | { type: 'notice'; notice: string | undefined }
  | { type: 'queue-push'; id: string; text: string }
  | { type: 'queue-remove'; id: string }
  | { type: 'queue-reorder'; order: readonly string[] }
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

/** 回合终态清扫：仍 running 的工具卡按失败收口（正常路径 tool.completed 已先行；
 * 回合死了卡还挂着 = 执行栈异常/中断残留，不能让「运行中」永恒悬挂）。 */
function settleRunningTools(tools: ToolCard[]): ToolCard[] {
  if (!tools.some((tool) => tool.status === 'running')) return tools
  return tools.map((tool) => (tool.status === 'running' ? { ...tool, status: 'error' } : tool))
}

/**
 * §2.7bis.5 U3 / 附录 D.3：子代理冒泡事件的归约——不碰消息流/工具列表/turn 状态
 * （对齐 TUI 的过滤），只把 tool.* 聚合进 subagents（Task 折叠行与展开轨迹的数据源）。
 * 归属键 = parentTurnId（父 turnId，与 Task 卡 tool.started 的 event.turnId 相同）。
 */
function reduceBubbledEvent(state: ChatState, event: Event): ChatState {
  const parentTurnId = typeof event.parentTurnId === 'string' ? event.parentTurnId : undefined
  if (!parentTurnId) return state
  const payload = event.payload ?? {}
  const id = typeof payload.toolUseId === 'string' ? payload.toolUseId : undefined
  switch (event.type) {
    // requested（带 input，先到）与 started（兜底 stub）同 toolUseId 只计一次；
    // requested 的 input 提取单行目标（MCP 工具无 target 语义，同主流工具卡）。
    case 'tool.requested':
    case 'tool.started': {
      const tool = typeof payload.tool === 'string' ? payload.tool : ''
      if (!id || !tool) return state
      const current = state.subagents[parentTurnId] ?? { toolCalls: 0, running: 0, runs: [] }
      const known = current.runs.some((run) => run.toolUseId === id)
      const target =
        event.type === 'tool.requested' && !mcpToolParts(tool)
          ? toolTargetLabel(tool, payload.input)
          : undefined
      return {
        ...state,
        subagents: {
          ...state.subagents,
          [parentTurnId]: {
            ...current,
            toolCalls: known ? current.toolCalls : current.toolCalls + 1,
            running: known ? current.running : current.running + 1,
            lastTool: tool,
            runs: upsertRun(current.runs, id, tool, target),
          },
        },
      }
    }
    case 'tool.completed': {
      const current = state.subagents[parentTurnId]
      if (!current) return state
      const failed = payload.isError === true
      const run = id ? current.runs.find((item) => item.toolUseId === id) : undefined
      const runs =
        run && id
          ? current.runs.map((item) =>
              item.toolUseId === id
                ? { ...item, status: failed ? ('error' as const) : ('done' as const) }
                : item,
            )
          : current.runs
      // running 只对「确曾 running」的收口递减（重复 completed 幂等）；轨迹缺席的
      // id（requested/started 双双迟到丢失）按旧语义兜底递减。
      const running =
        !run || run.status === 'running' ? Math.max(0, current.running - 1) : current.running
      return {
        ...state,
        subagents: {
          ...state.subagents,
          [parentTurnId]: { ...current, running, runs },
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
              seq: state.nextSeq,
              ...(thinking ? { thinking } : {}),
              ...(images.length ? { images } : {}),
            } satisfies ChatMessage,
          ]
      return { ...state, messages, ...(existing ? {} : { nextSeq: state.nextSeq + 1 }) }
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
      const exists = state.messages.some((message) => message.id === id)
      const messages = exists
        ? state.messages.map((message) => (message.id === id ? apply(message) : message))
        : [
            ...state.messages,
            apply({ id, role: 'assistant' as const, text: '', seq: state.nextSeq }),
          ]
      const counted = kind === 'text' ? fragment.length : 0
      return {
        ...state,
        messages,
        streamedChars: state.streamedChars + counted,
        ...(exists ? {} : { nextSeq: state.nextSeq + 1 }),
      }
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
      return { ...state, turn: 'running', streamedChars: 0, interrupted: false }
    case 'turn.completed':
      return {
        ...state,
        turn: 'idle',
        messages: finalizeStreaming(state.messages),
        tools: settleRunningTools(state.tools),
      }
    case 'turn.aborted': {
      const messages = finalizeStreaming(state.messages)
      const tools = settleRunningTools(state.tools)
      // reason=error 时 error.raised 通常已给出具体原因，不覆盖；user_interrupt
      // 才是「用户中断」语义——走 interrupted 友好提示（可重试），不与报错
      // notice 同槽（报错文案一律英文+code，中断提示是 UI chrome 中文）。
      const reason = payload.reason
      if (reason === 'error')
        return {
          ...state,
          turn: 'idle',
          messages,
          tools,
          notice: state.notice ?? 'turn aborted due to an error',
        }
      if (reason === 'stream_interrupted')
        return {
          ...state,
          turn: 'idle',
          messages,
          tools,
          notice: state.notice ?? 'stream interrupted',
        }
      return { ...state, turn: 'idle', messages, tools, interrupted: true }
    }
    case 'tool.requested': {
      // requested 帧带 input：非 Task 工具在此建卡并提取单行目标 + 展开正文（折叠行/
      // 详情卡的数据面；started 帧不带 input，迟到就没了）；Task 摘 agentType /
      // prompt 首行摘要（§2.7bis.5 U3 折叠行），两支时序语义与 apps/web 对齐。
      const tool = String(payload.tool)
      // MCP 工具的入参无统一 target 语义（fallback 键多为猜测），只留 JSON 正文。
      const target = mcpToolParts(tool) ? undefined : toolTargetLabel(tool, payload.input)
      const body = toolBodyLabel(tool, payload.input)
      const extras = {
        ...(target === undefined ? {} : { target }),
        ...(body === undefined ? {} : { body }),
      }
      const id = String(payload.toolUseId)
      if (tool !== 'Task') {
        const exists = state.tools.some((item) => item.toolUseId === id)
        if (exists)
          return {
            ...state,
            tools: state.tools.map((item) =>
              item.toolUseId === id ? { ...item, ...extras } : item,
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
      const task = taskSummaryOf(input)
      const exists = state.tools.some((item) => item.toolUseId === id)
      if (exists)
        return {
          ...state,
          tools: state.tools.map((item) =>
            item.toolUseId === id ? { ...item, ...(task ? { task } : {}), ...extras } : item,
          ),
        }
      return {
        ...state,
        nextSeq: state.nextSeq + 1,
        tools: [
          ...state.tools,
          {
            toolUseId: id,
            tool: 'Task',
            status: 'running',
            seq: state.nextSeq,
            ...(task ? { task } : {}),
            ...extras,
          },
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
        nextSeq: state.nextSeq + 1,
        tools: [
          ...state.tools,
          {
            toolUseId: String(payload.toolUseId),
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
      // 通知格式 = `code: 细节`：code 面向 grep/遥测，细节由 runner 出英文人话。
      return { ...state, notice: `${String(payload.code ?? '')}: ${String(detail)}` }
    }
    default:
      break
  }
  if (envelope.kind === 'view') {
    const view = event as unknown as {
      type: string
      request?: PermissionCard | AskCard
      requests?: (PermissionCard | AskCard)[]
      message?: string
    }
    // 完整队列投影（requests）优先；旧网关只带队首（request）时降级单卡数组。
    // expiresAt（网关超时兜底的绝对截止）盖章在帧上，摊给队列里每张卡。
    if (view.type === 'permission.request') {
      const rawExpiresAt = (view as { expiresAt?: unknown }).expiresAt
      const expiresAt = typeof rawExpiresAt === 'number' ? rawExpiresAt : undefined
      const rawQueue =
        Array.isArray(view.requests) && view.requests.length > 0
          ? (view.requests as PermissionCard[])
          : view.request
            ? [view.request as PermissionCard]
            : []
      const queue = rawQueue.map((card) =>
        expiresAt === undefined ? card : { ...card, expiresAt },
      )
      return queue.length > 0 ? { ...state, permissions: queue } : state
    }
    if (view.type === 'permission.resolved') return { ...state, permissions: [] }
    // 提问队列：同款投影/清空语义（问答卡多 tab 的数据源）。
    // expiresAt（网关超时自动关闭的绝对截止）盖章在帧上，摊给队列里每张卡。
    if (view.type === 'ask.request') {
      const rawExpiresAt = (view as { expiresAt?: unknown }).expiresAt
      const expiresAt = typeof rawExpiresAt === 'number' ? rawExpiresAt : undefined
      const rawQueue =
        Array.isArray(view.requests) && view.requests.length > 0
          ? (view.requests as AskCard[])
          : view.request
            ? [view.request as AskCard]
            : []
      const queue = rawQueue.map((card) =>
        expiresAt === undefined ? card : { ...card, expiresAt },
      )
      return queue.length > 0 ? { ...state, asks: queue } : state
    }
    if (view.type === 'ask.resolved') return { ...state, asks: [] }
    if (view.type === 'turn.failed')
      return {
        ...state,
        turn: 'idle',
        messages: finalizeStreaming(state.messages),
        tools: settleRunningTools(state.tools),
        notice: view.message ?? 'turn failed',
      }
    // session.attached 不在这里清屏：多设备共用单活动会话时它是对全员广播的
    // （任何一台设备 resume，哪怕同一个会话，都会触发）——重置交由 page 层
    // 判定「同会话忽略 / 异会话跟随 + hydrate 全量重建」，这里动 messages
    // 会把其他设备的上下文打空（还能发消息，但历史看不见）。
    if (view.type === 'session.attached') return state
    // 网关合成的机器在线状态（uplink 断开/重连）：离线即提示，上线仅清离线条。
    if (view.type === 'machine.offline') return { ...state, notice: machineOfflineNotice() }
    if (view.type === 'machine.online')
      return state.notice === machineOfflineNotice() ? { ...state, notice: undefined } : state
  }
  return state
}

export function reduceChatState(state: ChatState, action: StreamAction): ChatState {
  // 迟到者恢复：hello.turnRunning=true 时补运行态（中断按钮可见）。
  // 终态由后续 turn.completed/aborted 事件正常收回——错过终态的极端窗口
  // （attach 前一瞬完成）订阅保证不存在：hello 与订阅在同一次同步段内建立。
  if (action.type === 'turn-restored') return { ...state, turn: 'running', lastEventAt: Date.now() }
  if (action.type === 'turn-stalled') {
    // 停摆兜底：终态帧丢失（断线窗口/机器侧静默崩）时 UI 主动收口流式气泡并
    // 提示。turn 态不动——机器侧可能仍在跑，中断按钮保持可用；真正的终态
    // 到达后照常收回。已有其他提示时不覆盖；无事可做时返回原引用（不触发渲染）。
    const messages = finalizeStreaming(state.messages)
    if (messages === state.messages && state.notice !== undefined) return state
    return { ...state, messages, notice: state.notice ?? turnStalledNotice() }
  }
  if (action.type === 'envelope') {
    const event = action.envelope.event as Partial<Event>
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return state
    const next = reduceEnvelope(state, action.envelope)
    // 每封信封都是活性信号：停摆兜底按它计时。
    return next === state ? state : { ...next, lastEventAt: Date.now() }
  }
  switch (action.type) {
    case 'hydrate': {
      // 合并而非整体替换：hydrate 与 WS 并发时，快照后到达的增量不能被冲掉；
      // 本地回声一律丢弃。快照里的 tool 条目（TranscriptToolEntry）重建折叠卡：
      // target/body/task 从快照携带的 input 现算；同 id 工具卡内容以 live 卡
      // 优先（turnId/实时状态不丢，快照重建补位缺的 target/body/task）。
      // seq 全量重排、快照序为唯一权威——活体条目若保留旧 seq（必然小于本轮
      // 分配的新 seq），重连水合后全部活体工具卡会浮到所有消息前面，多波工具
      // 被挤成一个「N 次工具调用」大分组；快照后才到达的增量（live 独有）按
      // 原到达序接尾。
      const parsed: (
        | { kind: 'message'; message: ChatMessage }
        | { kind: 'tool'; tool: ToolCard }
      )[] = []
      for (const entry of action.transcript) {
        const item = entry as {
          id?: string
          role?: string
          text?: string
          kind?: string
          tool?: string
          input?: unknown
          status?: string
          attachments?: readonly {
            chip?: string
            kind?: string
            mime?: string
            handle?: string
          }[]
        }
        if (!item.id) continue
        if (item.kind === 'tool') {
          if (typeof item.tool !== 'string') continue
          const status: ToolCard['status'] =
            item.status === 'error' ? 'error' : item.status === 'running' ? 'running' : 'done'
          const target = toolTargetLabel(item.tool, item.input)
          const body = toolBodyLabel(item.tool, item.input)
          const task = item.tool === 'Task' ? taskSummaryOf(item.input) : undefined
          parsed.push({
            kind: 'tool',
            tool: {
              toolUseId: item.id,
              tool: item.tool,
              status,
              ...(target === undefined ? {} : { target }),
              ...(body === undefined ? {} : { body }),
              ...(task === undefined ? {} : { task }),
            },
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
        const images: ChatMessageImage[] = attachments.map((attachment) => ({
          chip: attachment.chip,
          handle: attachment.handle,
          ...(attachment.mime ? { mime: attachment.mime } : {}),
        }))
        parsed.push({
          kind: 'message',
          message: {
            id: item.id,
            role: item.role as ChatMessage['role'],
            text: text.replace(/[^\S\n]+/g, ' ').trim(),
            ...(images.length ? { images } : {}),
          },
        })
      }
      const liveTools = new Map(state.tools.map((tool) => [tool.toolUseId, tool]))
      const hydratedMessageIds = new Set(
        parsed.flatMap((item) => (item.kind === 'message' ? [item.message.id] : [])),
      )
      const hydratedToolIds = new Set(
        parsed.flatMap((item) => (item.kind === 'tool' ? [item.tool.toolUseId] : [])),
      )
      const messages: ChatMessage[] = []
      const tools: ToolCard[] = []
      let seq = 0
      for (const item of parsed) {
        seq += 1
        if (item.kind === 'message') {
          messages.push({ ...item.message, seq })
          continue
        }
        const live = liveTools.get(item.tool.toolUseId)
        // live 卡字段覆盖快照重建（exactOptionalPropertyTypes：无显式 undefined，
        // spread 只覆盖存在的键），快照的 target/body/task 补位 live 缺的展开面。
        tools.push({ ...item.tool, ...live, seq })
      }
      // 快照后到达的增量（live 独有）：按原到达 seq 排定后接尾（必比快照新）。
      const extras = [
        ...state.messages
          .filter((message) => !message.local && !hydratedMessageIds.has(message.id))
          .map((message) => ({
            kind: 'message' as const,
            order: message.seq ?? Number.MAX_SAFE_INTEGER,
            message,
          })),
        ...state.tools
          .filter((tool) => !hydratedToolIds.has(tool.toolUseId))
          .map((tool) => ({
            kind: 'tool' as const,
            order: tool.seq ?? Number.MAX_SAFE_INTEGER,
            tool,
          })),
      ].sort((left, right) => left.order - right.order)
      for (const extra of extras) {
        seq += 1
        if (extra.kind === 'message') messages.push({ ...extra.message, seq })
        else tools.push({ ...extra.tool, seq })
      }
      return { ...state, messages, tools, nextSeq: seq + 1 }
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
            local: true,
            seq: state.nextSeq,
            ...(action.images?.length ? { images: action.images } : {}),
          },
        ],
      }
    case 'notice':
      return { ...state, notice: action.notice }
    // 发送排队（回合进行中提交的消息）：回合终态后由页面层逐条自动补发。
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
    case 'reset':
      return initialChatState
  }
}
