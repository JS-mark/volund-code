import { z } from 'zod'

/** 附录 D.2 `reflection.scheduled` / `reflection.started` 共用的 trigger 闭枚举（§21.3）。 */
export const reflectionTriggerSchema = z.enum(['on_error', 'on_compact', 'every_n_turns', 'manual'])
export type ReflectionTrigger = z.infer<typeof reflectionTriggerSchema>

/** 附录 D.2 `reflection.scheduled`：★trigger ★turnId（§21.3/§21.5）。 */
export const reflectionScheduledPayloadSchema = z.strictObject({
  trigger: reflectionTriggerSchema,
  turnId: z.string().min(1),
})
export type ReflectionScheduledPayload = z.infer<typeof reflectionScheduledPayloadSchema>
