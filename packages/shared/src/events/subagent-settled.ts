import { z } from 'zod'

import { usageSchema } from './common'

/**
 * 附录 D.2 `subagent.settled`（§2.7bis，SAG-01）：
 * ★sessionId ★status ★usage ★ctxOut（回传 token）★toolCalls ★durationMs ?conflicts ?detail。
 * 账本（§2.7bis.1 ledger）唯一数据源：per-turn / per-session / per-agentType 成本派生自此事件。
 * `interrupted` 不是 settled status——crash 后由注册表重放重建时合成标记，不产生本事件。
 */
export const subagentSettledPayloadSchema = z.strictObject({
  sessionId: z.string().min(1),
  status: z.enum(['completed', 'failed', 'cancelled']),
  usage: usageSchema,
  ctxOut: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative().optional(),
  detail: z.string().optional(),
})
export type SubagentSettledPayload = z.infer<typeof subagentSettledPayloadSchema>
