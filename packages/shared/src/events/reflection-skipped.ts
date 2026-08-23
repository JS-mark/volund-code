import { z } from 'zod'

/** 附录 D.2 `reflection.skipped`：★reason 闭枚举（§21.3/§21.5）。 */
export const reflectionSkippedPayloadSchema = z.strictObject({
  reason: z.enum([
    'budget_exhausted',
    'disabled',
    'no_new_content',
    'preempted',
    'duplicate',
    'cooldown',
  ]),
})
export type ReflectionSkippedPayload = z.infer<typeof reflectionSkippedPayloadSchema>
