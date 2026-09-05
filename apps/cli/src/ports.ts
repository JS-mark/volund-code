// §22.7.1 / Web P1-03：会话契约已迁至 @volund/app-runtime；此处 re-export 保持兼容。
import type {
  InteractiveSession as InteractiveSessionContract,
  PermissionInteractionMode as PermissionInteractionModeContract,
} from '@volund/app-runtime'
import type { JsonValue } from '@volund/shared'
import type {
  MemoryMaintenanceService,
  MemoryRecallService,
  MemoryService,
  MemoryTransferService,
} from '@volund/storage'
import type { TelemetryHealth, TelemetrySummary } from '@volund/telemetry'
import type {
  InteractiveAppHandle,
  InteractiveAppOptions,
  DirectoryTrustDecision,
  SandboxDisclosure,
  StatusPanelData,
  StatusValue,
  StatusViewModel,
  SessionCandidate,
} from '@volund/ui'

import type { AppIdentity } from './shared/app-identity'

export type PermissionInteractionMode = PermissionInteractionModeContract

// ── 已迁至 @volund/app-runtime 的 UI-neutral 端口契约（P1-04）；re-export 保持兼容 ──
export type {
  ContextPort,
  ContextStatus,
  DoctorHealth,
  EvolutionPort,
  HistoryMessage,
  HistoryPort,
  HistorySearchHit,
  HistorySessionDetail,
  LocalPluginPort,
  McpAddInput,
  McpPort,
  McpServerListing,
  NativeAvailabilityView,
  NativeHealth,
  PluginAvailability,
  PluginCompatibilityDiagnostic,
  PluginPort,
  SkillListing,
  SkillPort,
  TrustPort,
} from '@volund/app-runtime'
// 本地类型化需引用（VolundPorts 聚合形状）
import type {
  ContextPort,
  DoctorHealth,
  EvolutionPort,
  HistoryPort,
  LocalPluginPort,
  McpPort,
  NativeAvailabilityView,
  NativeHealth,
  PluginPort,
  SkillPort,
  TrustPort,
} from '@volund/app-runtime'
export interface SessionPort {
  startSession(input: { cwd: string; prompt?: string }): Promise<{ id: string; exitCode?: number }>
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
export type InteractiveSession = InteractiveSessionContract<StatusViewModel>
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
export interface VolundPorts {
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
    /** Resolves once every probe settled (budget-bounded); for welcome backfill. */
    settled?(): Promise<void>
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
     * §11.3.3 `volund config` 命令族。目标文件：user = <home>/config.toml，
     * project = <cwd>/.volund/config.toml。setValue 在端口内做 schema 校验
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
  /** §4.4 三档会话权限模式（ask | auto | full）；set 对新会话生效并热切活动顶层会话。 */
  permissionMode?: {
    current(): 'ask' | 'auto' | 'full' | undefined
    set(mode: 'ask' | 'auto' | 'full'): void
  }
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
  /**
   * 进程收尾：关闭插件宿主 / MCP 连接等长驻资源（它们的子进程管道 ref 住事件
   * 循环，不关则 UI 退出后进程仍悬挂）。交互会话退出与信号处理都会调用；
   * 实现必须幂等、单项失败不阻塞其他项。
   */
  shutdown?(): Promise<void>
}
export function unavailablePorts(): VolundPorts {
  return {
    identity: { version: '0.0.0-test' },
    version: '0.0.0-test',
    native: {
      probe: async () => ({
        tier: 'none',
        mechanism: 'native port not connected',
        features: { filesystem: false, network: false },
        degradationReasons: ['volund-sandbox probe unavailable'],
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
      startSession: async () => ({ id: 'unconnected-session' }),
      resume: async (id) => ({ id }),
      list: async () => [],
      interrupt: async () => {},
      end: async () => {},
    },
  }
}
