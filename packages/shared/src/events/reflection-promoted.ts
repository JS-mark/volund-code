import { z } from 'zod'

/** 附录 D.2 `reflection.promoted`：★lessonId ★memoryId ★scope（§21.7-3）。 */
export const reflectionPromotedPayloadSchema = z.strictObject({
  lessonId: z.string().min(1),
  memoryId: z.string().min(1),
  scope: z.enum(['global', 'project']),
})
export type ReflectionPromotedPayload = z.infer<typeof reflectionPromotedPayloadSchema>
