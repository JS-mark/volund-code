import { z } from 'zod'

/** 附录 D.2 `session.started`：★cwd ?configHash ?volundVersion（§8.2 样例）。 */
export const sessionStartedPayloadSchema = z.strictObject({
  cwd: z.string().min(1),
  configHash: z.string().optional(),
  volundVersion: z.string().optional(),
})
export type SessionStartedPayload = z.infer<typeof sessionStartedPayloadSchema>
