import { z } from 'zod'

import { jsonValueSchema } from './common'

/**
 * §2.3 事件表全集（25 种；与附录 D.2 字段表一一对应）。
 * CI 强制：§2.3 表新增行而无对应 schema 文件 → fail（scripts/verify-event-schemas.mjs）。
 */
export const EVENT_NAMES = [
  'session.started',
  'session.ended',
  'session.resumed',
  'turn.started',
  'turn.completed',
  'turn.aborted',
  'message.appended',
  'stream.started',
  'stream.delta',
  'stream.completed',
  'tool.requested',
  'tool.permission_asked',
  'tool.started',
  'tool.completed',
  'shell.background_started',
  'shell.background_exited',
  'context.compacted',
  'router.switched',
  'error.raised',
  'reflection.scheduled',
  'reflection.started',
  'reflection.completed',
  'reflection.failed',
  'reflection.skipped',
  'reflection.promoted',
] as const
export type EventName = (typeof EVENT_NAMES)[number]

/** UUIDv7（§2.3 W9：时间前缀 + 单调，subscriber 以 event.id 做 seen-set 去重键）。 */
export const uuidV7Schema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'must be a UUIDv7 (time-prefixed) identifier',
  )

/**
 * 公共 envelope（§2.3 / 附录 D.1）：
 * id（UUIDv7）/ type / version / sessionId / turnId? / at / payload，
 * 外加附录 D.3 subagent 冒泡 tag（parentTurnId? / parentDepth?——只在事件从子总线
 * 冒泡到父总线时出现，payload 不动）。
 * 本 schema 只校验 envelope 骨架；payload 按 type 收紧用 index.ts 的 eventEnvelopeFor。
 */
export const eventEnvelopeSchema = z.strictObject({
  id: uuidV7Schema,
  type: z.enum(EVENT_NAMES),
  version: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  parentTurnId: z.string().min(1).optional(),
  parentDepth: z.number().int().nonnegative().optional(),
  at: z.number().int().nonnegative(),
  payload: jsonValueSchema,
})
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>
