import type { TranscriptEntry } from '@volund/app-runtime'

import { formatPermissionTextForDisplay } from './permission-display'

/**
 * 工具活动行（◆ 正在读取 …）的数据模型与纯函数。
 *
 * 数据流：runner 的 `tool.requested`（附录 D.2，★input 携带工具参数）创建条目，
 * `tool.completed` 按 toolUseId 定稿（成功/失败 + 耗时 + 行级变更）。条目随事件
 * 进时间线，与 transcript 消息按事件 id（uuidv7 ≈ 时间序）归并渲染——对话流里
 * 的「助手消息 → 工具活动 → 下一条助手消息」顺序由此而来。
 */
export interface ActivityItem {
  /** tool.requested 的事件 id（uuidv7，字典序≈时间序）。 */
  id: string
  toolUseId: string
  tool: string
  /** 从 input 提取的展示目标（路径/命令/模式…），已清洗截断；无目标时省略。 */
  target?: string
  status: 'running' | 'done' | 'error'
  /** 被 PreToolUse hook 拦截（tool.completed ?blocked）：渲染「已被拦截」。 */
  blocked?: boolean
  durationMs?: number
  linesAdded?: number
  linesRemoved?: number
}

/** 时间线条目：transcript 消息与工具活动的并集（ScrollableTranscript 的输入）。 */
export type TimelineItem =
  | { entry: TranscriptEntry; kind: 'message' }
  | { item: ActivityItem; kind: 'activity' }

interface ActivityVerbs {
  running: string
  done: string
  error: string
}

const TOOL_VERBS: Record<string, ActivityVerbs> = {
  Read: { running: '正在读取', done: '已读取', error: '读取失败' },
  Write: { running: '正在写入', done: '已写入', error: '写入失败' },
  Edit: { running: '正在修改', done: '已修改', error: '修改失败' },
  MultiEdit: { running: '正在修改', done: '已修改', error: '修改失败' },
  Bash: { running: '正在运行', done: '已运行', error: '运行失败' },
  Glob: { running: '正在查找', done: '查找完成', error: '查找失败' },
  Grep: { running: '正在搜索', done: '搜索完成', error: '搜索失败' },
  WebFetch: { running: '正在抓取', done: '抓取完成', error: '抓取失败' },
  WebSearch: { running: '正在联网搜索', done: '搜索完成', error: '搜索失败' },
  Task: { running: '正在运行子代理', done: '子代理完成', error: '子代理失败' },
  Todo: { running: '正在更新待办', done: '待办已更新', error: '待办更新失败' },
  ShellOutput: { running: '正在读取输出', done: '已读取输出', error: '读取失败' },
  KillShell: { running: '正在终止进程', done: '已终止进程', error: '终止失败' },
}

export function activityVerbs(tool: string): ActivityVerbs {
  return (
    TOOL_VERBS[tool] ?? { running: `正在使用 ${tool}`, done: `${tool} 完成`, error: `${tool} 失败` }
  )
}

/** 各工具最具辨识度的参数名（Grep/Glob 取 pattern 而非可选的 path 搜索根）。 */
const TARGET_KEY_BY_TOOL: Record<string, string> = {
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

/** 未知工具的兜底候选键（按辨识度排序；绝不取 content/old_string 等正文参数）。 */
const FALLBACK_TARGET_KEYS = ['path', 'file_path', 'command', 'pattern', 'url', 'query'] as const

const MAX_TARGET_LENGTH = 72
/** permission-display 对换行的注入安全转义 token（详见 NEWLINE_TOKEN 使用处）。 */
const NEWLINE_TOKEN = '\\u{000A}'

/**
 * 从 tool.requested 的 input 提取单行展示目标。input 是模型产出的不可信文本：
 * 先过 SafeDisplay 转义（bidi/控制字符），再把换行 token 压成空格，最后截断。
 */
export function activityTarget(tool: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const record = input as Record<string, unknown>
  const preferred = TARGET_KEY_BY_TOOL[tool]
  const raw =
    (preferred ? stringValue(record[preferred]) : undefined) ??
    FALLBACK_TARGET_KEYS.map((key) => stringValue(record[key])).find((value) => value !== undefined)
  if (!raw) return undefined
  const escaped = formatPermissionTextForDisplay(raw).text
  const oneLine = escaped.split(NEWLINE_TOKEN).join(' ').replace(/\s+/g, ' ').trim()
  if (!oneLine) return undefined
  const prefixed = tool === 'Bash' ? `$ ${oneLine}` : oneLine
  return prefixed.length > MAX_TARGET_LENGTH
    ? `${prefixed.slice(0, MAX_TARGET_LENGTH - 1)}…`
    : prefixed
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** tool.completed 载荷里与活动行相关的字段（附录 D.2）。 */
export interface ActivityCompletion {
  isError: boolean
  blocked?: boolean
  durationMs?: number
  linesAdded?: number
  linesRemoved?: number
}

/** 按 toolUseId 定稿活动条目；未找到（如回放缺 requested）时原样返回。 */
export function completeActivity(
  activities: readonly ActivityItem[],
  toolUseId: string,
  completion: ActivityCompletion,
): ActivityItem[] {
  if (!activities.some((item) => item.toolUseId === toolUseId)) return [...activities]
  return activities.map((item) => {
    if (item.toolUseId !== toolUseId) return item
    return {
      ...item,
      status: completion.isError ? ('error' as const) : ('done' as const),
      ...(completion.blocked !== undefined ? { blocked: completion.blocked } : {}),
      ...(completion.durationMs !== undefined ? { durationMs: completion.durationMs } : {}),
      ...(completion.linesAdded !== undefined ? { linesAdded: completion.linesAdded } : {}),
      ...(completion.linesRemoved !== undefined ? { linesRemoved: completion.linesRemoved } : {}),
    }
  })
}

/** 紧凑耗时：0.3s / 4s / 2m05s。 */
export function formatActivityDuration(durationMs: number): string {
  if (durationMs < 10_000) return `${(durationMs / 1000).toFixed(1)}s`
  if (durationMs < 60_000) return `${Math.round(durationMs / 1000)}s`
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.round((durationMs % 60_000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}

/**
 * transcript 消息与工具活动按事件 id 归并成一条时间线。notice-*（启动期系统
 * 提示）永远在最前；pending-assistant（流式暂存）永远在最后——工具活动只发生在
 * 一个 assistant step 定稿之后，时间上必然早于下一步的流式文本。
 */
export function buildTimeline(
  transcript: readonly TranscriptEntry[],
  activities: readonly ActivityItem[],
): TimelineItem[] {
  const tagged: Array<{ order: number; sortId: string; value: TimelineItem }> = [
    ...transcript.map((entry, index) => ({
      order: index,
      sortId: entry.id,
      value: { entry, kind: 'message' as const },
    })),
    ...activities.map((item, index) => ({
      order: transcript.length + index,
      sortId: item.id,
      value: { item, kind: 'activity' as const },
    })),
  ]
  tagged.sort((a, b) => compareTimelineIds(a.sortId, b.sortId) || a.order - b.order)
  return tagged.map((tag) => tag.value)
}

function compareTimelineIds(a: string, b: string): number {
  const rankA = timelineRank(a)
  const rankB = timelineRank(b)
  if (rankA !== rankB) return rankA - rankB
  if (a === b) return 0
  return a < b ? -1 : 1
}

function timelineRank(id: string): number {
  if (id.startsWith('notice-')) return 0
  if (id === 'pending-assistant') return 2
  return 1
}
