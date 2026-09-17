import { z } from 'zod'

/**
 * 附录 D.2 `subagent.dispatched`（§2.7bis，SAG-01）：
 * ★sessionId ★parentSessionId ★parentTurnId ?agentType ★depth ★isolationTier（0|1|2）
 * ★fork ?writePaths ★budget ★promptDigest ★ctxIn（交接注入 token 估算；fork/handoff 注入计此）。
 * 发父总线落父 JSONL（非冒泡事件——D.3 冒泡规则不适用）。
 */
export const subagentDispatchedPayloadSchema = z.strictObject({
  sessionId: z.string().min(1),
  parentSessionId: z.string().min(1),
  parentTurnId: z.string().min(1),
  agentType: z.string().min(1).optional(),
  depth: z.number().int().positive(),
  isolationTier: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  fork: z.boolean(),
  writePaths: z.array(z.string().min(1)).optional(),
  budget: z.strictObject({
    tokenMax: z.number().int().positive().optional(),
    costUSDMax: z.number().positive().optional(),
    timeMsMax: z.number().int().positive().optional(),
  }),
  promptDigest: z.string().min(1),
  ctxIn: z.number().int().nonnegative(),
})
export type SubagentDispatchedPayload = z.infer<typeof subagentDispatchedPayloadSchema>
