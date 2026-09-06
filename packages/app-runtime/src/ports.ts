/**
 * VolundPorts 子契约（§22.7.1 / Web 计划 P1-04）：UI-neutral 的管理/查询端口。
 *
 * 从 apps/cli/src/ports.ts 迁入——这些是 controller 的 transport-neutral 契约，
 * TUI 与 Web server 共用。CLI 专属的 SessionPort/UiPort/VolundPorts 聚合形状留在
 * apps/cli（Ink 渲染契约不许越过边界）。
 */
import type { SessionCandidate } from './contracts'

export interface DoctorHealth {
  detail: string
  valid?: boolean
  configured?: boolean
}
export interface NativeHealth {
  sandbox: boolean
  search: boolean
  fs: boolean
}
/** r13-P1 tri-state: `'probing'` until the startup probe backfills. */
export interface NativeAvailabilityView {
  sandbox: boolean | 'probing'
  search: boolean | 'probing'
  fs: boolean | 'probing'
}

export interface TrustPort {
  check(path: string): Promise<{
    canonicalPath: string
    trusted: boolean
    matchedPath?: string
    scope?: 'exact' | 'tree'
  }>
  grant(path: string, scope: 'exact' | 'tree'): Promise<{ path: string; scope: 'exact' | 'tree' }>
  list(): Promise<Array<{ path: string; scope: 'exact' | 'tree'; trustedAt: string }>>
  revoke(path: string): Promise<number>
  revokeAll(): Promise<number>
}

export interface ContextStatus {
  policy: string
  currentTokens: number
  maxTokens: number
  threshold: number
  sources: Record<string, number>
  lastCompaction?: { compactedMessageIds: string[]; at: string }
}
export interface ContextPort {
  show(): Promise<ContextStatus>
  keep(target: string): Promise<void>
  unkeep(target: string): Promise<void>
  compact(strategy?: 'sliding' | 'summary'): Promise<{ beforeTokens: number; afterTokens: number }>
  getPolicy(): Promise<{ name: string; params: Record<string, boolean | number | string> }>
  setPolicy(name: string, params: Record<string, string>): Promise<void>
}

export interface EvolutionPort {
  show(options: { namespace?: string; since?: Date }): Promise<unknown[]>
  rollback(options: {
    namespace?: 'context' | 'router' | 'retry' | 'tool-timeout'
    to?: Date
  }): Promise<unknown[]>
  /** §15.11 T1b: tuning journal health for `volund doctor`. */
  health?(): Promise<DoctorHealth>
}

export interface McpServerListing {
  name: string
  transport: string
  scope?: 'user' | 'project'
  status?: 'connected' | 'connecting' | 'needs-auth' | 'failed' | 'disabled'
  tools?: number
  protocolVersion?: string
}
export interface McpAddInput {
  name: string
  scope: 'user' | 'project'
  transport:
    | { kind: 'stdio'; command: string; args: string[]; env: Record<string, string> }
    | { kind: 'http'; url: string; headers: Record<string, string>; legacySse?: boolean }
}
export interface McpPort {
  list(): Promise<readonly McpServerListing[]>
  test(name: string, signal: AbortSignal): Promise<{ protocolVersion: string }>
  inspect(
    name: string,
    signal: AbortSignal,
  ): Promise<{ tools: Array<{ name: string; description?: string }> }>
  /** SKILLS-MCPS-r1 §S3.7：写入目标 scope 的 mcp.toml（同名整条覆盖）。 */
  add(input: McpAddInput): Promise<{ file: string }>
  remove(name: string, scope?: 'user' | 'project'): Promise<{ file: string }>
  setEnabled(name: string, enabled: boolean): Promise<void>
  /** SM-07：浏览器 OAuth 2.1 + PKCE + DCR；token 存 auth，回程 loopback。 */
  login(name: string): Promise<{ server: string }>
  /** SM-07：吊销（best-effort）并清除凭据。 */
  logout(name: string): Promise<void>
}

export interface SkillListing {
  name: string
  description: string
  /** plugin = 已启用插件捆绑的 skills（随插件信任，只读面）。 */
  scope: 'user' | 'project' | 'plugin'
  status: string
  version?: string
  path: string
}
export interface SkillPort {
  list(): Promise<readonly SkillListing[]>
  /**
   * SKILLS-MCPS-r1 §S3.7：安装三方源——`<本地目录>` / git URL / `github:owner/repo`
   * / `owner/repo` 简写；git 仓库根有 SKILL.md 装 root，否则装一层子目录里全部
   * 带 SKILL.md 的 skill。scope 默认 user，project 写 `<cwd>/.volund/skills`。
   */
  install(spec: string, options?: { scope?: 'user' | 'project' }): Promise<readonly SkillListing[]>
  uninstall(name: string, options?: { scope?: 'user' | 'project' }): Promise<void>
  show(name: string): Promise<string>
  setEnabled(name: string, enabled: boolean): Promise<void>
}

