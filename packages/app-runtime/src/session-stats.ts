import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'

import { formatShortDay } from './status-view'
import type {
  StatsModelShare,
  StatsOverview,
  StatusStatsData,
  StatusUsageData,
} from './status-view'

/**
 * /status Usage 与 Stats 页签的数据源：直接挖掘 ~/.volund/sessions/*.jsonl
 * 会话事件日志（附录 D 落盘事件）。只解析与统计相关的事件类型，message 内容行
 * （占体积大头）用子串预过滤跳过 JSON.parse，保证 /status 打开延迟可控。
 */

/** 统计关心的事件类型；其余行不 parse。 */
const TRACKED_TYPES = [
  'session.started',
  'session.resumed',
  'session.ended',
  'turn.completed',
  'stream.started',
  'stream.completed',
  'tool.completed',
] as const

export interface SessionScan {
  id: string
  /** 跟踪范围内的事件数（活跃度的代理指标）。 */
  events: number
  firstAt?: string
  lastAt?: string
  /** 已完成 stream 的 API 耗时之和（stream.started → stream.completed，按 messageId 配对）。 */
  apiDurationMs: number
  /** 仍有 stream 在途时的 stream.started 时间（Usage 页签把在途段计入 API 耗时）。 */
  openStreamStartedAt?: string
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; costUSD: number }
  linesAdded: number
  linesRemoved: number
  /** 本地日（YYYY-MM-DD）→ 事件数。 */
  dayCounts: Record<string, number>
  /** 本地日 → turn.completed 累计 token。 */
  dayTokens: Record<string, number>
  modelTokens: Record<string, number>
  modelStreams: Record<string, number>
  /** 本地日 → 模型 → token（stream.started/completed 按 messageId 配对后归入完成日）。 */
  dayModelTokens: Record<string, Record<string, number>>
}

interface TrackedEvent {
  type: string
  at?: unknown
  turnId?: unknown
  payload?: unknown
}

/** 流式扫描单个会话文件；坏行跳过（与 SessionStore 的宽容策略一致）。 */
export async function scanSessionFile(path: string, id: string): Promise<SessionScan> {
  const scan: SessionScan = {
    id,
    events: 0,
    apiDurationMs: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0 },
    linesAdded: 0,
    linesRemoved: 0,
    dayCounts: {},
    dayTokens: {},
    modelTokens: {},
    modelStreams: {},
    dayModelTokens: {},
  }
  const streamStartedAt = new Map<string, { at: number; model?: string }>()
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line || !TRACKED_TYPES.some((type) => line.includes(`"type":"${type}"`))) continue
    let event: TrackedEvent
    try {
      event = JSON.parse(line) as TrackedEvent
    } catch {
      continue
    }
    if (!TRACKED_TYPES.includes(event.type as (typeof TRACKED_TYPES)[number])) continue
    const at = typeof event.at === 'string' ? event.at : undefined
    const atMs = at ? Date.parse(at) : Number.NaN
    if (!at || Number.isNaN(atMs)) continue
    const payload =
      event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : {}
    scan.events += 1
    if (!scan.firstAt || at < scan.firstAt) scan.firstAt = at
    if (!scan.lastAt || at > scan.lastAt) scan.lastAt = at
    const day = localDayKey(atMs)
    scan.dayCounts[day] = (scan.dayCounts[day] ?? 0) + 1

    if (event.type === 'stream.started') {
      const messageId = typeof payload.messageId === 'string' ? payload.messageId : undefined
      const model = typeof payload.model === 'string' && payload.model ? payload.model : undefined
      if (model) scan.modelStreams[model] = (scan.modelStreams[model] ?? 0) + 1
      if (messageId) streamStartedAt.set(messageId, { at: atMs, ...(model ? { model } : {}) })
      continue
    }
    if (event.type === 'stream.completed') {
      const messageId = typeof payload.messageId === 'string' ? payload.messageId : undefined
      const started = messageId ? streamStartedAt.get(messageId) : undefined
      if (messageId && started) {
        streamStartedAt.delete(messageId)
        scan.apiDurationMs += Math.max(0, atMs - started.at)
      }
      const usage = readUsage(payload.usage)
      if (usage && started?.model) {
        const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
        scan.modelTokens[started.model] = (scan.modelTokens[started.model] ?? 0) + total
        const perDay = (scan.dayModelTokens[day] ??= {})
        perDay[started.model] = (perDay[started.model] ?? 0) + total
      }
      continue
    }
    if (event.type === 'turn.completed') {
      const usage = readUsage(payload.usage)
      if (usage) {
        scan.tokens.input += usage.input
        scan.tokens.output += usage.output
        scan.tokens.cacheRead += usage.cacheRead
        scan.tokens.cacheWrite += usage.cacheWrite
        scan.tokens.costUSD += usage.costUSD
        const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
        scan.dayTokens[day] = (scan.dayTokens[day] ?? 0) + total
      }
      continue
    }
    if (event.type === 'tool.completed') {
      if (typeof payload.linesAdded === 'number' && payload.linesAdded > 0)
        scan.linesAdded += payload.linesAdded
      if (typeof payload.linesRemoved === 'number' && payload.linesRemoved > 0)
        scan.linesRemoved += payload.linesRemoved
      continue
    }
  }
  // 会话仍在进行：最早一个未配对的 stream.started 视同在途 API 段。
  const openAt = Math.min(...[...streamStartedAt.values()].map((entry) => entry.at))
  if (Number.isFinite(openAt)) scan.openStreamStartedAt = new Date(openAt).toISOString()
  return scan
}

