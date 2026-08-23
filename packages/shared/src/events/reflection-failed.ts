import { z } from 'zod'

/** 附录 D.2 `reflection.failed`：★runId ★code（附录 B 扩展，如 `reflection_output_invalid`，§21.4）。 */
export const reflectionFailedPayloadSchema = z.strictObject({
  runId: z.string().min(1),
  code: z.string().min(1),
})
export type ReflectionFailedPayload = z.infer<typeof reflectionFailedPayloadSchema>
