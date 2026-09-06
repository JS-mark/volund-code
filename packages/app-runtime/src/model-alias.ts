/**
 * 模型别名解析与语言强制片段（§8.3/§6b，P1-04d）。从 runtime.ts 迁入，行为等价。
 */
import type { PromptFragment } from '@volund/core'

export function resolveModelAlias(
  raw: string,
  aliases: Record<string, { provider: string; model: string }>,
  activeProvider = 'anthropic',
): { model: string } | { mismatch: string } | undefined {
  const entry = aliases[raw.replace(new RegExp(`^${activeProvider}/`), '')]
  if (!entry) return undefined
  if (entry.provider !== activeProvider) return { mismatch: entry.provider }
  return { model: entry.model.replace(new RegExp(`^${activeProvider}/`), '') }
}

/**
 * [preferences] language 的回复语言强制片段（§6b）：显式配置才注册——不配则模型
 * 跟随输入语言，中英混杂；配置后即使输入是英文也按配置语言回复。
 */
export function languagePromptFragment(language: string): PromptFragment {
  return {
    id: 'preferences:language',
    source: 'preferences:language',
    priority: 900,
    text: `## Language\nAlways respond in ${language}, regardless of the language of the user's message, tool output, or any other content. Keep code, identifiers, and file paths as-is.`,
  }
}
