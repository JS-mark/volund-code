import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { parseAgentDefinition, type AgentDefinition } from '@volund/shared'
import { parse } from 'yaml'

/**
 * §2.7.1 自定义 subagent 定义装载器（r13-G3）。
 *
 * 两层目录，项目级同名覆盖全局：
 * - `<volundHome>/agents/<name>.md`   —— 用户自己写的，trusted
 * - `<cwd>/.volund/agents/<name>.md` —— 随 clone 进来的仓库作者可控内容，untrusted
 *
 * 冷启动只读 frontmatter（`discover()`）；正文懒加载（`readBody()`），复用
 * §6.5.3 progressive disclosure 语义。装载失败的文件跳过并回调 `onWarning`，
 * 不阻塞启动。
 */
export interface ResolvedAgentDefinition {
  definition: AgentDefinition
  /** 定义文件绝对路径（untrusted 包裹的 source 与正文懒加载都用它）。 */
  path: string
  scope: 'user' | 'project'
  /** user 作用域 = 用户本人撰写（trusted）；project 作用域必须按 untrusted 包裹。 */
  trusted: boolean
}

export interface AgentRegistryOptions {
  volundHome: string
  cwd: string
  onWarning?: (message: string) => void
}

export class AgentDefinitionRegistry {
  readonly #options: AgentRegistryOptions
  readonly #resolved = new Map<string, ResolvedAgentDefinition>()

  constructor(options: AgentRegistryOptions) {
    this.#options = options
  }

  /**
   * 重扫两层目录。项目级后扫、同名覆盖全局。同步实现：冷启动路径只有两个
   * 小目录，且 agentType 枚举（Task inputSchema）要求同步可读。
   */
  discover(): void {
    this.#resolved.clear()
    this.#scanScope('user', join(this.#options.volundHome, 'agents'))
    this.#scanScope('project', join(this.#options.cwd, '.volund', 'agents'))
  }

  list(): ResolvedAgentDefinition[] {
    return [...this.#resolved.values()].toSorted((a, b) =>
      a.definition.name.localeCompare(b.definition.name),
    )
  }

  get(name: string): ResolvedAgentDefinition | undefined {
    return this.#resolved.get(name)
  }

  /** 正文 = 该 agent 的 system prompt。按路径懒加载，发现后增补的正文变化无需重扫。 */
  /** 正文 = 该 agent 的 system prompt。按路径懒加载，发现后增补的正文变化无需重扫。 */
  async readBody(path: string): Promise<string> {
    return frontmatter(readFileSync(path, 'utf8')).body
  }

  #scanScope(scope: 'user' | 'project', directory: string): void {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return
      this.#options.onWarning?.(`agent definitions unavailable at ${directory}: ${String(error)}`)
      return
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const path = join(directory, entry.name)
      try {
        const { data } = frontmatter(readFileSync(path, 'utf8'))
        const definition = parseAgentDefinition(data)
        const fileStem = basename(entry.name, '.md')
        if (definition.name !== fileStem)
          throw new Error(`frontmatter name '${definition.name}' must match file name '${fileStem}'`)
        this.#resolved.set(definition.name, {
          definition,
          path,
          scope,
          trusted: scope === 'user',
        })
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        this.#options.onWarning?.(`agent definition skipped: ${path}: ${message}`)
      }
    }
  }
}

function frontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) throw new TypeError('agent definition requires YAML frontmatter')
  const data = parse(match[1]!)
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new TypeError('Invalid frontmatter')
  return { data: data as Record<string, unknown>, body: text.slice(match[0].length) }
}

/**
 * §6.5.0a / §2.7.1：project 级 agent 正文注入 prompt 前必须包裹。
 * 转义与 core runner 的 tool-result 包裹协议一致（`<`/`>`/`&`）。
 */
export function untrustedAgentBody(source: string, body: string): string {
  const escape = (text: string) =>
    text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return `<untrusted source="${escape(source)}">\n${escape(body)}\n</untrusted>`
}