export interface PluginPort {
  availability(): Promise<PluginAvailability>
  install(source: string): Promise<{ name: string; version: string }>
  uninstall(name: string): Promise<void>
  list(): Promise<Record<string, { version: string; enabled: boolean; failures?: number }>>
  setEnabled(name: string, enabled: boolean): Promise<void>
  doctor(name: string): Promise<{
    name: string
    version: string
    permissions: readonly string[]
    availability: PluginAvailability
    compatibility: PluginCompatibilityDiagnostic
  }>
}

/**
 * 本地插件装载端口（PLUGIN-STATUS-UI-r1 / PLUGIN-MANAGER-r1）：三个发现源共用
 * 同一条激活链路（manifest 校验 → bundle 校验 → 沙箱宿主 volund-sandbox
 * --run-plugin）——内置插件（随产物分发的 apps/cli/plugins/<name>/）、dev 插件
 * （约定目录 ~/.volund/plugins-dev/<name>/ 自动发现 + VOLUND_DEV_PLUGINS 额外
 * 路径）、市场插件（[plugins] market 安装到 ~/.volund/plugins/<name>/，带
 * volund-market.json 完整性映射，激活期重验）。~/.volund/plugins 与冻结中的
 * legacy Catalog 状态文件（plugins/plugins.json approvals，deny-only）完全隔离；本地
 * 三源的持久生命周期统一由同级 plugin-state.v2.json 管理。
 */
export interface LocalPluginPort {
  activateLocal(dir: string): Promise<{ name: string; statusTabs: number }>
  loadDevPlugins(extraDirs?: readonly string[]): Promise<{
    loaded: { name: string; statusTabs: number }[]
    failed: { dir: string; error: string }[]
  }>
  /**
   * 内置插件（随产物分发的 apps/cli/plugins/<name>/）：与 dev 插件同一沙箱链路，
   * 仅发现源不同。交互会话启动时装载一次；一次性管理子命令（如 status）不装载。
   */
  loadBuiltinPlugins(): Promise<{
    loaded: { name: string; statusTabs: number }[]
    failed: { dir: string; error: string }[]
  }>
  /**
   * 市场插件：~/.volund/plugins/<name>/ 自动发现（dot 目录与无 manifest.json
   * 的目录跳过），但只有 v2 状态同时 approved + enabled 才装载；激活前逐文件重验。
   */
  loadMarketPlugins(): Promise<{
    loaded: { name: string; statusTabs: number }[]
    failed: { dir: string; error: string }[]
  }>
  /** v2 生命周期管理；市场插件必须 inspect → approve(hash) → enable。 */
  inspectPlugin(input: string): Promise<import('@volund/plugin-sdk').PluginInventoryEntry>
  approvePlugin(
    input: string,
    permissionHash: string,
  ): Promise<import('@volund/plugin-sdk').PluginInventoryEntry>
  enablePlugin(input: string): Promise<import('@volund/plugin-sdk').PluginInventoryEntry>
  disablePlugin(input: string): Promise<import('@volund/plugin-sdk').PluginInventoryEntry>
  /**
   * F1 插件一等公民：第一方工具域（volund.core-tools / volund.exec /
   * volund.orchestration）——/plugins 与 CLI 可见可禁用，落
   * [plugins] builtin_disabled。
   */
  builtinDomains(): Promise<{ id: string; label: string; description: string; enabled: boolean }[]>
  setBuiltinDomain(id: string, enabled: boolean): Promise<void>
  /**
   * 卸载市场插件（热生效）：停用（命令/页签当场摘除）+ 删除
   * ~/.volund/plugins/<name>/。仅市场插件可卸载——内置随产物分发不可卸，
   * dev 目录归开发者管理（命中即明确拒绝）。
   */
  uninstallMarketPlugin(input: string): Promise<{ name: string }>
  deactivateAll(): Promise<void>
}
export interface PluginCompatibilityDiagnostic {
  status: 'compatible' | 'incompatible' | 'invalid'
  detail: string
}
export interface PluginAvailability {
  available: false
  code: 'plugin_legacy_activation_unavailable'
  detail: string
  reopenCondition: string
}

export interface HistoryMessage {
  role: string
  text: string
}
export interface HistorySessionDetail {
  id: string
  cwd: string
  startedAt?: string
  updatedAt: string
  events: number
  messages: HistoryMessage[]
}
export interface HistorySearchHit {
  sessionId: string
  snippet: string
  at?: string
}
/**
 * §11.3.4 `volund history` 命令族：操作 ~/.volund/sessions/<id>.jsonl 会话档案
 * （与输入行历史 ~/.volund/history 无关）。list 复用 session port 的候选派生
 * （事件 replay），show/export 走同一 replay，search 只做本地关键词匹配。
 */
export interface HistoryPort {
  list(options: {
    limit?: number
    since?: Date
    cwd?: string
  }): Promise<readonly SessionCandidate[]>
  show(id: string): Promise<HistorySessionDetail>
  exportSession(id: string, format: 'markdown' | 'json'): Promise<string>
  importSession(content: string): Promise<{ id: string; file: string }>
  clear(options: { all?: boolean; olderThan?: Date }): Promise<{ removed: string[] }>
  search(query: string, options?: { limit?: number }): Promise<readonly HistorySearchHit[]>
}
