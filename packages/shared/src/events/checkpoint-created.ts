import { z } from 'zod'

/**
 * CHECKPOINTS-r1 CP-01（附录 D.2）：会话检查点打点。
 * 锚点 = envelope 的 turnId（回卷定位按 turnId，消息 seq 由 JSONL entry index 推导）；
 * batchHead/batchCount 是打点时刻 BackupStore batch 链的头部引用与长度
 * （链完整清单由回卷层沿 tool 血统推导，CP-03）。checkpoint 是纯引用，不拷贝内容。
 */
export const checkpointCreatedPayloadSchema = z.strictObject({
  checkpointId: z.string().min(1),
  trigger: z.enum(['turn-boundary', 'pre-mutation', 'manual']),
  batchCount: z.number().int().nonnegative(),
  batchHead: z.string().min(1).optional(),
})

export type CheckpointCreatedPayload = z.infer<typeof checkpointCreatedPayloadSchema>
