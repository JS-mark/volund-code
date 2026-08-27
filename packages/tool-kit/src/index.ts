import type { PermissionSpec } from '@volund/permission'
import type { ContentPart } from '@volund/provider-kit'
import type { JsonValue, Logger } from '@volund/shared'

export interface SessionSnapshot {
  id: string
  cwd: string
  turnId: string
}
export interface NativeBridge {
  /**
   * Executes `command` with `args` inside the native sandbox. `env` (REM-57,
   * r13-I11) is the minimal inherited environment for the sandboxed process;
   * bridges must not merge it with the full host environment.
   */
  execute(
    command: string,
    args: string[],
    signal: AbortSignal,
    env?: Record<string, string>,
  ): Promise<unknown>
}
export interface ToolUiPort {
  requestInput(prompt: string): Promise<string>
}
export interface ToolContext {
  readonly abortSignal: AbortSignal
  readonly session: SessionSnapshot
  readonly native: NativeBridge
  readonly logger: Logger
  readonly ui: ToolUiPort
}
export interface ToolResultMeta {
  durationMs: number
  bytesRead?: number
  bytesWritten?: number
  filesTouched?: string[]
  costImpact?: 'safe' | 'moderate' | 'high'
  /**
   * File-mutating tools report unified-diff-style line counts so the runner can
   * surface them on `tool.completed` (?linesAdded/?linesRemoved，附录 D.2) and the
   * /status Usage tab can total code changes per session.
   */
  linesAdded?: number
  linesRemoved?: number
}
export interface ToolResult {
  content: ContentPart[]
  isError?: boolean
  meta?: ToolResultMeta
}
export interface Tool<Input = unknown> {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, JsonValue>
  readonly outputHint?: string
  readonly readonly?: boolean
  readonly timeoutMs?: number
  readonly parallelSafe?: boolean
  permissionSpec(input: Input): PermissionSpec
  invoke(input: Input, context: ToolContext): Promise<ToolResult>
}

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>()
  register(
    tool: Tool,
    source:
      | { kind: 'builtin' }
      | { kind: 'mcp'; server: string }
      | { kind: 'plugin'; plugin: string } = { kind: 'builtin' },
  ): () => void {
    if (source.kind === 'mcp' && !tool.name.startsWith(`mcp__${source.server}__`))
      // SKILLS-MCPS-r1 §S3.5：命名对齐业界 mcp__<server>__<tool>（双下划线）。
      throw new Error('MCP tools require mcp__<server>__ prefix')
    if (source.kind === 'plugin' && !tool.name.startsWith(`plugin:${source.plugin}:`))
      throw new Error('Plugin tools require plugin:<name>: prefix')
    if (this.#tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`)
    this.#tools.set(tool.name, tool)
    return () => this.#tools.delete(tool.name)
  }
  get(name: string): Tool | undefined {
    return this.#tools.get(name)
  }
  list(): readonly Tool[] {
    return [...this.#tools.values()]
  }
  forProvider(): Array<{
    name: string
    description: string
    inputSchema: Record<string, JsonValue>
  }> {
    return this.list().map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }))
  }
}
