import type { EventBus } from '@apollo-code/core'
import type { JsonValue } from '@apollo-code/shared'
import type {
  MemoryMaintenanceService,
  MemoryRecallService,
  MemoryService,
  MemoryTransferService,
} from '@apollo-code/storage'
import type { TelemetryHealth, TelemetrySummary } from '@apollo-code/telemetry'
import type {
  InteractivePermissionDecision,
  InteractivePermissionRequest,
  InteractiveAppHandle,
  InteractiveAppOptions,
  DirectoryTrustDecision,
  SandboxDisclosure,
  StatusPanelData,
  StatusValue,
  StatusViewModel,
  SubmitOptions,
  SessionCandidate,
  TranscriptEntry,
} from '@apollo-code/ui'

import type { AppIdentity } from './shared/app-identity'

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
export type PermissionInteractionMode = 'none' | 'line' | 'tui'
export interface SessionPort {
  start(input: { cwd: string; prompt?: string }): Promise<{ id: string; exitCode?: number }>
  startInteractive?(input: { cwd: string }): Promise<InteractiveSession>
  resumeInteractive?(id: string): Promise<InteractiveSession>
  resume(id: string): Promise<{ id: string }>
  list?(): Promise<readonly SessionCandidate[]>
  interrupt(): Promise<void>
  end(): Promise<void>
  configureSecurity?(input: { skipPermissions: boolean }): void
  configurePermissionInteraction?(input: { mode: PermissionInteractionMode }): void
  configureOutput?(input: { json: boolean; write: (value: string) => void }): void
  configureTerminalOutput?(input: { streamToStdout: boolean }): void
}
export interface InteractiveSession {
  id: string
  events: EventBus
  cwd?: string
  transcript?: readonly TranscriptEntry[]
  getStatus?(): Promise<StatusViewModel>
  /** Interrupts the in-flight turn (esc in the TUI). Optional: esc stays inert without it. */
  interrupt?(): Promise<void>
  setPermissionPromptHandler?(
    handler:
      | ((request: InteractivePermissionRequest) => Promise<InteractivePermissionDecision>)
      | undefined,
  ): void
  submit(input: string, options?: SubmitOptions): Promise<void>
  end(): Promise<void>
  exitCode(): number
}
export interface UiPort {
  renderInteractiveApp(options: InteractiveAppOptions): InteractiveAppHandle
  renderSessionPicker?(input: {
    sessions: readonly SessionCandidate[]
    error?: string
  }): Promise<SessionCandidate | undefined>
  renderDirectoryTrustPrompt?(input: {
    canonicalPath: string
    parentPath: string
  }): Promise<DirectoryTrustDecision>
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
  /** §15.11 T1b: tuning journal health for `apollo doctor`. */
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
}
export interface SkillListing {
  name: string
  description: string
  scope: 'user' | 'project'
  status: string
  version?: string
  path: string
}
export interface SkillPort {
  list(): Promise<readonly SkillListing[]>
  /**
   * SKILLS-MCPS-r1 §S3.7：安装三方源——`<本地目录>` / git URL / `github:owner/repo`
   * / `owner/repo` 简写；git 仓库根有 SKILL.md 装 root，否则装一层子目录里全部
   * 带 SKILL.md 的 skill。scope 默认 user，project 写 `<cwd>/.apollo/skills`。
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
 * 同一条激活链路（manifest 校验 → bundle 校验 → 沙箱宿主 apollo-sandbox
 * --run-plugin）——内置插件（随产物分发的 apps/cli/plugins/<name>/）、dev 插件
 * （约定目录 ~/.apollo/plugins-dev/<name>/ 自动发现 + APOLLO_DEV_PLUGINS 额外
 * 路径）、市场插件（[plugins] market 安装到 ~/.apollo/plugins/<name>/，带
 * apollo-market.json 完整性映射，激活期重验）。~/.apollo/plugins 与冻结中的
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
   * 市场插件：~/.apollo/plugins/<name>/ 自动发现（dot 目录与无 manifest.json
   * 的目录跳过），但只有 v2 状态同时 approved + enabled 才装载；激活前逐文件重验。
   */
  loadMarketPlugins(): Promise<{
    loaded: { name: string; statusTabs: number }[]
    failed: { dir: string; error: string }[]
  }>
  /** v2 生命周期管理；市场插件必须 inspect → approve(hash) → enable。 */
  inspectPlugin(input: string): Promise<import('@apollo-code/plugin-sdk').PluginInventoryEntry>
  approvePlugin(
    input: string,
    permissionHash: string,
  ): Promise<import('@apollo-code/plugin-sdk').PluginInventoryEntry>
  enablePlugin(input: string): Promise<import('@apollo-code/plugin-sdk').PluginInventoryEntry>
  disablePlugin(input: string): Promise<import('@apollo-code/plugin-sdk').PluginInventoryEntry>
  /**
   * 卸载市场插件（热生效）：停用（命令/页签当场摘除）+ 删除
   * ~/.apollo/plugins/<name>/。仅市场插件可卸载——内置随产物分发不可卸，
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
 * §11.3.4 `apollo history` 命令族：操作 ~/.apollo/sessions/<id>.jsonl 会话档案
 * （与输入行历史 ~/.apollo/history 无关）。list 复用 session port 的候选派生
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
export interface ApolloPorts {
  identity: Readonly<AppIdentity>
  /** @deprecated Use identity.version. */
  version: string
  native: {
    probe(): Promise<SandboxDisclosure>
    health(): Promise<NativeHealth>
    /** r13-P1: tri-state snapshot; 'probing' until the startup probe backfills. */
    available?(): NativeAvailabilityView
    /** r13-P1: fire all native probes in parallel (REPL startup path). */
    startProbes?(): void
  }
  auth: {
    health(): Promise<DoctorHealth>
    login(input: {
      provider: string
      credential?: string
      flow: 'api-key' | 'stdin'
      dangerouslySkipVerify: boolean
    }): Promise<{ detail: string }>
    logout(provider: string): Promise<{ detail: string }>
  }
  config: {
    health(cwd: string): Promise<DoctorHealth>
    /**
     * [env] 段（§8.3）：会话启动时把用户级 config 的显式环境变量写入
     * process.env。进入 agent 会话路径前调用一次；类型错按 C.1 抛 config_invalid。
     */
    applyEnv?(): Promise<void>
    /**
     * includeStats：/status 面板打开时（refresh）才传 true——stats 需要全量扫描
     * sessions 目录，REPL 启动快照不付这个成本。usage（当前会话）始终附带。
     */
    status?(input: {
      cwd: string
      sessionId?: string
      includeStats?: boolean
    }): Promise<StatusPanelData>
    updatePreference?(
      id: string,
      value: StatusValue,
      input: { cwd: string; sessionId: string },
    ): Promise<StatusPanelData>
    /**
     * §11.3.3 `apollo config` 命令族。目标文件：user = <home>/config.toml，
     * project = <cwd>/.apollo/config.toml。setValue 在端口内做 schema 校验
     * （未知 key → config_unknown_key；类型错 → config_invalid）与
     * §8.3.1 projectOverride 数据流向门（forbidden key → config_project_forbidden）。
     */
    listMerged?(input: { cwd: string }): Promise<{
      config: Record<string, JsonValue>
      warnings: string[]
    }>
    setValue?(input: {
      cwd: string
      key: string
      value: JsonValue
      project?: boolean
    }): Promise<{ file: string }>
    unsetValue?(input: {
      cwd: string
      key: string
      project?: boolean
    }): Promise<{ file: string; removed: boolean }>
    filePaths?(input: { cwd: string }): { user: string; project: string }
  }
  telemetry: {
    securityEvent(name: string, payload: Record<string, boolean | string>): Promise<void>
    summary(): Promise<TelemetrySummary>
    export(target: string): Promise<number>
    clear(): Promise<void>
    health(): Promise<TelemetryHealth>
  }
  confirmation: { confirmDangerousNoSandbox(sentence: string): Promise<boolean> }
  trust: TrustPort
  session: SessionPort
  restore?: {
    restore(
      sessionId: string,
      options: { dryRun: boolean },
    ): Promise<{ restored: string[]; conflicts: string[]; missing: boolean; dryRun: boolean }>
  }
  context?: ContextPort
  evolution?: EvolutionPort
  /** Production-scoped memory service shared by all consumers. */
  memory?: MemoryService
  memoryRecall?: MemoryRecallService
  memoryMaintenance?: MemoryMaintenanceService
  memoryTransfer?: MemoryTransferService
  mcp?: McpPort
  skill?: SkillPort
  plugin?: PluginPort
  localPlugins?: LocalPluginPort
  history?: HistoryPort
  ui?: UiPort
}
export function unavailablePorts(): ApolloPorts {
  return {
    identity: { version: '0.0.0-test' },
    version: '0.0.0-test',
    native: {
      probe: async () => ({
        tier: 'none',
        mechanism: 'native port not connected',
        features: { filesystem: false, network: false },
        degradationReasons: ['apollo-sandbox probe unavailable'],
      }),
      health: async () => ({ sandbox: false, search: false, fs: false }),
      available: () => ({ sandbox: false, search: false, fs: false }),
      startProbes: () => {},
    },
    auth: {
      health: async () => ({ configured: false, detail: 'auth port not connected' }),
      login: async () => {
        throw new Error('auth port not connected')
      },
      logout: async () => {
        throw new Error('auth port not connected')
      },
    },
    config: { health: async () => ({ valid: false, detail: 'config port not connected' }) },
    telemetry: {
      securityEvent: async () => {},
      summary: async () => ({
        samples: 0,
        corruptLines: 0,
        tiers: {},
        escape: { allow: 0, deny: 0, ratio: null },
        probe: null,
      }),
      export: async () => 0,
      clear: async () => {},
      health: async () => ({
        exists: false,
        writable: true,
        corruptLines: 0,
        samples: 0,
        detail: 'local sink not created yet',
      }),
    },
    confirmation: { confirmDangerousNoSandbox: async () => false },
    trust: {
      check: async (path) => ({ canonicalPath: path, trusted: false }),
      grant: async (path, scope) => ({ path, scope }),
      list: async () => [],
      revoke: async () => 0,
      revokeAll: async () => 0,
    },
    session: {
      start: async () => ({ id: 'unconnected-session' }),
      resume: async (id) => ({ id }),
      list: async () => [],
      interrupt: async () => {},
      end: async () => {},
    },
  }
}