export async function scanSessionsDir(sessionsDir: string): Promise<SessionScan[]> {
  let entries: string[]
  try {
    entries = await readdir(sessionsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const scans = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.jsonl'))
      .map(async (entry) => {
        try {
          return await scanSessionFile(`${sessionsDir}/${entry}`, entry.slice(0, -'.jsonl'.length))
        } catch {
          return undefined // 单个坏文件不影响整体统计
        }
      }),
  )
  return scans.filter((scan): scan is SessionScan => !!scan && scan.events > 0)
}

/** /status → Usage：当前会话的实时用量（wall 时长算到 now）。 */
export function buildUsageData(
  scan: SessionScan | undefined,
  now: number,
): StatusUsageData | undefined {
  if (!scan || !scan.firstAt) return undefined
  const openApiMs = scan.openStreamStartedAt
    ? Math.max(0, now - Date.parse(scan.openStreamStartedAt))
    : 0
  return {
    costUSD: scan.tokens.costUSD,
    apiDurationMs: scan.apiDurationMs + openApiMs,
    wallDurationMs: Math.max(0, now - Date.parse(scan.firstAt)),
    linesAdded: scan.linesAdded,
    linesRemoved: scan.linesRemoved,
    tokens: {
      input: scan.tokens.input,
      output: scan.tokens.output,
      cacheRead: scan.tokens.cacheRead,
      cacheWrite: scan.tokens.cacheWrite,
    },
  }
}

/** /status → Stats：跨会话聚合（热力图固定 trailing 53 周，三个 range 预计算）。 */
export function buildStatsData(scans: readonly SessionScan[], now: number): StatusStatsData {
  const today = new Date(now)
  const todayKey = dayKeyFromDate(today)
  const dayEvents = new Map<string, number>()
  const dayTokens = new Map<string, number>()
  const modelDayTokens = new Map<string, Map<string, number>>()
  let firstActiveDay: string | undefined
  for (const scan of scans) {
    for (const [day, count] of Object.entries(scan.dayCounts)) {
      dayEvents.set(day, (dayEvents.get(day) ?? 0) + count)
      if (!firstActiveDay || day < firstActiveDay) firstActiveDay = day
    }
    for (const [day, tokens] of Object.entries(scan.dayTokens))
      dayTokens.set(day, (dayTokens.get(day) ?? 0) + tokens)
    for (const [day, perModel] of Object.entries(scan.dayModelTokens))
      for (const [model, tokens] of Object.entries(perModel)) {
        let perDay = modelDayTokens.get(model)
        if (!perDay) modelDayTokens.set(model, (perDay = new Map()))
        perDay.set(day, (perDay.get(day) ?? 0) + tokens)
      }
  }

  // 热力图：start 取「52 周前那一周的周日」，days 覆盖到本地今天为止。
  const start = addDays(todayKey, -(52 * 7 + today.getDay()))
  const heatmapDays: number[] = []
  for (let day = start; day <= todayKey; day = addDays(day, 1))
    heatmapDays.push(dayEvents.get(day) ?? 0)

  return {
    heatmap: { start, days: heatmapDays },
    ranges: {
      all: summarizeRange(null, todayKey, firstActiveDay),
      '7d': summarizeRange(dayWindow(todayKey, 7), todayKey, firstActiveDay),
      '30d': summarizeRange(dayWindow(todayKey, 30), todayKey, firstActiveDay),
    },
  }

  function summarizeRange(
    window: Set<string> | null,
    todayKeyInner: string,
    firstActive: string | undefined,
  ): StatsOverview {
    const inRange = (day: string) => !window || window.has(day)
    const rangeScans = scans.filter((scan) =>
      Object.keys(scan.dayCounts).some((day) => inRange(day)),
    )
    let totalTokens = 0
    let mostActiveDay: string | undefined
    let mostActiveTokens = 0
    const activeDays: string[] = []
    for (const [day, tokens] of dayTokens) {
      if (!inRange(day)) continue
      totalTokens += tokens
      if (
        tokens > mostActiveTokens ||
        (tokens === mostActiveTokens && day > (mostActiveDay ?? ''))
      ) {
        mostActiveTokens = tokens
        mostActiveDay = day
      }
    }
    for (const day of dayEvents.keys()) if (inRange(day)) activeDays.push(day)
    activeDays.sort()

    const modelTotals = new Map<string, number>()
    for (const [model, perDay] of modelDayTokens)
      for (const [day, tokens] of perDay)
        if (inRange(day)) modelTotals.set(model, (modelTotals.get(model) ?? 0) + tokens)
    const modelTokenSum = [...modelTotals.values()].reduce((sum, tokens) => sum + tokens, 0)
    const models: StatsModelShare[] = [...modelTotals.entries()]
      .filter(([, tokens]) => tokens > 0)
      .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([model, tokens]) => ({
        model,
        tokens,
        share: modelTokenSum > 0 ? tokens / modelTokenSum : 0,
      }))

    let longestSessionMs = 0
    for (const scan of rangeScans)
      if (scan.firstAt && scan.lastAt)
        longestSessionMs = Math.max(
          longestSessionMs,
          Math.max(0, Date.parse(scan.lastAt) - Date.parse(scan.firstAt)),
        )

    const rangeDays = window
      ? window.size
      : Math.max(1, firstActive ? daySpan(firstActive, todayKeyInner) : 1)
    return {
      totalTokens,
      sessions: rangeScans.length,
      activeDays: activeDays.length,
      rangeDays,
      ...(models[0] ? { favoriteModel: models[0].model } : {}),
      ...(mostActiveDay && mostActiveTokens > 0
        ? { mostActiveDay: formatShortDay(mostActiveDay) }
        : {}),
      longestSessionMs,
      longestStreakDays: longestStreak(activeDays),
      currentStreakDays: currentStreak(activeDays, todayKeyInner),
      models,
    }
  }
}

