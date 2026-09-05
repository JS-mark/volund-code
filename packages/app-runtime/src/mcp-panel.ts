/**
 * SKILLS-MCPS-r1 §S3.6：/mcp 面板的数据契约（K0 渲染，纯数据 view model）。
 * 控制器由 apps/cli 原生实现：list/reload 走 McpManager 状态机，
 * setEnabled 持久写 config [mcp] disabled 并即时连接/断开。
 */

export type McpServerStatus = 'connected' | 'connecting' | 'needs-auth' | 'failed' | 'disabled'

export interface McpPanelEntry {
  readonly name: string
  readonly scope: 'user' | 'project'
  /** 'stdio: npx -y @scope/pkg' / 'http: api.example.com' 摘要。 */
  readonly transport: string
  readonly status: McpServerStatus
  readonly tools?: number
  readonly detail?: string
  readonly protocolVersion?: string
}

export interface McpToolSummary {
  readonly name: string
  readonly description?: string
}

export interface McpPanelController {
  list(): Promise<readonly McpPanelEntry[]>
  /** 断开全部并按配置重连（/mcp reload 语义）。 */
  reload(): Promise<readonly McpPanelEntry[]>
  setEnabled(name: string, enabled: boolean): Promise<string>
  /** 详情（r1.6 恢复）：元数据 + 工具清单（等价 volund mcp inspect 的只读形态）。 */
  inspect(name: string): Promise<{ entry: McpPanelEntry; tools: readonly McpToolSummary[] }>
}

export function mcpPanelStatusGlyph(status: McpServerStatus): string {
  switch (status) {
    case 'connected':
      return '●'
    case 'connecting':
      return '…'
    case 'needs-auth':
      return '◐'
    case 'failed':
      return '✘'
    case 'disabled':
      return '○'
  }
}

/** `/mcp list`（非面板形态）：转 ListPicker 可渲染的纯数据视图。 */
export function mcpListCommandView(entries: readonly McpPanelEntry[]): {
  kind: 'list'
  title: string
  placeholder?: string
  entries: Array<{
    id: string
    label: string
    value?: string
    status?: string
    detail?: string
  }>
} {
  return {
    kind: 'list',
    title: 'MCP Servers',
    placeholder: 'filter servers…',
    entries: entries.map((entry) => ({
      id: entry.name,
      label: entry.name,
      value: entry.transport,
      status: entry.status,
      detail: [
        `${entry.name} (${entry.scope} · ${entry.status})`,
        `transport: ${entry.transport}`,
        entry.tools === undefined ? '' : `tools: ${entry.tools}`,
        entry.protocolVersion ? `protocol: ${entry.protocolVersion}` : '',
        entry.detail ? entry.detail : '',
      ]
        .filter(Boolean)
        .join('\n'),
    })),
  }
}
