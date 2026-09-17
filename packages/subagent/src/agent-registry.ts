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
  /**
   * §2.7.1（r13-G3）：父工具注册表全集的懒取数（内置工具 + 全部插件工具
   * `plugin:<名>:<工具>`，见设计 §7.2「allowedTools 校验全集 = registry 含插件」）。
   * 提供时，定义 `tools` 白名单超出该全集 → 拒绝装载该文件（只能收紧不能放宽）。
   * 每次 `discover()` 取一次快照——重扫自然跟随插件装卸后的注册表变化。
   */
  parentToolNames?: () => Iterable<string>
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
    // G3：白名单校验全集在整轮扫描内取同一快照（provider 可能构造工具实例，
    // 逐文件取数既浪费又可能扫到半途的装卸状态）。
    const parentTools = this.#options.parentToolNames
      ? new Set(this.#options.parentToolNames())
      : undefined
    this.#scanScope('user', join(this.#options.volundHome, 'agents'), parentTools)
    this.#scanScope('project', join(this.#options.cwd, '.volund', 'agents'), parentTools)
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

  #scanScope(
    scope: 'user' | 'project',
    directory: string,
    parentTools?: ReadonlySet<string>,
  ): void {
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
          throw new Error(
            `frontmatter name '${definition.name}' must match file name '${fileStem}'`,
          )
        // §2.7.1 强制点「tools 超父集拒绝」（G3 接线）：白名单只能收紧不能放宽。
        // 错误信息对齐 shared 的 parseAgentDefinition(allowedTools) 用词。
        if (parentTools && definition.tools) {
          const unknown = definition.tools.filter(
            (tool) => !parentTools.has(tool) && !isDynamicToolName(tool),
          )
          if (unknown.length > 0)
            throw new Error(`agent tools exceed parent registry: ${unknown.join(', ')}`)
        }
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
 * MCP 工具名（`mcp__<server>__<tool>`，命名约束见 ToolRegistry.register）豁免
 * 装载期存在性校验：MCP 连接按 cwd 懒建立且运行期可 reload，冷启动 discover
 * 拿不到同步全集，静态白名单校验对动态名字只会误伤。执行侧双闸（schemas 不
 * 暴露 / execute 查无此工具即 Unknown tool）是真正的安全边界——不存在的
 * `mcp__*` 名字永远不会解析成可执行工具。
 */
function isDynamicToolName(name: string): boolean {
  return /^mcp__[^_]+__/.test(name)
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