function readUsage(
  value: unknown,
):
  | { input: number; output: number; cacheRead: number; cacheWrite: number; costUSD: number }
  | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const usage = value as Record<string, unknown>
  if (typeof usage.input !== 'number' || typeof usage.output !== 'number') return undefined
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: typeof usage.cacheRead === 'number' ? usage.cacheRead : 0,
    cacheWrite: typeof usage.cacheWrite === 'number' ? usage.cacheWrite : 0,
    costUSD: typeof usage.costUSD === 'number' ? usage.costUSD : 0,
  }
}

/** UTC ISO 时间戳 → 本地日 key（热力图/活跃日按用户本地时区计）。 */
export function localDayKey(atMs: number): string {
  return dayKeyFromDate(new Date(atMs))
}

export function dayKeyFromDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 在日 key 上加减天数（本地时区，字符串序 = 时间序）。 */
export function addDays(dayKey: string, delta: number): string {
  const [year = 1970, month = 1, day = 1] = dayKey.split('-').map(Number)
  return dayKeyFromDate(new Date(year, month - 1, day + delta))
}

/** 含端点的天数跨度：'2026-03-01'..'2026-03-03' → 3。 */
export function daySpan(from: string, to: string): number {
  let days = 0
  for (let day = from; day <= to; day = addDays(day, 1)) days += 1
  return days
}

/** 含今天在内的最近 N 天日 key 集合。 */
export function dayWindow(todayKey: string, days: number): Set<string> {
  const window = new Set<string>()
  for (let index = 0; index < days; index += 1) window.add(addDays(todayKey, -index))
  return window
}

/** 最长连续活跃日 run（输入为排序后的活跃日列表）。 */
export function longestStreak(activeDays: readonly string[]): number {
  let longest = 0
  let run = 0
  let previous = ''
  for (const day of activeDays) {
    run = previous && addDays(previous, 1) === day ? run + 1 : 1
    longest = Math.max(longest, run)
    previous = day
  }
  return longest
}

/** 到今天（或今天还无活动时到昨天）为止的连续活跃天数。 */
export function currentStreak(activeDays: readonly string[], todayKey: string): number {
  const active = new Set(activeDays)
  let anchor: string | undefined
  if (active.has(todayKey)) anchor = todayKey
  else if (active.has(addDays(todayKey, -1))) anchor = addDays(todayKey, -1)
  if (!anchor) return 0
  let streak = 0
  for (let day = anchor; active.has(day); day = addDays(day, -1)) streak += 1
  return streak
}
