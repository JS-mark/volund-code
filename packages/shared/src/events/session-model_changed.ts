import { z } from 'zod'

/**
 * `session.model_changed`：★model（provider/model 显式 id，/model 选择落盘）。
 * resume 时由 replay 还原进 SessionState.model，之后的 turn 以 explicitModel 生效。
 */
export const sessionModelChangedPayloadSchema = z.strictObject({
  model: z.string().min(1),
})
export type SessionModelChangedPayload = z.infer<typeof sessionModelChangedPayloadSchema>
