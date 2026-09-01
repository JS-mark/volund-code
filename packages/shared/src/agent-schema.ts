import { z } from 'zod'

/**
 * §2.7.1 自定义 subagent 定义 frontmatter 契约（r13-G3）。
 * 文件位置：`~/.volund/agents/<name>.md`（user，trusted）与
 * `<cwd>/.volund/agents/<name>.md`（project，untrusted，同名覆盖 user）。
 * `name` 必须与文件名（去 .md）一致——由装载器校验，schema 只管形状。
 */
export const agentDefinitionSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/, 'agent name must match [a-z0-9-]+'),
    description: z.string().min(1),
    model: z
      .object({ provider: z.string().min(1), model: z.string().min(1) })
      .strict()
      .optional(),
    tools: z.array(z.string().min(1)).min(1).optional(),
    maxTurns: z.number().int().min(1).optional(),
  })
  .strict()

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>

/**
 * 解析并校验 agent 定义。`allowedTools` 提供时（父注册表的工具名全集），
 * `tools` 白名单超出父集 → 拒绝（§2.7.1：只能收紧不能放宽）。
 */
export function parseAgentDefinition(
  raw: unknown,
  options?: { allowedTools?: readonly string[] },
): AgentDefinition {
  const parsed = agentDefinitionSchema.parse(raw)
  if (options?.allowedTools && parsed.tools) {
    const known = new Set(options.allowedTools)
    const unknown = parsed.tools.filter((tool) => !known.has(tool))
    if (unknown.length > 0)
      throw new Error(`agent tools exceed parent registry: ${unknown.join(', ')}`)
  }
  return parsed
}
