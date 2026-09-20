/**
 * 管理域端点（§22.8.2 tagged-union actions / Web 计划 P4-01..04）：
 * memory / skills / mcp / plugins 的 GET inventory + POST typed action。
 * 全部转发到 app-runtime 的既有 controller——Web 不重写业务语义。
 *
 * WEB-EXT-MANAGE-MARKET-r1 §S3：接口放宽至全生命周期（install/uninstall/add/
 * remove/reload/marketList/inventory/approve…）——实现侧是 app-runtime 的
 * mcpManagementPort / skillManagementPort / localPlugins（零新写路径）。
 */
import type { McpAddInput, MemoryPanelController, SkillListing } from '@volund/app-runtime'
import type { McpMarketEntry } from '@volund/app-runtime'
import type { SkillMarketEntry } from '@volund/app-runtime'
import type { PluginInstallResult, PluginInventory, PluginInventoryEntry } from '@volund/plugin-sdk'

export type SkillListItem = SkillListing

/** Skill 管理面（skillManagementPort 的结构投影）。 */
export interface SkillPortLike {
  list(): Promise<readonly SkillListItem[]>
  show(name: string): Promise<string>
  setEnabled(name: string, enabled: boolean): Promise<unknown>
  install(
    spec: string,
    options?: { scope?: 'user' | 'project' },
  ): Promise<{ items: readonly SkillListItem[] }>
  uninstall(name: string, options?: { scope?: 'user' | 'project' }): Promise<{ ok: boolean }>
  reload(): Promise<readonly SkillListItem[]>
  marketList(): Promise<
    { source: string; entries: readonly SkillMarketEntry[] } | { error: string } | undefined
  >
}

/** MCP 管理面（mcpManagementPort 的结构投影）。 */
export interface McpPortLike {
  list(): Promise<readonly unknown[]>
  inspect(name: string): Promise<{
    entry: unknown
    tools: readonly { name: string; description?: string }[]
  }>
  setEnabled(name: string, enabled: boolean): Promise<unknown>
  add(input: McpAddInput): Promise<{ file: string; items: readonly unknown[] }>
  remove(
    name: string,
    scope?: 'user' | 'project',
  ): Promise<{ file: string; items: readonly unknown[] }>
  reload(): Promise<readonly unknown[]>
  marketList(): Promise<
    { source: string; entries: readonly McpMarketEntry[] } | { error: string } | undefined
  >
}

/** 插件管理面（localPlugins 全量 + legacy availability 的投影）。 */
export interface PluginPortLike {
  builtinDomains(): Promise<{ id: string; label: string; description: string; enabled: boolean }[]>
  setBuiltinDomain(id: string, enabled: boolean): Promise<void>
  availability(): Promise<{
    available: false
    code: string
    detail: string
    reopenCondition: string
  }>
  inventory(): Promise<PluginInventory>
  installMarketPlugin(name: string): Promise<PluginInstallResult>
  inspectPlugin(name: string): Promise<PluginInventoryEntry>
  approvePlugin(name: string, permissionHash: string): Promise<PluginInventoryEntry>
  enablePlugin(name: string): Promise<PluginInventoryEntry>
  disablePlugin(name: string): Promise<PluginInventoryEntry>
  uninstallMarketPlugin(name: string): Promise<{ name: string }>
}

export interface TelemetryPortLike {
  summary(): Promise<unknown>
  health(): Promise<unknown>
}

export interface ManagementPorts {
  readonly memory?: MemoryPanelController | undefined
  readonly skill?: SkillPortLike | undefined
  readonly mcp?: McpPortLike | undefined
  readonly plugins?: PluginPortLike | undefined
  readonly telemetry?: TelemetryPortLike | undefined
}

export type ActionHandler = (body: Record<string, unknown>) => Promise<unknown>

const MCP_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * `mcp add` 请求体 → McpAddInput（§S3.3）。transport 字符串 'sse'/'streamable-http'
 * ↔ legacySse 布尔在适配层换算；stdio/http 字段组互斥；secret 类 header 引导
 * keyref:// 录入（由 domain 层既有语义承载，这里只做结构校验）。
 */
export function parseMcpAddBody(body: Record<string, unknown>): McpAddInput {
  const invalid = (message: string): Error =>
    Object.assign(new Error(message), { code: 'web_schema_invalid' })
  const name = body.name
  if (typeof name !== 'string' || !MCP_SERVER_NAME.test(name))
    throw invalid('mcp add requires a valid name (letters, digits, . _ -)')
  const scope = body.scope === 'project' ? 'project' : 'user'
  const kind = body.transport
  if (kind === 'stdio') {
    if (body.url !== undefined || body.headers !== undefined)
      throw invalid('stdio transport does not accept url/headers')
    const command = body.command
    if (typeof command !== 'string' || !command.trim())
      throw invalid('stdio transport requires command')
    const args = Array.isArray(body.args) ? body.args.map(String) : []
    const env = stringTable(body.env, 'env', invalid)
    return { name, scope, transport: { kind: 'stdio', command, args, env } }
  }
  if (kind === 'http' || kind === 'sse' || kind === 'streamable-http') {
    if (body.command !== undefined || body.args !== undefined || body.env !== undefined)
      throw invalid('http transport does not accept command/args/env')
    const url = body.url
    if (typeof url !== 'string' || !url.trim()) throw invalid('http transport requires url')
    const headers = stringTable(body.headers, 'headers', invalid)
    return {
      name,
      scope,
      transport: {
        kind: 'http',
        url,
        headers,
        // 旧 HTTP+SSE 兼容开关：仅显式 'sse' 置位（'http'/'streamable-http' 走 Streamable HTTP）。
        ...(kind === 'sse' ? { legacySse: true } : {}),
      },
    }
  }
  throw invalid("transport must be 'stdio' | 'http' | 'sse' | 'streamable-http'")
}

function stringTable(
  value: unknown,
  field: string,
  invalid: (message: string) => Error,
): Record<string, string> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid(`mcp add ${field} must be a table`)
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw invalid(`mcp add ${field} values must be strings`)
    out[key] = item
  }
  return out
}

/** 统一 action 分发：未知 action → web_schema_invalid。 */
export function actionDispatcher(table: Record<string, ActionHandler>): ActionHandler {
  return async (body) => {
    const action = body.action
    if (typeof action !== 'string' || !(action in table))
      throw Object.assign(new Error(`unknown action: ${String(action)}`), {
        code: 'web_schema_invalid',
      })
    return table[action]!(body)
  }
}
