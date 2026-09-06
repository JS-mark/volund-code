/**
 * 管理域端点（§22.8.2 tagged-union actions / Web 计划 P4-01..04）：
 * memory / skills / mcp / plugins 的 GET inventory + POST typed action。
 * 全部转发到 app-runtime 的既有 controller——Web 不重写业务语义。
 */
import type { MemoryPanelController } from '@volund/app-runtime'

/** Skill 端口的最小结构面（VolundPorts['skill'] 结构满足）。 */
export interface SkillPortLike {
  list(): Promise<
    readonly {
      name: string
      description: string
      scope: string
      status: string
      version?: string
      path: string
    }[]
  >
  show(name: string): Promise<string>
  setEnabled(name: string, enabled: boolean): Promise<void>
}

/** MCP 端口的最小结构面（VolundPorts['mcp'] 结构满足）。 */
export interface McpPortLike {
  list(): Promise<readonly unknown[]>
  inspect(
    name: string,
    signal?: AbortSignal,
  ): Promise<{ tools: Array<{ name: string; description?: string }> }>
  setEnabled(name: string, enabled: boolean): Promise<void>
}

/** 插件管理面（localPlugins + legacy availability 的投影）。 */
export interface PluginPortLike {
  builtinDomains(): Promise<{ id: string; label: string; description: string; enabled: boolean }[]>
  setBuiltinDomain(id: string, enabled: boolean): Promise<void>
  availability(): Promise<{
    available: false
    code: string
    detail: string
    reopenCondition: string
  }>
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
