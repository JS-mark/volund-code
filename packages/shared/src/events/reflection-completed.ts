import { z } from 'zod'

import { usageSchema } from './common'

/** 附录 D.2 `reflection.completed`：★runId ★usage ★lessonCount ★durationMs；lesson 正文不进事件（§21.7-2）。 */
export const reflectionCompletedPayloadSchema = z.strictObject({
  runId: z.string().min(1),
  usage: usageSchema,
  lessonCount: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
})
export type ReflectionCompletedPayload = z.infer<typeof reflectionCompletedPayloadSchema>
