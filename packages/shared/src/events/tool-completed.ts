import { z } from 'zod'

/** 附录 D.2 `tool.completed`：★toolUseId ★tool ★isError ?durationMs ?linesAdded ?linesRemoved ?blocked ?blockedBy（hook）。 */
export const toolCompletedPayloadSchema = z.strictObject({
  toolUseId: z.string().min(1),
  tool: z.string().min(1),
  isError: z.boolean(),
  durationMs: z.number().int().nonnegative().optional(),
  /** 文件改写工具（Write/Edit/MultiEdit）上报的行级变更量，供 /status Usage 聚合。 */
  linesAdded: z.number().int().nonnegative().optional(),
  linesRemoved: z.number().int().nonnegative().optional(),
  blocked: z.boolean().optional(),
  blockedBy: z.literal('hook').optional(),
})
export type ToolCompletedPayload = z.infer<typeof toolCompletedPayloadSchema>
