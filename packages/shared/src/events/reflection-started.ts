import { z } from 'zod'

import { reflectionTriggerSchema } from './reflection-scheduled'

/** 附录 D.2 `reflection.started`：★runId ★trigger ?model（§21.4）。 */
export const reflectionStartedPayloadSchema = z.strictObject({
  runId: z.string().min(1),
  trigger: reflectionTriggerSchema,
  model: z.string().optional(),
})
export type ReflectionStartedPayload = z.infer<typeof reflectionStartedPayloadSchema>
