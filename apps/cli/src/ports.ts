import type { EventBus } from '@apollo-code/core'
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
export interface McpPort {
  list(): Promise<Array<{ name: string; transport: string }>>
  test(name: string, signal: AbortSignal): Promise<{ protocolVersion: string }>
  inspect(
    name: string,
    signal: AbortSignal,
  ): Promise<{ tools: Array<{ name: string; description?: string }> }>
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
    status?(input: { cwd: string; sessionId?: string }): Promise<StatusPanelData>
    updatePreference?(
      id: string,
      value: StatusValue,
      input: { cwd: string; sessionId: string },
    ): Promise<StatusPanelData>
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
  plugin?: PluginPort
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
