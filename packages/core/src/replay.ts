import type { ContentPart, Message } from '@volund/provider-kit'
import { EVENT_SCHEMAS, type EventName, type JsonValue } from '@volund/shared'

import { createSession, updateSession, type SessionState } from './session'

/**
 * §8.2 replay 输入（storage JSONL 行的结构子集：v/id/type/sessionId/at/payload +
 * envelope turnId / subagent 冒泡 tag）。storage 层保持纯文件 I/O，重建逻辑集中在 core。
 */
export interface ReplayableEvent {
  id: string
  type: string
  sessionId: string
  turnId?: string
  parentTurnId?: string
  parentDepth?: number
  at: string
  payload: JsonValue
}

export interface ReplayOptions {
  /** replay 事件不携带 maxTokens（§8.2 只重建 messages/turns/usage）；缺省沿用 CLI 侧默认。 */
  maxTokens?: number
  toolRegistrySnapshot?: string
}

export interface ReplayResult {
  state: SessionState
  /** 至少找到一个可用源（事件或 legacy 快照）；false = 空白/无法恢复。 */
  found: boolean
  /** 无法按附录 D 契约解读而跳过的事件 id（旧形状宽容策略：映射或标注跳过，不崩）。 */
  skippedEventIds: readonly string[]
}

const terminalTurnStatuses = new Set(['done', 'aborted', 'error'])

/**
 * REM-74（r13-I8 / §8.2 D1-1）：resume 一律走事件 replay，禁止 session.snapshot 快照行。
 *
 * - 新形状（附录 D.2）：message.appended 的 ★role ★content 直接重建 messages；
 *   turn.started/completed/aborted 重建 turns；turn.completed 的 ★usage 累计。
 * - 旧形状宽容：r13 之前的历史 JSONL 里 message.appended 只有 {messageId}、
 *   turn.completed 是 {status, exitCode}——schema 校验失败的事件记入 skippedEventIds
 *   后跳过（标注跳过，不抛错）；若文件里存在 legacy `session.snapshot` 行（旧实现每
 *   turn 落一次全量 state），以最后一条快照为基线再重放其后的事件，旧 session 的
 *   messages/turns 因此完整保真。
 */
export function replaySessionState(
  sessionId: string,
  events: readonly ReplayableEvent[],
  options: ReplayOptions = {},
): ReplayResult {
  const skippedEventIds: string[] = []
  const seen = new Set<string>()
  let base: SessionState | undefined
  let start = 0
  const snapshotIndex = events.findLastIndex((event) => event.type === 'session.snapshot')
  if (snapshotIndex >= 0) {
    const payload = events[snapshotIndex]!.payload as unknown as SessionState | undefined
    if (payload && typeof payload === 'object' && typeof payload.id === 'string') {
      base = payload
      start = snapshotIndex + 1
    } else {
      skippedEventIds.push(events[snapshotIndex]!.id)
    }
  }
  const state =
    base ??
    createSession({
      id: sessionId,
      cwd: cwdOf(events),
      maxTokens: options.maxTokens ?? 200_000,
      toolRegistrySnapshot: options.toolRegistrySnapshot ?? '',
    })
  let found = base !== undefined || events.some((event) => event.type === 'session.started')
  let draft = state
  for (const event of events.slice(start)) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    const schema = EVENT_SCHEMAS[event.type as EventName]
    if (!schema) continue // 未知事件类型（如 legacy session.snapshot 中段行）：跳过
    const parsed = schema.safeParse(event.payload)
    if (!parsed.success) {
      // 旧形状宽容：turn.* 用 envelope turnId 映射（旧 emit 只带 {}/{status,exitCode}），
      // 其余跳过并标注（resume 不崩，PR 报告跳过清单）。
      if (event.type === 'turn.started' && event.turnId) {
        found = true
        draft = updateSession(draft, (target) => {
          target.turns = [
            ...target.turns,
            {
              id: event.turnId!,
              startMessageId: '',
              status: 'streaming',
              parentDepth: event.parentDepth ?? 0,
            },
          ]
        })
      } else if (event.type === 'turn.completed' || event.type === 'turn.aborted') {
        draft = settleTurn(draft, event.turnId ?? '', event.type === 'turn.aborted')
        found = true
      } else {
        skippedEventIds.push(event.id)
      }
      continue
    }
    const payload = parsed.data as Record<string, unknown>
    switch (event.type) {
      case 'session.started':
        found = true
        if (typeof payload.cwd === 'string' && payload.cwd && !base)
          draft = updateSession(draft, (target) => {
            target.cwd = payload.cwd as string
          })
        break
      case 'turn.started':
        found = true
        draft = updateSession(draft, (target) => {
          target.turns = [
            ...target.turns,
            {
              id: String(payload.turnId ?? event.turnId ?? ''),
              startMessageId: '',
              status: 'streaming',
              parentDepth: event.parentDepth ?? 0,
              ...(typeof payload.parentTurnId === 'string'
                ? { parentTurnId: payload.parentTurnId }
                : {}),
              ...(typeof payload.agentType === 'string' ? { agentType: payload.agentType } : {}),
            },
          ]
        })
        break
      case 'turn.completed':
        draft = updateSession(draft, (target) => {
          const usage = payload.usage as SessionState['cumulativeUsage']
          target.cumulativeUsage.input += usage.input
          target.cumulativeUsage.output += usage.output
          target.cumulativeUsage.cacheRead =
            (target.cumulativeUsage.cacheRead ?? 0) + (usage.cacheRead ?? 0)
          target.cumulativeUsage.cacheWrite =
            (target.cumulativeUsage.cacheWrite ?? 0) + (usage.cacheWrite ?? 0)
          target.cumulativeUsage.costUSD += usage.costUSD ?? 0
        })
        draft = settleTurn(draft, String(payload.turnId ?? event.turnId ?? ''), false)
        break
      case 'turn.aborted':
        draft = settleTurn(draft, String(payload.turnId ?? event.turnId ?? ''), true)
        break
      case 'message.appended': {
        const message: Message = {
          id: String(payload.messageId),
          role: payload.role as Message['role'],
          content: payload.content as ContentPart[],
          createdAt: Date.parse(event.at) || Date.now(),
        }
        draft = updateSession(draft, (target) => {
          target.messages = [...target.messages, message]
        })
        break
      }
      default:
        break // 其余事件（stream/tool/router/error/context/shell）不参与 state 重建
    }
  }
  const settled = updateSession(draft, (target) => {
    target.activeTurn = null
    target.pendingInterrupt = false
    target.turns = target.turns.map((turn) =>
      terminalTurnStatuses.has(turn.status) ? turn : { ...turn, status: 'aborted' },
    )
  })
  return { state: settled, found, skippedEventIds }
}

function settleTurn(state: SessionState, turnId: string, aborted: boolean): SessionState {
  if (!turnId) return state
  return updateSession(state, (draft) => {
    const turn = draft.turns.find((item) => item.id === turnId)
    if (turn) turn.status = aborted ? 'aborted' : 'done'
  })
}

function cwdOf(events: readonly ReplayableEvent[]): string {
  for (const event of events) {
    if (event.type !== 'session.started') continue
    const parsed = EVENT_SCHEMAS['session.started'].safeParse(event.payload)
    if (parsed.success && parsed.data.cwd) return parsed.data.cwd
    const legacy = event.payload as { cwd?: unknown }
    if (legacy && typeof legacy.cwd === 'string') return legacy.cwd
  }
  return ''
}
