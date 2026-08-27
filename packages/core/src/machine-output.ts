import { sanitize, type JsonValue } from '@volund/shared'

import type { CoreEvent } from './event-bus'

export const machineOutputVersion = 1 as const

export type MachineEventType =
  | 'message.start'
  | 'text.delta'
  | 'tool_use'
  | 'tool_result'
  | 'error'
  | 'router.switched'
  | 'usage'
  | 'final'

export interface MachineEvent {
  v: typeof machineOutputVersion
  type: MachineEventType
  seq: number
  sessionId: string
  turnId?: string
  timestamp: string
  data: JsonValue
}

/**
 * REM-74（r13-I8）：--json NDJSON 输出协议（§7.6：v/seq/sessionId/turnId/timestamp +
 * type/data）保持稳定，输入侧全部改为附录 D.2 的 payload 形状：
 *
 * - `message.start` ← `stream.started`（★messageId）
 * - `text.delta`    ← `stream.delta`（kind=text 的 fragment 增量）
 * - `usage`         ← `stream.completed`（?usage，per-message）
 * - `tool_use`      ← `tool.requested`（★toolUseId ★tool ★input）
 * - `tool_result`   ← `tool.completed`（content 已移出事件，见附录 D.2）
 * - `final`         ← `turn.completed`（含 turn 级 usage）/ `turn.aborted`（reason 映射）
 */
export class MachineEventFormatter {
  #sequence = 0

  format(event: CoreEvent): MachineEvent | undefined {
    const base = {
      v: machineOutputVersion,
      seq: ++this.#sequence,
      sessionId: event.sessionId,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      timestamp: new Date(event.at).toISOString(),
    }
    const payload = sanitize(event.payload)
    if (event.type === 'stream.started') {
      const started = payload as { messageId?: JsonValue }
      return {
        ...base,
        type: 'message.start',
        data: { messageId: typeof started.messageId === 'string' ? started.messageId : '' },
      }
    }
    if (event.type === 'stream.delta') {
      const delta = payload as { kind?: JsonValue; fragment?: JsonValue }
      if (delta.kind !== 'text' || typeof delta.fragment !== 'string') return
      return { ...base, type: 'text.delta', data: { text: delta.fragment } }
    }
    if (event.type === 'stream.completed') {
      const completed = payload as { usage?: JsonValue }
      if (!completed.usage || typeof completed.usage !== 'object') return
      return { ...base, type: 'usage', data: completed.usage }
    }
    if (event.type === 'tool.requested') return { ...base, type: 'tool_use', data: payload }
    if (event.type === 'tool.completed') return { ...base, type: 'tool_result', data: payload }
    if (event.type === 'router.switched') return { ...base, type: 'router.switched', data: payload }
    if (event.type === 'error.raised') {
      const error = payload as Record<string, JsonValue>
      const context =
        error.context && typeof error.context === 'object' && !Array.isArray(error.context)
          ? (error.context as Record<string, JsonValue>)
          : {}
      const message = context.message
      return {
        ...base,
        type: 'error',
        data: {
          code: typeof error.code === 'string' ? error.code : 'internal_error',
          category: typeof error.category === 'string' ? error.category : 'runtime',
          ...(typeof message === 'string' ? { message } : {}),
          retryable: false,
          exitCode: 1,
        },
      }
    }
    if (event.type === 'turn.completed') {
      const usage = (payload as { usage?: JsonValue }).usage
      return {
        ...base,
        type: 'final',
        data: { status: 'completed', exitCode: 0, ...(usage ? { usage } : {}) },
      }
    }
    if (event.type === 'turn.aborted') {
      const reason = (payload as { reason?: JsonValue }).reason
      const cancelled = reason === 'user_interrupt'
      return {
        ...base,
        type: 'final',
        data: {
          status: cancelled ? 'cancelled' : 'error',
          exitCode: cancelled ? 130 : 1,
        },
      }
    }
  }

  encode(event: CoreEvent): string | undefined {
    const formatted = this.format(event)
    return formatted ? `${JSON.stringify(formatted)}\n` : undefined
  }
}
