import { z } from 'zod'

import { contextCompactedPayloadSchema } from './context-compacted'
import type { EventName } from './envelope'
import { eventEnvelopeSchema } from './envelope'
import { errorRaisedPayloadSchema } from './error-raised'
import { messageAppendedPayloadSchema } from './message-appended'
import { reflectionCompletedPayloadSchema } from './reflection-completed'
import { reflectionFailedPayloadSchema } from './reflection-failed'
import { reflectionPromotedPayloadSchema } from './reflection-promoted'
import { reflectionScheduledPayloadSchema } from './reflection-scheduled'
import { reflectionSkippedPayloadSchema } from './reflection-skipped'
import { reflectionStartedPayloadSchema } from './reflection-started'
import { routerSwitchedPayloadSchema } from './router-switched'
import { sessionEndedPayloadSchema } from './session-ended'
import { sessionResumedPayloadSchema } from './session-resumed'
import { sessionStartedPayloadSchema } from './session-started'
import { shellBackgroundExitedPayloadSchema } from './shell-background_exited'
import { shellBackgroundStartedPayloadSchema } from './shell-background_started'
import { streamCompletedPayloadSchema } from './stream-completed'
import { streamDeltaPayloadSchema } from './stream-delta'
import { streamStartedPayloadSchema } from './stream-started'
import { toolCompletedPayloadSchema } from './tool-completed'
import { toolPermissionAskedPayloadSchema } from './tool-permission_asked'
import { toolRequestedPayloadSchema } from './tool-requested'
import { toolStartedPayloadSchema } from './tool-started'
import { turnAbortedPayloadSchema } from './turn-aborted'
import { turnCompletedPayloadSchema } from './turn-completed'
import { turnStartedPayloadSchema } from './turn-started'

/**
 * 附录 D.2 二十五事件 → per-event payload schema 汇总（事件名 → schema）。
 * replay / §8.2 迁移 / --json 外部消费以本 map + eventEnvelopeFor 为稳定契约。
 */
export const EVENT_SCHEMAS = {
  'session.started': sessionStartedPayloadSchema,
  'session.ended': sessionEndedPayloadSchema,
  'session.resumed': sessionResumedPayloadSchema,
  'turn.started': turnStartedPayloadSchema,
  'turn.completed': turnCompletedPayloadSchema,
  'turn.aborted': turnAbortedPayloadSchema,
  'message.appended': messageAppendedPayloadSchema,
  'stream.started': streamStartedPayloadSchema,
  'stream.delta': streamDeltaPayloadSchema,
  'stream.completed': streamCompletedPayloadSchema,
  'tool.requested': toolRequestedPayloadSchema,
  'tool.permission_asked': toolPermissionAskedPayloadSchema,
  'tool.started': toolStartedPayloadSchema,
  'tool.completed': toolCompletedPayloadSchema,
  'shell.background_started': shellBackgroundStartedPayloadSchema,
  'shell.background_exited': shellBackgroundExitedPayloadSchema,
  'context.compacted': contextCompactedPayloadSchema,
  'router.switched': routerSwitchedPayloadSchema,
  'error.raised': errorRaisedPayloadSchema,
  'reflection.scheduled': reflectionScheduledPayloadSchema,
  'reflection.started': reflectionStartedPayloadSchema,
  'reflection.completed': reflectionCompletedPayloadSchema,
  'reflection.failed': reflectionFailedPayloadSchema,
  'reflection.skipped': reflectionSkippedPayloadSchema,
  'reflection.promoted': reflectionPromotedPayloadSchema,
} as const satisfies Record<EventName, z.ZodType>

export type EventSchemas = typeof EVENT_SCHEMAS
export type EventPayload<T extends EventName = EventName> = z.infer<EventSchemas[T]>

/**
 * 按事件名收紧 payload 的 envelope schema（replay / 外部消费校验入口）：
 * envelope 骨架（附录 D.1）+ 该事件的 payload 契约（附录 D.2）。
 */
export function eventEnvelopeFor<T extends EventName>(type: T) {
  return eventEnvelopeSchema.extend({
    type: z.literal(type),
    payload: EVENT_SCHEMAS[type],
  })
}

export {
  attachmentRefSchema,
  contentPartSchema,
  jsonValueSchema,
  permissionSpecSummarySchema,
  usageSchema,
  type EventAttachmentRef,
  type EventContent,
  type EventFilePart,
  type EventImagePart,
  type EventPermissionSpecSummary,
  type EventTextPart,
  type EventThinkingPart,
  type EventToolResultPart,
  type EventToolUsePart,
  type EventUsage,
} from './common'
export {
  EVENT_NAMES,
  eventEnvelopeSchema,
  uuidV7Schema,
  type EventEnvelope,
  type EventName,
} from './envelope'
export { contextCompactedPayloadSchema, type ContextCompactedPayload } from './context-compacted'
export { errorRaisedPayloadSchema, type ErrorRaisedPayload } from './error-raised'
export { messageAppendedPayloadSchema, type MessageAppendedPayload } from './message-appended'
export { routerSwitchedPayloadSchema, type RouterSwitchedPayload } from './router-switched'
export { sessionEndedPayloadSchema, type SessionEndedPayload } from './session-ended'
export { sessionResumedPayloadSchema, type SessionResumedPayload } from './session-resumed'
export { sessionStartedPayloadSchema, type SessionStartedPayload } from './session-started'
export {
  shellBackgroundExitedPayloadSchema,
  type ShellBackgroundExitedPayload,
} from './shell-background_exited'
export {
  shellBackgroundStartedPayloadSchema,
  type ShellBackgroundStartedPayload,
} from './shell-background_started'
export { streamCompletedPayloadSchema, type StreamCompletedPayload } from './stream-completed'
export { streamDeltaPayloadSchema, type StreamDeltaPayload } from './stream-delta'
export { streamStartedPayloadSchema, type StreamStartedPayload } from './stream-started'
export { toolCompletedPayloadSchema, type ToolCompletedPayload } from './tool-completed'
export {
  toolPermissionAskedPayloadSchema,
  type ToolPermissionAskedPayload,
} from './tool-permission_asked'
export { toolRequestedPayloadSchema, type ToolRequestedPayload } from './tool-requested'
export { toolStartedPayloadSchema, type ToolStartedPayload } from './tool-started'
export { turnAbortedPayloadSchema, type TurnAbortedPayload } from './turn-aborted'
export { turnCompletedPayloadSchema, type TurnCompletedPayload } from './turn-completed'
export { turnStartedPayloadSchema, type TurnStartedPayload } from './turn-started'
