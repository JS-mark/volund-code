import { constants as fsConstants } from 'node:fs'
import {
  access,
  appendFile,
  glob,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { connect as http2Connect, constants as http2Constants } from 'node:http2'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'

import { AuthManager, EncryptedCredentialStore } from '@apollo-code/auth'
import { loadTomlFile, parseTomlFile } from '@apollo-code/config'
import { SlidingWindowPolicy } from '@apollo-code/context'
import {
  builtinPromptFragment,
  createSession,
  DefaultPromptComposer,
  EventBus,
  MachineEventFormatter,
  EvolutionEngine,
  replaySessionState,
  Runner,
  updateSession,
} from '@apollo-code/core'
import type {
  ContextTunableParam,
  EvolutionPersistence,
  PromptComposer,
  RunnerToolPort,
  SessionState,
} from '@apollo-code/core'
import { execSandbox, nativeProbes, probeSandbox, resolveBinary } from '@apollo-code/native-bridge'
import type { SandboxTier } from '@apollo-code/native-bridge'
import { PermissionManager } from '@apollo-code/permission'
import type { PermissionDecision, PermissionRequest, PermissionSpec } from '@apollo-code/permission'
import {
  LEGACY_PLUGIN_UNAVAILABLE,
  PluginError,
  PluginManager,
  satisfies,
} from '@apollo-code/plugin-runtime'
import type { HookPipelineSignal } from '@apollo-code/plugin-runtime'
import type { PluginMemoryScope } from '@apollo-code/plugin-sdk'
import { AnthropicClient, verifyAnthropicCredential } from '@apollo-code/provider-anthropic'
import type { HttpPort, HttpRequest, HttpResponse } from '@apollo-code/provider-anthropic'
import { InMemoryProviderRegistry } from '@apollo-code/provider-kit'
import { parseRoleRouterConfig, RoleRouter, SingleProviderRouter } from '@apollo-code/router'
import type { RouterPolicy } from '@apollo-code/router'
import {
  detectSecret,
  isCredentialKeyForSecretDetection,
  normalizeForSecretDetection,
  sanitize,
  type JsonValue,
  type Logger,
} from '@apollo-code/shared'
import { SkillsRuntime } from '@apollo-code/skills-runtime'
import {
  AttachmentStore,
  BackupStore,
  DefaultMemoryMaintenanceService,
  DefaultMemoryRecallService,
  DefaultMemoryService,
  EvolutionStore,
  IndexingMemoryService,
  LocalKeywordMemoryIndex,
  LocalMemoryRepository,
  MemoryError,
  MemoryPromptProvider,
  MemoryTransferService,
  PromptLoader,
  SessionStore,
} from '@apollo-code/storage'
import type { MemoryRecallService, MemoryService } from '@apollo-code/storage'
import { SubagentDispatcher } from '@apollo-code/subagent'
import {
  LocalTelemetrySink,
  Telemetry,
  TelemetryLogger,
  TelemetryStore,
} from '@apollo-code/telemetry'
import { ToolRegistry } from '@apollo-code/tool-kit'
import type { NativeBridge, ToolContext } from '@apollo-code/tool-kit'
import { builtinTools, ToolExecutor } from '@apollo-code/tools'
import type { ToolHookDispatcher } from '@apollo-code/tools'
import {
  renderDirectoryTrustPrompt,
  renderInteractiveApp,
  renderSessionPicker,
  MutableSlashCommandRegistry,
  formatPermissionTextForDisplay,
  formatPermissionValueForDisplay,
  validateStatusConfigValue,
} from '@apollo-code/ui'
import type {
  InteractivePermissionDecision,
  InteractivePermissionRequest,
  SandboxDisclosure,
  StatusSetting,
  StatusSource,
  StatusViewModel,
  SubmitOptions,
  StatusConfigItem,
  StatusPanelData,
  StatusValue,
  SessionCandidate,
} from '@apollo-code/ui'
import { v7 as uuidv7 } from 'uuid'

import { projectMemoryScope, sessionMemoryScope, workspaceMemoryScope } from './memory-scope'
import { createMemoryTools } from './memory-tools'
import type {
  ApolloPorts,
  InteractiveSession,
  PermissionInteractionMode,
  PluginCompatibilityDiagnostic,
  SessionPort,
} from './ports'
import type { AppIdentity } from './shared/app-identity'
import { DirectoryTrustStore } from './trust'

export type RunnerFactory = (state: SessionState, events: EventBus) => Runner | Promise<Runner>
const terminalStatuses = new Set(['done', 'aborted', 'error'])
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const historySecretPattern =
  /\b(?:authorization|api[_-]?key|token|secret|passphrase|password|oauth[_-]?code|anthropic[_-]?api[_-]?key|openai[_-]?api[_-]?key)\b/i
const statusSecretKeyPattern =
  /(?:authorization|api[_-]?key|token|secret|credential|passphrase|password|oauth)/i
const statusUnavailable = (code: string) => ({
  status: 'not_available' as const,
  reason: { code },
})

export interface HookSignalRuntimeMapping {
  error?: { code: string; context: Record<string, JsonValue> }
  warning?: string
  telemetry?: { name: string; payload: Record<string, JsonValue> }
}

const unreachableHookSignal = (signal: never): never => {
  void signal
  throw new TypeError('unhandled hook pipeline signal')
}

/** Pure, exhaustive adapter from plugin-runtime hook signals to CLI observability. */
export function mapHookPipelineSignal(signal: HookPipelineSignal): HookSignalRuntimeMapping {
  switch (signal.kind) {
    case 'builtin_hook_timeout':
    case 'builtin_hook_error':
      return {
        error: { code: signal.code, context: { hook: signal.hook, event: signal.event } },
      }
    case 'hook_skipped':
      return {
        warning: `Hook skipped (${signal.domain} ${signal.hook} on ${signal.event}, ${signal.cause}): ${signal.message}`,
        telemetry: {
          name: 'hook.skipped',
          payload: {
            domain: signal.domain,
            hook: signal.hook,
            event: signal.event,
            cause: signal.cause,
          },
        },
      }
    case 'builtin_hook_payload_too_large': {
      const evidence = {
        domain: signal.domain,
        hook: signal.hook,
        event: signal.event,
        limitBytes: signal.limitBytes,
        rawBytes: signal.rawBytes,
        rawDigest: signal.rawDigest,
        scanStatus: signal.scanStatus,
        scannedBytes: signal.scannedBytes,
        scannedDigest: signal.scannedDigest,
        decision: signal.decision,
      } satisfies Record<string, JsonValue>
      return {
        error: { code: signal.code, context: evidence },
        warning: `Builtin hook payload rejected for ${signal.hook} on ${signal.event}: ${signal.rawBytes} bytes exceeds ${signal.limitBytes}`,
        telemetry: { name: 'hook.payload_rejected', payload: evidence },
      }
    }
    default:
      return unreachableHookSignal(signal)
  }
}

export interface StatusViewModelInput {
  state: SessionState
  version: string
  workspace?: string
  project?: string
  model?: {
    provider: string
    model: string
    liteModel?: string | null
    reasoningModel?: string | null
    source: Exclude<StatusViewModel['model']['source'], 'derived_unreliable'>
  }
  sandbox?: SandboxDisclosure
  dangerousPermissions?: boolean
  authConfigured?: boolean
  authMethod?: 'keychain' | 'encrypted_file' | 'env'
  memoryMode?: string
  settings?: readonly StatusSetting[]
  configSources?: readonly StatusSource[]
  mcpServers?: readonly string[]
  skills?: readonly string[]
  plugins?: readonly string[]
}

export function buildStatusViewModel(input: StatusViewModelInput): StatusViewModel {
  const settings = (input.settings ?? [])
    .filter((setting) => !statusSecretKeyPattern.test(setting.key))
    .map((setting) => sanitize(setting))
  const sandbox = input.sandbox
  return {
    identity: {
      version: sanitize(input.version),
      sessionId: sanitize(input.state.id),
      createdAt: new Date(input.state.createdAt).toISOString(),
      cwd: sanitize(input.state.cwd),
      workspace: input.workspace
        ? { status: 'available', value: sanitize(input.workspace) }
        : statusUnavailable('workspace_adapter_unavailable'),
      project: input.project
        ? { status: 'available', value: sanitize(input.project) }
        : statusUnavailable('project_adapter_unavailable'),
    },
    model: input.model
      ? {
          status: 'available',
          provider: sanitize(input.model.provider),
          model: sanitize(input.model.model),
          liteModel:
            input.model.liteModel === null
              ? { status: 'disabled' }
              : input.model.liteModel === undefined
                ? statusUnavailable('lite_model_unavailable')
                : { status: 'available', value: sanitize(input.model.liteModel) },
          reasoningModel:
            input.model.reasoningModel === null
              ? { status: 'disabled' }
              : input.model.reasoningModel === undefined
                ? statusUnavailable('reasoning_model_unavailable')
                : { status: 'available', value: sanitize(input.model.reasoningModel) },
          source: input.model.source,
        }
      : {
          status: 'not_available',
          source: 'derived_unreliable',
          reason: { code: 'current_model_source_unavailable' },
        },
    runtime: {
      sandbox: sandbox
        ? {
            status: 'available',
            value: { tier: sandbox.tier, mechanism: sanitize(sandbox.mechanism) },
          }
        : statusUnavailable('sandbox_probe_unavailable'),
      filesystem: sandbox
        ? sandbox.features.filesystem
          ? { status: 'available', value: 'isolated' }
          : { status: 'not_available', reason: { code: 'filesystem_isolation_unavailable' } }
        : statusUnavailable('filesystem_probe_unavailable'),
      network: sandbox
        ? sandbox.features.network
          ? { status: 'available', value: 'restricted' }
          : { status: 'blocked', reason: { code: 'sandbox_network_blocked' } }
        : statusUnavailable('network_probe_unavailable'),
      permission:
        input.dangerousPermissions === undefined
          ? statusUnavailable('permission_mode_unavailable')
          : {
              status: 'available',
              value: input.dangerousPermissions
                ? { mode: 'bypassed', source: 'flag' }
                : { mode: 'ask', source: 'default' },
            },
      memory: input.memoryMode
        ? { status: 'available', value: { mode: sanitize(input.memoryMode) } }
        : statusUnavailable('memory_adapter_unavailable'),
    },
    auth: {
      configured:
        input.authConfigured === undefined
          ? statusUnavailable('auth_configured_adapter_unavailable')
          : { status: 'available', value: input.authConfigured },
      method: input.authMethod
        ? { status: 'available', value: input.authMethod }
        : statusUnavailable('auth_method_adapter_unavailable'),
    },
    settings,
    config: {
      sources: input.configSources
        ? { status: 'available', value: [...input.configSources] }
        : statusUnavailable('config_sources_adapter_unavailable'),
    },
    capabilities: {
      mcpServers: input.mcpServers
        ? {
            status: 'available',
            value: { count: input.mcpServers.length, names: sanitize([...input.mcpServers]) },
          }
        : statusUnavailable('mcp_discovery_adapter_unavailable'),
      skills: input.skills
        ? {
            status: 'available',
            value: { count: input.skills.length, names: sanitize([...input.skills]) },
          }
        : statusUnavailable('skills_discovery_adapter_unavailable'),
      plugins: input.plugins
        ? {
            status: 'available',
            value: { count: input.plugins.length, names: sanitize([...input.plugins]) },
          }
        : statusUnavailable('plugins_discovery_adapter_unavailable'),
    },
    usage: {
      tokens: {
        input: input.state.cumulativeUsage.input,
        output: input.state.cumulativeUsage.output,
        ...(input.state.cumulativeUsage.cacheRead === undefined
          ? {}
          : { cacheRead: input.state.cumulativeUsage.cacheRead }),
        ...(input.state.cumulativeUsage.cacheWrite === undefined
          ? {}
          : { cacheWrite: input.state.cumulativeUsage.cacheWrite }),
      },
      context: { ...input.state.contextBudget },
      costUSD: input.state.cumulativeUsage.costUSD,
    },
  }
}

export interface StatusSnapshotAdapterOptions {
  version: string
  sandbox(): Promise<SandboxDisclosure | undefined>
  configAvailable(): Promise<boolean>
  dangerousPermissions(state: SessionState): boolean
}

export function createStatusSnapshotAdapter(options: StatusSnapshotAdapterOptions) {
  return async (state: SessionState): Promise<StatusViewModel> => {
    const [sandbox, userConfigAvailable] = await Promise.all([
      options.sandbox(),
      options.configAvailable(),
    ])
    return buildStatusViewModel({
      state,
      version: options.version,
      ...(sandbox ? { sandbox } : {}),
      dangerousPermissions: options.dangerousPermissions(state),
      configSources: userConfigAvailable ? ['default', 'user'] : ['default'],
    })
  }
}

export interface ProductionPermissionSessionSnapshot {
  readonly dangerouslySkip: boolean
  readonly interactionMode: PermissionInteractionMode
}

export class PermissionSessionInvariantError extends Error {
  readonly code = 'permission_parent_snapshot_missing'

  constructor(parentSessionId: string) {
    super(
      `Permission policy invariant failed: parent session snapshot not found (${parentSessionId})`,
    )
    this.name = 'PermissionSessionInvariantError'
  }
}

/** Freezes security and interaction policy once, at the Runner/session creation boundary. */
export class ProductionPermissionSessionPolicy {
  #nextDangerouslySkip = false
  #nextInteractionMode: PermissionInteractionMode = 'none'
  readonly #snapshots = new Map<string, ProductionPermissionSessionSnapshot>()

  configureSecurity(input: { skipPermissions: boolean }): void {
    this.#nextDangerouslySkip = input.skipPermissions
  }

  configureInteraction(input: { mode: PermissionInteractionMode }): void {
    this.#nextInteractionMode = input.mode
  }

  snapshotFor(state: Pick<SessionState, 'id' | 'lineage'>): ProductionPermissionSessionSnapshot {
    const existing = this.#snapshots.get(state.id)
    if (existing) return existing
    if (state.lineage.depth === 0) {
      const snapshot = Object.freeze({
        dangerouslySkip: this.#nextDangerouslySkip,
        interactionMode: this.#nextInteractionMode,
      })
      this.#snapshots.set(state.id, snapshot)
      return snapshot
    }
    const parentSessionId = state.lineage.parentSessionId
    const snapshot = parentSessionId ? this.#snapshots.get(parentSessionId) : undefined
    if (!snapshot) throw new PermissionSessionInvariantError(parentSessionId ?? '<missing>')
    this.#snapshots.set(state.id, snapshot)
    return snapshot
  }

  snapshotForSession(sessionId: string): ProductionPermissionSessionSnapshot | undefined {
    return this.#snapshots.get(sessionId)
  }

  releaseLineage(sessionId: string): void {
    const snapshot = this.#snapshots.get(sessionId)
    if (!snapshot) return
    for (const [candidate, value] of this.#snapshots)
      if (value === snapshot) this.#snapshots.delete(candidate)
  }
}

export class RuntimeSessionPort implements SessionPort {
  #runner: Runner | undefined
  #events: EventBus | undefined
  #output?: { json: boolean; write: (value: string) => void }
  #lastExitCode = 0
  constructor(
    readonly sessionsDir: string,
    readonly createRunner: RunnerFactory,
    readonly onSecurity?: (input: { skipPermissions: boolean }) => void,
    readonly onPermissionInteraction?: (input: { mode: PermissionInteractionMode }) => void,
    readonly onEnd?: (sessionId: string) => void | Promise<void>,
    readonly onTerminalOutput?: (input: { streamToStdout: boolean }) => void,
    readonly onPermissionPromptHandler?: (
      handler:
        | ((request: InteractivePermissionRequest) => Promise<InteractivePermissionDecision>)
        | undefined,
    ) => void,
    readonly statusSnapshot?: (state: SessionState) => Promise<StatusViewModel>,
  ) {}
  configureSecurity(input: { skipPermissions: boolean }): void {
    this.onSecurity?.(input)
  }
  configurePermissionInteraction(input: { mode: PermissionInteractionMode }): void {
    this.onPermissionInteraction?.(input)
  }
  configureOutput(input: { json: boolean; write: (value: string) => void }): void {
    this.#output = input
  }
  configureTerminalOutput(input: { streamToStdout: boolean }): void {
    this.onTerminalOutput?.(input)
  }
  async start(input: { cwd: string; prompt?: string }): Promise<{ id: string; exitCode?: number }> {
    const session = await this.startInteractive({ cwd: input.cwd })
    if (input.prompt !== undefined) {
      await this.#runner!.run(input.prompt)
    } else {
      if (!isInteractiveTerminal()) throw new Error('Interactive chat requires a TTY or a prompt')
      for (;;) {
        const prompt = await promptLineMaybe('> ')
        if (prompt === undefined) break
        const trimmed = prompt.trim()
        if (!trimmed) continue
        if (trimmed === 'exit' || trimmed === 'quit') break
        await this.#runner!.run(prompt)
      }
      await session.end()
    }
    return { id: session.id, exitCode: session.exitCode() }
  }
  async startInteractive(input: { cwd: string }) {
    const id = uuidv7()
    await this.activate(
      createSession({ id, cwd: input.cwd, maxTokens: 200_000, toolRegistrySnapshot: 'builtin:l1' }),
    )
    return this.interactiveSession()
  }
  async resumeInteractive(id: string) {
    await this.resume(id)
    return this.interactiveSession()
  }
  private interactiveSession(): InteractiveSession {
    return {
      id: this.#runner!.state.id,
      cwd: this.#runner!.state.cwd,
      events: this.#events!,
      transcript: this.#runner!.state.messages.flatMap((message) => {
        const text = messageFullText(message.content)
        if (
          !text ||
          (message.role !== 'assistant' && message.role !== 'system' && message.role !== 'user')
        )
          return []
        return [{ id: message.id, role: message.role, text }]
      }),
      ...(this.statusSnapshot
        ? { getStatus: () => this.statusSnapshot!(this.#runner!.state) }
        : {}),
      setPermissionPromptHandler: (
        handler:
          | ((request: InteractivePermissionRequest) => Promise<InteractivePermissionDecision>)
          | undefined,
      ) => {
        this.onPermissionPromptHandler?.(handler)
      },
      interrupt: async () => {
        this.#runner?.interrupt()
      },
      submit: async (prompt: string, submitOptions?: SubmitOptions) => {
        await this.#runner!.run(
          prompt,
          submitOptions?.model ? { explicitModel: submitOptions.model } : undefined,
        )
      },
      end: async () => {
        await this.end()
      },
      exitCode: () => {
        const last = this.#runner?.state.turns.at(-1)
        if (!this.#runner) return this.#lastExitCode
        return last?.status === 'aborted' ? this.#lastExitCode : 0
      },
    }
  }
  async resume(id: string): Promise<{ id: string }> {
    if (!sessionIdPattern.test(id)) throw new Error('Invalid session id')
    const store = new SessionStore(this.path(id))
    // §8.2 D1-1（REM-74）：resume 一律走事件 replay（附录 D 形状；legacy session.snapshot
    // 行作为旧数据的基线兜底），禁止再写全量快照。
    const all = await store.load()
    const turnStarts = all.map((entry, index) => (entry.type === 'turn.started' ? index : -1))
    const tailTurns = 20
    const from = turnStarts.filter((index) => index >= 0).at(-tailTurns) ?? 0
    const entries = all.slice(from)
    const replayedTurns = entries.filter((entry) => entry.type === 'turn.started').length
    const skippedTurns = Math.max(
      0,
      turnStarts.filter((index) => index >= 0).length - replayedTurns,
    )
    const replay = replaySessionState(id, entries, {
      maxTokens: 200_000,
      toolRegistrySnapshot: 'builtin:l1',
    })
    if (!replay.found) throw new Error(`Session not found or has no resumable events: ${id}`)
    const state = updateSession(replay.state, (draft) => {
      draft.activeTurn = null
      draft.pendingInterrupt = false
      draft.turns = draft.turns.map((turn) =>
        terminalStatuses.has(turn.status) ? turn : { ...turn, status: 'aborted' },
      )
    })
    await this.activate(state, { tailTurns: replayedTurns, skippedTurns })
    return { id }
  }
  async list(): Promise<readonly SessionCandidate[]> {
    const candidates: SessionCandidate[] = []
    for await (const path of glob(join(this.sessionsDir, '*.jsonl'))) {
      try {
        const entries = await new SessionStore(path).load()
        if (entries.length === 0) continue
        // REM-74：候选不再依赖 session.snapshot，事件 replay（附录 D）直接派生；
        // 旧 session 的 snapshot 行由 replaySessionState 作为基线兜底。文件名是
        // session id 的唯一真相（bubbled 子事件带子 sessionId，不参与）。
        const id = basename(path, '.jsonl')
        const replay = replaySessionState(id, entries, {
          maxTokens: 200_000,
          toolRegistrySnapshot: 'builtin:l1',
        })
        const state = replay.state
        if (!sessionIdPattern.test(state.id) || typeof state.cwd !== 'string') continue
        const firstUser = state.messages.find((message) => message.role === 'user')
        const summary = firstUser ? messageText(firstUser.content) : undefined
        candidates.push({
          id: state.id,
          cwd: state.cwd,
          updatedAt: entries.at(-1)?.at ?? new Date().toISOString(),
          title: summary?.slice(0, 72) || `Session in ${state.cwd}`,
          ...(summary ? { summary } : {}),
        })
      } catch {
        // Ignore corrupt records while keeping healthy sessions available.
      }
    }
    return candidates.sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id),
    )
  }
  async interrupt(): Promise<void> {
    this.#runner?.interrupt()
  }
  async end(): Promise<void> {
    if (!this.#runner || !this.#events) return
    const sessionId = this.#runner.state.id
    // 附录 D.2 session.ended：★reason（exit|signal|error） ?exitCode。
    await this.#events.emit({
      type: 'session.ended',
      version: this.#runner.state.version,
      sessionId: this.#runner.state.id,
      payload: { reason: 'exit', exitCode: this.#lastExitCode },
    })
    await this.onEnd?.(sessionId)
    this.onPermissionPromptHandler?.(undefined)
    this.#runner = undefined
    this.#events = undefined
  }
  private path(id: string): string {
    return join(this.sessionsDir, `${id}.jsonl`)
  }
  private async activate(
    state: SessionState,
    resumed?: { tailTurns: number; skippedTurns: number },
  ): Promise<void> {
    const events = new EventBus()
    const store = new SessionStore(this.path(state.id))
    store.attach(events)
    const runner = await this.createRunner(state, events)
    let lastExitCode = 0
    events.subscribe((event) => {
      if (event.type !== 'turn.aborted') return
      // 附录 D.2 turn.aborted：{turnId, reason}——exitCode 由 reason 派生（130=用户中断）。
      const reason = (event.payload as { reason?: unknown }).reason
      lastExitCode = reason === 'user_interrupt' ? 130 : 1
      if (this.#events === events) this.#lastExitCode = lastExitCode
    })
    if (this.#output?.json) {
      const formatter = new MachineEventFormatter()
      events.subscribe((event) => {
        const line = formatter.encode(event)
        if (line) this.#output?.write(line)
      })
    }
    this.#events = events
    this.#runner = runner
    this.#lastExitCode = lastExitCode
    // 附录 D.2：冷启动 session.started {cwd}；恢复 session.resumed {tailTurns, skippedTurns}
    // 替代 session.started（W10）。
    await events.emit({
      type: resumed ? 'session.resumed' : 'session.started',
      version: state.version,
      sessionId: state.id,
      payload: resumed
        ? { tailTurns: resumed.tailTurns, skippedTurns: resumed.skippedTurns }
        : { cwd: state.cwd },
    })
  }
}

/** 会话选择器的单行摘要：折叠所有空白，保证标题不折行。 */
function messageText(content: SessionState['messages'][number]['content']): string {
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * resume transcript 的全保真提取：markdown 的块级结构（标题/列表/表格/代码块）
 * 全靠换行界定，折叠空白会把整段塌成一行流水文本。
 */
function messageFullText(content: SessionState['messages'][number]['content']): string {
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim()
}

export class FileInputHistoryStore {
  constructor(
    readonly path: string,
    readonly maxBytes = 1024 * 1024,
    readonly maxEntries = 1000,
    readonly maxInputBytes = 8 * 1024,
  ) {}

  async append(input: string): Promise<void> {
    const value = input.trim()
    if (!this.storeable(value)) return
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await appendFile(
      this.path,
      `${JSON.stringify({ at: new Date().toISOString(), input: value })}\n`,
      { mode: 0o600 },
    )
    await this.compact()
  }

  async list(): Promise<readonly string[]> {
    return (await this.records()).map((record) => record.input)
  }

  private storeable(input: string): boolean {
    if (!input) return false
    if (Buffer.byteLength(input, 'utf8') > this.maxInputBytes) return false
    if (historySecretPattern.test(input)) return false
    return sanitize(input) === input
  }

  private async compact(): Promise<void> {
    let records = (await this.records()).slice(-this.maxEntries)
    let serialized = serializeHistory(records)
    while (records.length > 0 && Buffer.byteLength(serialized, 'utf8') > this.maxBytes) {
      records = records.slice(1)
      serialized = serializeHistory(records)
    }
    const temp = `${this.path}.${process.pid}.tmp`
    await writeFile(temp, serialized, { mode: 0o600 })
    await rename(temp, this.path)
  }

  private async records(): Promise<Array<{ at: string; input: string }>> {
    try {
      const text = await readFile(this.path, 'utf8')
      return text
        .split('\n')
        .flatMap((line) => {
          if (!line) return []
          try {
            const record = JSON.parse(line) as { at?: unknown; input?: unknown }
            if (typeof record.input !== 'string') return []
            return [{ at: typeof record.at === 'string' ? record.at : '', input: record.input }]
          } catch {
            return []
          }
        })
        .filter((record) => this.storeable(record.input))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
}

function serializeHistory(records: readonly { at: string; input: string }[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '')
}

function requestHttp1(url: URL, input: HttpRequest): Promise<HttpResponse> {  // §4.6 强制路由：provider.anthropic.baseUrl 可能指向 http:// 网关（本地代理/自建网关，
  // 见 851f62e），按协议在 node:http / node:https 间分流，与 web-fetch.ts 范式一致。
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const req = transport(
      url,
      { method: input.method, headers: input.headers, signal: input.signal },
      (response) => {
        const headers = Object.fromEntries(
          Object.entries(response.headers).flatMap(([key, value]) =>
            value === undefined ? [] : [[key, Array.isArray(value) ? value.join(',') : value]],
          ),
        )
        resolve({ status: response.statusCode ?? 0, headers, body: response })
      },
    )
    req.once('error', reject)
    req.end(input.method === 'GET' ? undefined : JSON.stringify(input.body))
  })
}

const {
  HTTP2_HEADER_METHOD,
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_STATUS,
  NGHTTP2_CANCEL,
} = http2Constants

// https:// 走 HTTP/2：企业网关（AWS ALB + APISIX）对 HTTP/1.1 的 SSE 整批缓冲、
// 对 HTTP/2 逐帧下发（实测同请求 h1 单 blob vs h2 渐进 2s+），h1 下 TUI 无流式效果。
export function requestHttp2(url: URL, input: HttpRequest): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const session = http2Connect(url.origin)
    let responded = false
    session.once('error', (cause) => {
      if (!responded) {
        session.destroy()
        reject(cause)
      }
    })
    const stream = session.request({
      [HTTP2_HEADER_METHOD]: input.method,
      [HTTP2_HEADER_PATH]: `${url.pathname}${url.search}`,
      // http2 禁传连接级 header；:authority 由 session 权威值自动生成。
      ...Object.fromEntries(
        Object.entries(input.headers).filter(
          ([key]) => !H2_FORBIDDEN_HEADERS.has(key.toLowerCase()),
        ),
      ),
    })
    const onAbort = () => stream.close(NGHTTP2_CANCEL)
    if (input.signal.aborted) onAbort()
    else input.signal.addEventListener('abort', onAbort, { once: true })
    stream.once('error', (cause) => {
      if (!responded) {
        responded = true
        input.signal.removeEventListener('abort', onAbort)
        session.destroy()
        reject(cause)
      }
    })
    stream.once('response', (headers) => {
      responded = true
      const flat: Record<string, string> = {}
      for (const [key, value] of Object.entries(headers)) {
        if (key.startsWith(':') || value === undefined) continue
        flat[key] = Array.isArray(value) ? value.join(',') : value
      }
      const body = (async function* () {
        try {
          for await (const chunk of stream) yield Buffer.from(chunk)
        } finally {
          input.signal.removeEventListener('abort', onAbort)
          session.close()
        }
      })()
      resolve({
        status: Number(headers[HTTP2_HEADER_STATUS] ?? 0),
        headers: flat,
        body,
      })
    })
    stream.end(input.method === 'GET' ? undefined : JSON.stringify(input.body))
  })
}
const H2_FORBIDDEN_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'host',
])

export class NodeHttpPort implements HttpPort {
  async request(input: HttpRequest): Promise<HttpResponse> {
    const url = new URL(input.url)
    if (url.protocol !== 'https:') return requestHttp1(url, input)
    try {
      return await requestHttp2(url, input)
    } catch (cause) {
      // h2 协商失败（ALPN 未选 h2 / 对端不支持）→ 回退 HTTP/1.1：功能正确性优先于流式。
      // 只发生在收到响应头之前（requestHttp2 此后只 resolve 不 reject），重发 POST 安全。
      // 调用方主动 abort 不在此列——原样抛出。
      if (input.signal.aborted) throw cause
      return requestHttp1(url, input)
    }
  }
}

async function promptLine(question: string): Promise<string> {
  return (await promptLineMaybe(question)) ?? ''
}
function isInteractiveTerminal(): boolean {
  return (stdin.isTTY && stdout.isTTY)
}
async function promptLineMaybe(question: string): Promise<string | undefined> {
  if (!isInteractiveTerminal()) return undefined
  const io = createInterface({ input: stdin, output: stdout })
  try {
    return await io.question(question)
  } catch {
    return undefined
  } finally {
    io.close()
  }
}
async function promptSecret(question: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode) return ''
  stdout.write(question)
  stdin.setRawMode(true)
  stdin.resume()
  return new Promise((resolve, reject) => {
    let value = ''
    const finish = (error?: Error) => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      stdout.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new Error('Credential input was cancelled'))
        if (byte === 13 || byte === 10) return finish()
        if (byte === 8 || byte === 127) value = value.slice(0, -1)
        else if (byte >= 32) value += String.fromCharCode(byte)
      }
    }
    stdin.on('data', onData)
  })
}
async function permissionPrompt(
  request: InteractivePermissionRequest,
  terminalIsInteractive: () => boolean = isInteractiveTerminal,
  linePrompt: (question: string) => Promise<string | undefined> = promptLineMaybe,
): Promise<PermissionDecision> {
  if (!terminalIsInteractive()) return { kind: 'deny' }
  const answer = (
    (await linePrompt(
      request.display.approvable
        ? `Permission required: ${request.display.toolName} ${request.display.spec}\n[a]llow once, allow [s]ession, [d]eny: `
        : `Permission required: ${request.display.toolName} ${request.display.spec}\n[d]eny: `,
    )) ?? ''
  )
    .trim()
    .toLowerCase()
  if (!request.display.approvable) return { kind: 'deny' }
  return { kind: answer === 's' ? 'allow-session' : answer === 'a' ? 'allow-once' : 'deny' }
}

const MAX_PERMISSION_APPROVAL_DEPTH = 32
const MAX_PERMISSION_APPROVAL_NODES = 4_096
const MAX_PERMISSION_APPROVAL_BYTES = 64 * 1024
const permissionDetailsUnavailable = '[permission details unavailable - deny only]'
const sensitivePermissionDetailsHidden = '[sensitive permission details hidden - deny only]'

interface PermissionApprovalBudget {
  bytes: number
  nodes: number
  redacted: boolean
  readonly seen: Set<object>
}

interface PermissionApprovalValue {
  readonly complete: boolean
  readonly redacted: boolean
  readonly value: JsonValue
}

interface PermissionApprovalText extends Omit<PermissionApprovalValue, 'value'> {
  readonly value: string
}

function consumePermissionApprovalText(budget: PermissionApprovalBudget, value: string): void {
  budget.bytes -= Buffer.byteLength(value, 'utf8')
  if (budget.bytes < 0) throw new RangeError('permission approval exceeds its byte budget')
}

function hasOnlyStringKeys(keys: PropertyKey[]): keys is string[] {
  return keys.every((key) => typeof key === 'string')
}

function containsPermissionApprovalSecret(value: string): boolean {
  const normalized = normalizeForSecretDetection(value)
  return Boolean(detectSecret(value)) || sanitize(normalized) !== normalized
}

function isPermissionApprovalCredentialKey(value: string): boolean {
  const normalized = normalizeForSecretDetection(value)
  const probeValue = 'permission-approval-key-probe'
  const sanitizedProbe = sanitize({ [normalized]: probeValue })
  return isCredentialKeyForSecretDetection(value) || sanitizedProbe[normalized] !== probeValue
}

function clonePermissionApprovalValue(
  input: unknown,
  budget: PermissionApprovalBudget,
  depth = 0,
): JsonValue {
  budget.nodes -= 1
  if (budget.nodes < 0) throw new RangeError('permission approval exceeds its node budget')
  if (depth > MAX_PERMISSION_APPROVAL_DEPTH)
    throw new RangeError('permission approval exceeds its depth limit')
  if (input === null) return null
  if (typeof input === 'string') {
    consumePermissionApprovalText(budget, input)
    if (containsPermissionApprovalSecret(input)) {
      budget.redacted = true
      return '[REDACTED]'
    }
    return input
  }
  if (typeof input === 'boolean') return input
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || Object.is(input, -0))
      throw new TypeError('permission approval number cannot be represented exactly')
    return input
  }
  if (typeof input !== 'object') throw new TypeError('permission approval value is not JSON-safe')
  if (budget.seen.has(input)) throw new TypeError('permission approval value is cyclic')
  budget.seen.add(input)
  try {
    if (Array.isArray(input)) {
      if (input.length > budget.nodes)
        throw new RangeError('permission approval array exceeds its node budget')
      const keys = Reflect.ownKeys(input)
      if (!hasOnlyStringKeys(keys)) throw new TypeError('permission approval array has symbol keys')
      if (keys.length !== input.length + 1)
        throw new TypeError('permission approval array is sparse or has extra properties')
      const output: JsonValue[] = []
      for (let index = 0; index < input.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
        if (!descriptor?.enumerable || !('value' in descriptor))
          throw new TypeError('permission approval array has hidden or accessor elements')
        output.push(clonePermissionApprovalValue(descriptor.value, budget, depth + 1))
      }
      return output
    }

    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError('permission approval value is not a plain object')
    const keys = Reflect.ownKeys(input)
    if (keys.length > budget.nodes)
      throw new RangeError('permission approval object exceeds its node budget')
    if (!hasOnlyStringKeys(keys)) throw new TypeError('permission approval value has symbol keys')
    const output: Record<string, JsonValue> = {}
    for (const [index, key] of keys.entries()) {
      consumePermissionApprovalText(budget, key)
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (!descriptor?.enumerable || !('value' in descriptor))
        throw new TypeError('permission approval value has hidden or accessor properties')
      const safeKey = containsPermissionApprovalSecret(key) ? `[REDACTED_KEY_${index}]` : key
      if (safeKey !== key) budget.redacted = true
      if (Object.hasOwn(output, safeKey))
        throw new TypeError('permission approval redaction produced a duplicate key')
      const redactValue = isPermissionApprovalCredentialKey(key)
      if (redactValue) budget.redacted = true
      Object.defineProperty(output, safeKey, {
        configurable: true,
        enumerable: true,
        value: redactValue
          ? '[REDACTED]'
          : clonePermissionApprovalValue(descriptor.value, budget, depth + 1),
        writable: true,
      })
    }
    return output
  } finally {
    budget.seen.delete(input)
  }
}

function freezePermissionApprovalValue<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && 'value' in descriptor) freezePermissionApprovalValue(descriptor.value)
  }
  return Object.freeze(value)
}

function preparePermissionApprovalValue(
  input: unknown,
  fallback: JsonValue,
): PermissionApprovalValue {
  try {
    const budget: PermissionApprovalBudget = {
      bytes: MAX_PERMISSION_APPROVAL_BYTES,
      nodes: MAX_PERMISSION_APPROVAL_NODES,
      redacted: false,
      seen: new Set(),
    }
    const detectedSafeValue = clonePermissionApprovalValue(input, budget)
    const sanitizedValue = sanitize(detectedSafeValue)
    const sanitizerRedacted = JSON.stringify(sanitizedValue) !== JSON.stringify(detectedSafeValue)
    return freezePermissionApprovalValue({
      complete: true,
      redacted: budget.redacted || sanitizerRedacted,
      value: sanitizedValue,
    })
  } catch {
    return freezePermissionApprovalValue({ complete: false, redacted: false, value: fallback })
  }
}

function preparePermissionApprovalSpec(input: PermissionSpec): PermissionApprovalValue {
  const prepared = preparePermissionApprovalValue(input, {
    custom: { permissionApproval: permissionDetailsUnavailable },
  })
  if (prepared.value && typeof prepared.value === 'object' && !Array.isArray(prepared.value))
    return prepared
  return freezePermissionApprovalValue({
    complete: false,
    redacted: false,
    value: { custom: { permissionApproval: permissionDetailsUnavailable } },
  })
}

function preparePermissionApprovalText(input: string): PermissionApprovalText {
  const prepared = preparePermissionApprovalValue(input, '[permission label unavailable]')
  if (typeof prepared.value === 'string')
    return freezePermissionApprovalValue({
      complete: prepared.complete,
      redacted: prepared.redacted,
      value: prepared.value,
    })
  return freezePermissionApprovalValue({
    complete: false,
    redacted: false,
    value: '[permission label unavailable]',
  })
}

function buildPermissionDisplay(
  spec: PermissionApprovalValue,
  toolName: PermissionApprovalText,
  input: PermissionApprovalValue,
  toolUseId: PermissionApprovalText,
): InteractivePermissionRequest['display'] {
  const sanitizedSpec = formatPermissionValueForDisplay(spec.value)
  const sanitizedToolName = formatPermissionTextForDisplay(toolName.value)
  if (
    !spec.complete ||
    !toolName.complete ||
    !input.complete ||
    !toolUseId.complete ||
    !sanitizedSpec.approvable ||
    !sanitizedToolName.approvable
  )
    return {
      approvable: false,
      spec: permissionDetailsUnavailable,
      toolName: sanitizedToolName.text,
    }
  if (spec.redacted || toolName.redacted || input.redacted || toolUseId.redacted)
    return {
      approvable: false,
      spec: sensitivePermissionDetailsHidden,
      toolName: toolName.redacted ? '[sensitive tool name hidden]' : sanitizedToolName.text,
    }
  return { approvable: true, spec: sanitizedSpec.text, toolName: sanitizedToolName.text }
}

export async function requestPermission(input: {
  events: EventBus
  interactionMode: PermissionInteractionMode
  interactivePermissionPrompt:
    | ((request: InteractivePermissionRequest) => Promise<InteractivePermissionDecision>)
    | undefined
  request: PermissionRequest
  /** Deterministic test seam; production always uses the real terminal predicate. */
  terminalIsInteractive?: () => boolean
  /** Deterministic line-input seam; production uses promptLineMaybe. */
  linePermissionPrompt?: (question: string) => Promise<string | undefined>
  version: number
}): Promise<PermissionDecision> {
  const id = uuidv7()
  const approvalSpec = preparePermissionApprovalSpec(input.request.spec)
  const approvalToolName = preparePermissionApprovalText(input.request.toolName)
  const approvalToolUseId = preparePermissionApprovalText(input.request.toolUseId ?? id)
  const approvalInput = preparePermissionApprovalValue(
    input.request.input,
    '[permission input unavailable]',
  )
  const display = freezePermissionApprovalValue(
    buildPermissionDisplay(approvalSpec, approvalToolName, approvalInput, approvalToolUseId),
  )
  const approvalAllowed = display.approvable
  const uiRequest = freezePermissionApprovalValue<InteractivePermissionRequest>({
    display,
    id,
    attempt: input.request.attempt,
    input: approvalInput.value,
    spec: approvalSpec.value,
    toolName: approvalToolName.value,
  })
  // 附录 D.2 tool.permission_asked：{toolUseId, tool, spec}——toolUseId 优先用真实
  // tool_use id（ToolExecutor 透传），非模型路径回退本次弹窗请求 id。
  await input.events.emit({
    type: 'tool.permission_asked',
    version: input.version,
    sessionId: input.request.session.id,
    payload: {
      toolUseId: approvalToolUseId.value,
      tool: approvalToolName.value,
      spec: approvalSpec.value,
    },
  })
  if (input.interactionMode === 'none') return { kind: 'deny' }
  if (input.interactionMode === 'line')
    return permissionPrompt(
      uiRequest,
      input.terminalIsInteractive ?? isInteractiveTerminal,
      input.linePermissionPrompt ?? promptLineMaybe,
    )
  if (!input.interactivePermissionPrompt) return { kind: 'deny' }
  const decision = await input.interactivePermissionPrompt(uiRequest)
  if (!approvalAllowed) return { kind: 'deny' }
  return { kind: decision.kind }
}

export interface ProductionPermissionConfiguration {
  readonly dangerouslySkip: boolean
  logger?: Logger
}

export interface ProductionToolPermissionChainOptions {
  state: Pick<SessionState, 'id' | 'cwd' | 'version' | 'lineage'>
  events: EventBus
  permissionSnapshot: ProductionPermissionSessionSnapshot
  logger?: Logger
  interactivePermissionPrompt: () =>
    | ((request: InteractivePermissionRequest) => Promise<InteractivePermissionDecision>)
    | undefined
  /** Deterministic test seam; omitted by createProductionPorts. */
  terminalIsInteractive?: () => boolean
  /** Deterministic test seam; omitted by createProductionPorts. */
  linePermissionPrompt?: (question: string) => Promise<string | undefined>
}

export interface ProductionToolPermissionChain {
  permissionRequests: Pick<PermissionManager, 'request'>
  bindExecutor(
    context: (signal: AbortSignal) => ToolContext,
    dispatchHook?: ToolHookDispatcher,
  ): Pick<ToolExecutor, 'execute'>
}

/**
 * Single production composition point for tool permission enforcement.
 *
 * PromptLoader receives only the request view, while ToolExecutor can be bound exactly once so
 * requestPermission and native execution cannot drift or expose cache/prompt mutation controls.
 */
export function createProductionToolPermissionChain(
  options: ProductionToolPermissionChainOptions,
): ProductionToolPermissionChain {
  const configuration: ProductionPermissionConfiguration = Object.freeze({
    dangerouslySkip: options.permissionSnapshot.dangerouslySkip,
    ...(options.logger ? { logger: options.logger } : {}),
  })
  const interactionMode = options.permissionSnapshot.interactionMode
  const permissions = new PermissionManager({}, configuration)
  permissions.setPromptHandler(async (request) => {
    const decision = await requestPermission({
      events: options.events,
      interactionMode,
      interactivePermissionPrompt: options.interactivePermissionPrompt(),
      request,
      ...(options.terminalIsInteractive
        ? { terminalIsInteractive: options.terminalIsInteractive }
        : {}),
      ...(options.linePermissionPrompt
        ? { linePermissionPrompt: options.linePermissionPrompt }
        : {}),
      version: options.state.version,
    })
    if (options.state.lineage.depth === 0) return decision
    return ['allow-once', 'allow-session', 'deny'].includes(decision.kind)
      ? decision
      : { kind: 'deny' }
  })
  let bound = false
  return {
    permissionRequests: Object.freeze({ request: permissions.request.bind(permissions) }),
    bindExecutor(context, dispatchHook) {
      if (bound) throw new Error('Production permission executor is already bound')
      bound = true
      const executor = new ToolExecutor(permissions, context, dispatchHook)
      return Object.freeze({ execute: executor.execute.bind(executor) })
    },
  }
}

export interface ProductionOptions {
  apolloHome?: string
  identity: Readonly<AppIdentity>
  model?: string
}

function diagnosticRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
const LEGACY_PLUGIN_NAME = /^apollo-plugin-[a-z0-9][a-z0-9._-]{0,127}$/
function assertLegacyPluginName(name: string): void {
  if (!LEGACY_PLUGIN_NAME.test(name))
    throw new PluginError('plugin_path_escape', 'invalid plugin target')
}

async function readContainedPluginDiagnostic(
  pluginRoot: string,
  name: string,
  storedVersion: string,
  apolloVersion: string,
): Promise<{
  version: string
  permissions: readonly string[]
  compatibility: PluginCompatibilityDiagnostic
}> {
  const manifestLimit = 1024 * 1024
  const permissionLimit = 64
  const permissionLengthLimit = 128
  const safeStoredVersion =
    storedVersion.length <= 128 && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(storedVersion)
      ? storedVersion
      : 'unknown'
  const invalid = (detail: string) => ({
    version: safeStoredVersion,
    permissions: [] as readonly string[],
    compatibility: { status: 'invalid' as const, detail },
  })
  assertLegacyPluginName(name)
  let manifest: unknown
  try {
    const canonicalRoot = await realpath(pluginRoot)
    const expectedDirectory = join(canonicalRoot, name)
    const canonicalDirectory = await realpath(expectedDirectory)
    if (canonicalDirectory !== expectedDirectory)
      return invalid('Plugin directory is not canonical; legacy activation remains unavailable.')
    const expectedManifest = join(canonicalDirectory, 'manifest.json')
    const canonicalManifest = await realpath(expectedManifest)
    if (canonicalManifest !== expectedManifest)
      return invalid('Manifest path is not canonical; legacy activation remains unavailable.')
    const handle = await open(canonicalManifest, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > manifestLimit)
        return invalid(
          'Manifest metadata exceeds diagnostic limits; legacy activation remains unavailable.',
        )
      const buffer = Buffer.alloc(manifestLimit + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > manifestLimit)
        return invalid(
          'Manifest metadata exceeds diagnostic limits; legacy activation remains unavailable.',
        )
      manifest = JSON.parse(buffer.toString('utf8', 0, bytesRead))
    } finally {
      await handle.close()
    }
  } catch {
    return invalid('Manifest metadata is unreadable; legacy activation remains unavailable.')
  }
  if (!diagnosticRecord(manifest))
    return invalid('Manifest metadata is invalid; legacy activation remains unavailable.')
  const permissionsRecord = diagnosticRecord(manifest.permissions)
    ? manifest.permissions
    : undefined
  const rawPermissions = permissionsRecord?.apollo
  if (Array.isArray(rawPermissions) && rawPermissions.length > permissionLimit)
    return invalid(
      'Manifest permissions exceed diagnostic limits; legacy activation remains unavailable.',
    )
  const permissions: string[] = []
  if (Array.isArray(rawPermissions)) {
    for (const permission of rawPermissions) {
      if (
        typeof permission !== 'string' ||
        permission.length > permissionLengthLimit ||
        !/^[a-z][a-z0-9.:-]*$/.test(permission)
      )
        return invalid('Manifest permissions are invalid; legacy activation remains unavailable.')
      permissions.push(permission)
    }
  }
  const engines = diagnosticRecord(manifest.engines) ? manifest.engines : undefined
  const range =
    typeof engines?.apollo === 'string' && engines.apollo.length <= 256 ? engines.apollo : undefined
  const compatibility: PluginCompatibilityDiagnostic = range
    ? satisfies(apolloVersion, range)
      ? {
          status: 'compatible',
          detail: `Declared Apollo engine range is compatible with ${apolloVersion}.`,
        }
      : {
          status: 'incompatible',
          detail: `Declared Apollo engine range is incompatible with ${apolloVersion}; legacy activation remains unavailable.`,
        }
    : {
        status: 'invalid',
        detail: 'Manifest engine metadata is invalid; legacy activation remains unavailable.',
      }
  return {
    version:
      typeof manifest.version === 'string' &&
      manifest.version.length <= 128 &&
      /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(manifest.version)
        ? manifest.version
        : safeStoredVersion,
    permissions,
    compatibility,
  }
}

export function registerRuntimeMemoryPrompts(
  composer: PromptComposer,
  memory: MemoryService,
  state: Pick<SessionState, 'cwd' | 'id'>,
) {
  return new MemoryPromptProvider(memory, {
    scopes: [
      sessionMemoryScope(state.cwd, state.id),
      projectMemoryScope(state.cwd),
      workspaceMemoryScope(),
    ],
  }).register(composer)
}

export interface PluginMemoryHostOptions {
  readonly home: string
  readonly cwd: string
  readonly sessionId?: string
  readonly memory: MemoryService
  readonly memoryRecall: MemoryRecallService
  readonly memoryTransfer: MemoryTransferService
}

export type PluginMemoryHost = (
  plugin: string,
  operation: string,
  rawParams: unknown,
) => Promise<unknown>

/** Production plugin adapter. Memory content stays inside MemoryService and never enters audit. */
export function createPluginMemoryHost(options: PluginMemoryHostOptions): PluginMemoryHost {
  return async (plugin: string, operation: string, rawParams: unknown): Promise<unknown> => {
    const params = rawParams as {
      scope: PluginMemoryScope
      id?: string
      query?: string
      options?: { limit?: number; tags?: readonly string[]; pinned?: boolean }
      content?: string
      tags?: readonly string[]
      pinned?: boolean
      patch?: { content?: string; tags?: readonly string[]; pinned?: boolean }
    }
    const scope =
      params.scope === 'workspace'
        ? workspaceMemoryScope()
        : params.scope === 'project'
          ? projectMemoryScope(options.cwd)
          : options.sessionId
            ? sessionMemoryScope(options.cwd, options.sessionId)
            : (() => {
                throw new MemoryError(
                  'memory_scope_denied',
                  'Session memory requires an active session',
                )
              })()
    const auditPath = join(options.home, 'memory', 'audit.jsonl')
    const writeOperation = ['create', 'update', 'delete'].includes(operation)
    if (writeOperation) {
      await mkdir(join(options.home, 'memory'), { recursive: true, mode: 0o700 })
      await appendFile(
        auditPath,
        `${JSON.stringify({
          schemaVersion: 1,
          at: new Date().toISOString(),
          phase: 'attempt',
          plugin,
          operation,
          scope: params.scope,
          ...(params.id ? { id: sanitize(params.id) } : {}),
        })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
    }
    let result: unknown
    if (operation === 'get') result = (await options.memory.get(scope, String(params.id))) ?? null
    else if (operation === 'list') result = await options.memory.list(scope, params.options)
    else if (operation === 'search')
      result = await options.memoryRecall.recall(scope, String(params.query ?? ''), params.options)
    else if (operation === 'create')
      result = await options.memory.create({
        ...(params.id ? { id: params.id } : {}),
        scope,
        content: String(params.content ?? ''),
        provenance: { source: 'agent', actorId: `plugin:${plugin}` },
        ...(params.tags ? { tags: params.tags } : {}),
        ...(params.pinned === undefined ? {} : { pinned: params.pinned }),
      })
    else if (operation === 'update')
      result = await options.memory.update(scope, String(params.id), params.patch ?? {})
    else if (operation === 'delete') result = await options.memory.delete(scope, String(params.id))
    else result = await options.memoryTransfer.export([scope])
    await mkdir(join(options.home, 'memory'), { recursive: true, mode: 0o700 })
    await appendFile(
      auditPath,
      `${JSON.stringify({
        schemaVersion: 1,
        at: new Date().toISOString(),
        phase: 'success',
        plugin,
        operation,
        scope: params.scope,
        ...(params.id ? { id: sanitize(params.id) } : {}),
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    return result
  }
}

/**
 * Resolve the legacy context-tuning compatibility switch for a production Runner.
 * A missing file is the documented default-off case. Unreadable, invalid, or non-boolean
 * configuration fails closed by propagating the configuration error before tuning is read.
 * Only an own-property boolean `true` is authority; an inherited/prototype value never counts.
 */
export async function loadProductionContextTuning(options: {
  readonly home: string
  readonly persistence: EvolutionPersistence
  readonly logger: Pick<Logger, 'warn'>
}): Promise<{
  readonly config: Record<string, JsonValue>
  readonly values: Record<ContextTunableParam, number>
}> {
  let enabled = false
  let config: Record<string, JsonValue> = {}
  try {
    config = await loadTomlFile(join(options.home, 'config.toml'), {
      onWarning: (message) => options.logger.warn(message),
    })
    const section = config.evolution
    enabled = Boolean(
      section &&
      typeof section === 'object' &&
      !Array.isArray(section) &&
      Object.hasOwn(section, 'enabled') &&
      section.enabled === true,
    )
  } catch (error) {
    // A missing file means the documented default-off posture. Syntax, type, and I/O
    // failures are configuration failures and must stop Runner construction (§8.3/C.1).
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return {
    config,
    values: await new EvolutionEngine(options.persistence, { enabled }).values(),
  }
}

/**
 * Bash 工具的生产 native 桥（spec 04-tools-permissions.md §4.3.1 / r13-I11）：
 * 把工具算好的最小 env（PATH/HOME/LANG/TZ + [tools] pass_through_env 白名单，
 * 值可含 [env] 段写入 process.env 的配置）透传进 apollo-sandbox——Rust 侧
 * env_clear 后只注入 permissions.env.read 白名单内的名字，宿主其余环境不进沙箱。
 * `env` 绝不与宿主全量环境合并（tool-kit NativeBridge 契约）。
 */
export function createSandboxNativeBridge(options: {
  readonly cwd: () => string
  readonly onViolation: (input: { tier: SandboxTier; reason: string }) => Promise<void>
}): NativeBridge {
  return {
    async execute(command, args, signal, env) {
      const cwd = options.cwd()
      const result = await execSandbox(
        {
          command: [command, ...args].join(' '),
          cwd,
          permissions: {
            fs: { read: [cwd], write: [cwd] },
            net: false,
            env: { read: Object.keys(env ?? {}) },
          },
          ...(env ? { env } : {}),
        },
        signal,
      )
      for (const reason of result.sandbox_violations)
        await options.onViolation({ tier: result.sandbox_tier, reason })
      return result.stdout
    },
  }
}

export function createProductionPorts(options: ProductionOptions): ApolloPorts {
  const home = options.apolloHome ?? process.env.APOLLO_HOME ?? join(homedir(), '.apollo')
  const backups = new BackupStore(join(home, 'backups'))
  const evolution = new EvolutionStore(join(home, 'tuning'))
  const memoryRepository = new LocalMemoryRepository(join(home, 'memory', 'records.json'))
  const memoryIndex = new LocalKeywordMemoryIndex(join(home, 'memory', 'index.json'))
  const history = new FileInputHistoryStore(join(home, 'history', 'input.jsonl'))
  const trust = new DirectoryTrustStore(home)
  const telemetryPath = join(home, 'telemetry', 'events.jsonl')
  const telemetry = new Telemetry(new LocalTelemetrySink(telemetryPath))
  const telemetryStore = new TelemetryStore(telemetryPath)
  const logger = new TelemetryLogger(telemetry, 'cli')
  const pluginRoot = join(home, 'plugins')
  const plugins = new PluginManager(pluginRoot, options.identity.version, async () => false)
  const pluginsReady = plugins.init()
  void pluginsReady.catch(() => undefined)
  let memory: MemoryService
  let memoryRecall: DefaultMemoryRecallService
  let memoryTransfer: MemoryTransferService
  memory = new IndexingMemoryService(
    new DefaultMemoryService(memoryRepository),
    memoryRepository,
    memoryIndex,
  )
  memoryRecall = new DefaultMemoryRecallService(memory, memoryIndex)
  const memoryMaintenance = new DefaultMemoryMaintenanceService(memoryRepository, memoryIndex)
  memoryTransfer = new MemoryTransferService(memory, {
    journalPath: join(home, 'memory', 'import-journal.json'),
  })
  const slashCommands = new MutableSlashCommandRegistry()
  let cachedPassphrase: string | undefined
  const passphrase = async () => {
    if (cachedPassphrase) return cachedPassphrase
    const value = await promptSecret('Credential-store passphrase: ')
    if (!value) throw new Error('A credential-store passphrase is required')
    cachedPassphrase = value
    return value
  }
  const encrypted = new EncryptedCredentialStore(
    join(home, 'credentials.enc'),
    passphrase,
    join(home, 'auth.state.json'),
  )
  /**
   * 用户级 config.toml 的 [auth] 段（§8.4 Layer 4 / skipAuth）。
   * 项目级 config 到不了这里：§8.3.1 数据流向门把整段标为 forbidden。
   */
  const readAuthSection = async (): Promise<Record<string, JsonValue>> => {
    let config: Record<string, JsonValue>
    try {
      config = await loadTomlFile(join(home, 'config.toml'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
    const section = config.auth
    return section && typeof section === 'object' && !Array.isArray(section)
      ? (section as Record<string, JsonValue>)
      : {}
  }
  /** login 的 verify 请求要打向配置的网关（§8.3 provider.<name>.baseUrl），否则网关 key 在官方端点上必然 4xx。 */
  const readAnthropicBaseUrl = async (): Promise<string | undefined> => {
    let config: Record<string, JsonValue>
    try {
      config = await loadTomlFile(join(home, 'config.toml'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const provider = config.provider
    const entry =
      provider && typeof provider === 'object' && !Array.isArray(provider)
        ? (provider as Record<string, JsonValue>).anthropic
        : undefined
    const baseUrl =
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry as Record<string, JsonValue>).baseUrl
        : undefined
    return typeof baseUrl === 'string' && baseUrl ? baseUrl : undefined
  }
  const auth = new AuthManager({
    encrypted,
    env: process.env,
    telemetry,
    configKeys: async (provider) => {
      const value = (await readAuthSection())[`${provider}_api_key`]
      return typeof value === 'string' && value ? value : undefined
    },
  })
  let skipAuthEmitted = false
  const http = new NodeHttpPort()
  const permissionPolicy = new ProductionPermissionSessionPolicy()
  let interactivePermissionPrompt:
    | ((request: InteractivePermissionRequest) => Promise<InteractivePermissionDecision>)
    | undefined
  let streamToStdout = true
  let dispatcher: SubagentDispatcher
  const createRunner: RunnerFactory = async (state, events) => {
    const permissionSnapshot = permissionPolicy.snapshotFor(state)
    // A manager per Runner is intentional: child sessions cannot inherit parent permission cache.
    const permissionChain = createProductionToolPermissionChain({
      state,
      events,
      permissionSnapshot,
      logger,
      interactivePermissionPrompt: () => interactivePermissionPrompt,
    })
    const { permissionRequests } = permissionChain
    // §15 T0: persisted values apply only after an explicit, typed boolean opt-in.
    const { config: userConfig, values: tuned } = await loadProductionContextTuning({
      home,
      persistence: evolution,
      logger,
    })
    // [auth] skipAuth = true（§8.4）：完全跳过凭据解析，请求不带 x-api-key
    // （企业网关 / 本地代理等带外认证场景）。设了就不再触碰任何 credential 层，
    // 也不会触发 enc 文件 passphrase 提示。
    const authSection = userConfig.auth
    const skipAuth = Boolean(
      authSection &&
      typeof authSection === 'object' &&
      !Array.isArray(authSection) &&
      authSection.skipAuth === true,
    )
    const providerSection = userConfig.provider
    const anthropicEntry =
      providerSection && typeof providerSection === 'object' && !Array.isArray(providerSection)
        ? providerSection.anthropic
        : undefined
    const configuredBaseUrl =
      anthropicEntry && typeof anthropicEntry === 'object' && !Array.isArray(anthropicEntry)
        ? anthropicEntry.baseUrl
        : undefined
    // 模型解析（§8.3）：preferences.model（TUI 状态面板选择，id 形如 'anthropic/<model>'）
    // → provider.anthropic.model（静态配置）→ 调用方覆盖/默认值在 SingleProviderRouter 入参处收口
    const preferencesSection = userConfig.preferences
    const preferencesModel =
      preferencesSection &&
      typeof preferencesSection === 'object' &&
      !Array.isArray(preferencesSection) &&
      typeof preferencesSection.model === 'string'
        ? preferencesSection.model.replace(/^anthropic\//, '')
        : undefined
    const providerModel =
      anthropicEntry &&
      typeof anthropicEntry === 'object' &&
      !Array.isArray(anthropicEntry) &&
      typeof anthropicEntry.model === 'string'
        ? anthropicEntry.model
        : undefined
    const configuredModel = preferencesModel ?? providerModel
    const contextPolicy = new SlidingWindowPolicy({
      compactionThreshold: tuned.compaction_threshold,
      targetRatio: tuned.target_ratio,
      keepRecent: tuned.keep_recent,
    })
    const composer = new DefaultPromptComposer()
    composer.register(builtinPromptFragment)
    registerRuntimeMemoryPrompts(composer, memory, state)
    const promptLoader = new PromptLoader({
      cwd: state.cwd,
      apolloHome: home,
      permissions: permissionRequests,
    })
    await promptLoader.registerProject(composer)
    const skills = new SkillsRuntime({
      skillsDir: join(home, 'skills'),
      apolloVersion: options.identity.version,
      composer,
      onWarning: (message) => logger.warn(message),
    })
    await skills.discover()
    await skills.registerIndex()
    await skills.activateAutomatic(state.cwd)
    const attachments = new AttachmentStore(
      join(home, 'sessions', state.id, 'attachments'),
      20 * 1024 * 1024,
      [state.cwd],
    )
    const anthropic = new AnthropicClient({
      credentials: {
        async getCredential() {
          if (skipAuth) {
            if (!skipAuthEmitted) {
              skipAuthEmitted = true
              await telemetry.emit(
                'auth.credential.skipped',
                'auth',
                sanitize({ provider: 'anthropic', source: 'auth.skipAuth' }),
              )
            }
            return undefined
          }
          const value = await auth.getCredential('anthropic')
          if (!value) throw new Error('Anthropic credential unavailable')
          return value
        },
      },
      http,
      attachments,
      ...(typeof configuredBaseUrl === 'string' && configuredBaseUrl
        ? { baseUrl: configuredBaseUrl }
        : {}),
    })
    const client = {
      ...anthropic,
      name: anthropic.name,
      capabilities: anthropic.capabilities,
      dispose: () => anthropic.dispose(),
      async *stream(request: Parameters<AnthropicClient['stream']>[0], signal: AbortSignal) {
        for await (const chunk of anthropic.stream(request, signal)) {
          if (streamToStdout && chunk.kind === 'text.delta') stdout.write(chunk.text)
          yield chunk
        }
        if (streamToStdout) stdout.write('\n')
      },
    }
    const providers = new InMemoryProviderRegistry()
    providers.register(
      client,
      { kind: 'core' },
      { capabilities: client.capabilities, displayName: 'Anthropic' },
    )
    let router: RouterPolicy = new SingleProviderRouter(
      client,
      options.model ?? configuredModel ?? 'claude-sonnet-4-20250514',
      undefined,
      providers,
    )
    const routerConfig = userConfig.router
    if (
      routerConfig &&
      typeof routerConfig === 'object' &&
      !Array.isArray(routerConfig) &&
      routerConfig.type === 'role'
    )
      router = new RoleRouter(providers, parseRoleRouterConfig(routerConfig))
    // [tools] 段（§4.3.1 / r13-I11）在这里接线进 Bash 工具：shell 固定逻辑与
    // env 继承白名单；缺省时 BashTool 走内置默认（Unix /bin/bash；PATH/HOME/LANG/TZ）。
    const toolsSection = userConfig.tools
    const toolsConfig =
      toolsSection && typeof toolsSection === 'object' && !Array.isArray(toolsSection)
        ? (toolsSection as Record<string, JsonValue>)
        : {}
    const windowsShell =
      typeof toolsConfig.windows_shell === 'string' && toolsConfig.windows_shell
        ? toolsConfig.windows_shell
        : undefined
    const passThroughEnv = Array.isArray(toolsConfig.pass_through_env)
      ? toolsConfig.pass_through_env.filter(
          (name): name is string => typeof name === 'string' && name !== '',
        )
      : undefined
    const registry = new ToolRegistry()
    for (const tool of builtinTools({
      backups,
      bash: {
        ...(windowsShell ? { windowsShell } : {}),
        ...(passThroughEnv ? { passThroughEnv } : {}),
      },
      task: {
        dispatcher,
        parent: (signal) => ({
          state: runner.state,
          events,
          turnId: runner.state.activeTurn ?? '',
          signal,
        }),
      },
    }))
      registry.register(tool)
    for (const tool of createMemoryTools(memory)) registry.register(tool)
    registry.register({
      name: 'Skill.activate',
      description: 'Activate an installed prompt skill for the current session',
      readonly: true,
      parallelSafe: true,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      permissionSpec: () => ({}),
      async invoke(input: unknown) {
        const name = (input as { name: string }).name
        const activated = await skills.activate(name)
        return {
          content: [
            {
              type: 'text',
              text: activated ? `Activated skill: ${name}` : `Skill already active: ${name}`,
            },
          ],
          meta: { durationMs: 0, costImpact: 'safe' },
        }
      },
    })
    let runner: Runner
    const native = createSandboxNativeBridge({
      cwd: () => runner.state.cwd,
      onViolation: async ({ tier, reason }) => {
        await telemetry.violation({
          mechanism: 'apollo-sandbox',
          tier,
          operation: 'sandbox-exec',
          decision: 'deny',
          reason,
        })
      },
    })
    const executor = permissionChain.bindExecutor((signal) => ({
      abortSignal: signal,
      session: { id: state.id, cwd: state.cwd, turnId: runner.state.activeTurn ?? '' },
      native,
      logger,
      ui: { requestInput: promptLine },
    }))
    const tools: RunnerToolPort = {
      schemas: () => registry.forProvider(),
      async execute(use, signal) {
        const tool = registry.get(use.name)
        if (!tool)
          return {
            toolUseId: use.id,
            isError: true,
            content: [{ type: 'text', text: `Unknown tool: ${use.name}` }],
          }
        const result = await executor.execute(tool, use.input, signal, use.id)
        return {
          toolUseId: use.id,
          content: result.content,
          ...(result.isError === undefined ? {} : { isError: result.isError }),
          ...(result.meta?.linesAdded === undefined ? {} : { linesAdded: result.meta.linesAdded }),
          ...(result.meta?.linesRemoved === undefined
            ? {}
            : { linesRemoved: result.meta.linesRemoved }),
        }
      },
    }
    runner = new Runner(state, router, composer, tools, events, {}, contextPolicy)
    return runner
  }
  dispatcher = new SubagentDispatcher({
    runnerFactory: createRunner,
    maxDepth: 3,
    maxConcurrency: 4,
    defaultBudget: {
      costUSDMax: 1,
      tokenMax: 200_000,
      timeMsMax: 10 * 60_000,
      toolCallMax: 100,
    },
  })
  const session = new RuntimeSessionPort(
    join(home, 'sessions'),
    createRunner,
    (input) => permissionPolicy.configureSecurity(input),
    (input) => permissionPolicy.configureInteraction(input),
    async (sessionId) => {
      permissionPolicy.releaseLineage(sessionId)
      await memory.flush()
    },
    (input) => {
      streamToStdout = input.streamToStdout
    },
    (handler) => {
      interactivePermissionPrompt = handler
    },
    createStatusSnapshotAdapter({
      version: options.identity.version,
      dangerousPermissions: (state) =>
        permissionPolicy.snapshotForSession(state.id)?.dangerouslySkip ?? false,
      configAvailable: () =>
        access(join(home, 'config.toml')).then(
          () => true,
          () => false,
        ),
      async sandbox() {
        const value = await probeSandbox().catch(() => undefined)
        if (!value) return undefined
        const features = value.features
        return {
          tier: value.tier,
          mechanism: typeof features.mechanism === 'string' ? features.mechanism : 'apollo-sandbox',
          features: {
            filesystem: Boolean(features.filesystem ?? value.tier !== 'none'),
            network: Boolean(features.network),
          },
          degradationReasons: value.known_limitations,
        }
      },
    }),
  )
  return {
    identity: options.identity,
    version: options.identity.version,
    session,
    ui: {
      renderInteractiveApp: (input) =>
        renderInteractiveApp({
          history,
          slashCommandRegistry: slashCommands,
          // r13-G4 (spec 08-session-config.md §8.6.2): `/undo` single-step tool
          // rollback backed by the session backup store.
          undo: { undoStep: (sessionId) => backups.undoStep(sessionId) },
          ...input,
        }),
      renderDirectoryTrustPrompt,
      renderSessionPicker,
    },
    trust,
    restore: { restore: (sessionId, restoreOptions) => backups.restore(sessionId, restoreOptions) },
    evolution: {
      show: (showOptions) => evolution.audit(showOptions.namespace, showOptions.since),
      rollback: (rollbackOptions) =>
        evolution.rollback(rollbackOptions.namespace, rollbackOptions.to),
      health: async () => {
        const result = await evolution.health()
        return { valid: result.valid, detail: result.detail }
      },
    },
    memory,
    memoryRecall,
    memoryMaintenance,
    memoryTransfer,
    plugin: {
      async install(_source) {
        throw new PluginError(
          LEGACY_PLUGIN_UNAVAILABLE.code,
          `${LEGACY_PLUGIN_UNAVAILABLE.detail} Reopen requires ${LEGACY_PLUGIN_UNAVAILABLE.reopenCondition}.`,
        )
      },
      async uninstall(name) {
        assertLegacyPluginName(name)
        await pluginsReady
        await plugins.uninstall(name)
      },
      async list() {
        await pluginsReady
        return plugins.list()
      },
      async setEnabled(name, enabled) {
        assertLegacyPluginName(name)
        if (enabled)
          throw new PluginError(
            LEGACY_PLUGIN_UNAVAILABLE.code,
            `${LEGACY_PLUGIN_UNAVAILABLE.detail} Reopen requires ${LEGACY_PLUGIN_UNAVAILABLE.reopenCondition}.`,
          )
        await pluginsReady
        await plugins.setEnabled(name, enabled)
      },
      async availability() {
        return LEGACY_PLUGIN_UNAVAILABLE
      },
      async doctor(name) {
        assertLegacyPluginName(name)
        await pluginsReady
        const approvals = plugins.list()
        const state = Object.hasOwn(approvals, name) ? approvals[name] : undefined
        if (!state) throw new PluginError('plugin_not_installed', name)
        const diagnostic = await readContainedPluginDiagnostic(
          pluginRoot,
          name,
          state.version,
          options.identity.version,
        )
        return {
          name,
          version: diagnostic.version,
          permissions: diagnostic.permissions,
          compatibility: diagnostic.compatibility,
          availability: LEGACY_PLUGIN_UNAVAILABLE,
        }
      },
    },
    telemetry: {
      securityEvent: (name, payload) => telemetry.emit(name, 'security', payload),
      summary: () => telemetryStore.summary(),
      export: (target) => telemetryStore.export(target),
      clear: () => telemetryStore.clear(),
      health: () => telemetryStore.health(),
    },
    confirmation: {
      confirmDangerousNoSandbox: async (sentence) =>
        (await promptLine(`Type "${sentence}" to continue: `)) === sentence,
    },
    auth: {
      async health() {
        const section = await readAuthSection()
        if (section.skipAuth === true) {
          const keyIgnored =
            typeof section.anthropic_api_key === 'string' && section.anthropic_api_key !== ''
          return {
            configured: true,
            detail: `anthropic credential skipped by config (auth.skipAuth)${keyIgnored ? '; auth.anthropic_api_key is set but ignored while skipAuth=true' : ''}`,
          }
        }
        const configured = Boolean(await auth.getCredential('anthropic'))
        return {
          configured,
          detail: configured
            ? 'anthropic credential available'
            : 'anthropic credential unavailable',
        }
      },
      async login(input) {
        const section = await readAuthSection()
        // §8.4：skipAuth / config Layer 4 已覆盖时，交互登录是 no-op——
        // 不弹输入、不发 verify；显式 --api-key-stdin 仍可落盘
        if (input.credential === undefined) {
          if (section.skipAuth === true)
            return {
              detail: `${input.provider} authentication is skipped by config (auth.skipAuth=true); nothing to store`,
            }
          const configured = section[`${input.provider}_api_key`]
          if (typeof configured === 'string' && configured)
            return {
              detail: `${input.provider} credential already provided by config (auth.${input.provider}_api_key); login is unnecessary`,
            }
        }
        const credential = input.credential ?? (await promptSecret('Anthropic API key: ')).trim()
        if (!credential) throw new Error('Credential input was cancelled')
        const verifyBaseUrl = await readAnthropicBaseUrl()
        await auth.login(
          input.provider,
          credential,
          (value) => verifyAnthropicCredential(http, value, undefined, verifyBaseUrl),
          { flow: input.flow, dangerouslySkipVerify: input.dangerouslySkipVerify },
        )
        const skipNote =
          section.skipAuth === true
            ? ' (note: auth.skipAuth=true in config; the stored credential stays unused until it is removed)'
            : ''
        return {
          detail: `${input.provider} credential stored in encrypted credential store${skipNote}`,
        }
      },
      async logout(provider) {
        await auth.logout(provider)
        return { detail: `${provider} credential removed` }
      },
    },
    config: {
      /**
       * [env] 段（§8.3 / 附录 C）：会话启动时把用户级 config.toml 的显式环境变量
       * 写入 process.env——之后 spawn 的子进程（native worker / 插件宿主 / MCP
       * stdio）随之继承；沙箱内 Bash 走 env_clear 白名单模型，仅 [tools]
       * pass_through_env 列出的名字进入（值可来自这里写入的 process.env）。
       * 缺文件是 no-op；类型错按 C.1 传播 config_invalid（启动 fail）。
       */
      async applyEnv() {
        let config: Record<string, JsonValue>
        try {
          config = await loadTomlFile(join(home, 'config.toml'), {
            onWarning: (message) => logger.warn(message),
          })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
          throw error
        }
        const section = config.env
        if (!section || typeof section !== 'object' || Array.isArray(section)) return
        for (const [key, value] of Object.entries(section))
          if (typeof value === 'string') process.env[key] = value
      },
      async health(cwd) {
        try {
          const warnings: string[] = []
          for (const path of [join(home, 'config.toml'), join(cwd, '.apollo', 'config.toml')]) {
            try {
              await access(path)
              // r13-I4 §8.3：未知 key warn + 忽略；已知 key 类型错 → fail（file + key + 期望类型）
              await loadTomlFile(path, {
                onWarning: (message) => warnings.push(message),
              })
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
          }
          return warnings.length > 0
            ? { valid: true, detail: warnings.join('; ') }
            : { valid: true, detail: 'valid' }
        } catch (error) {
          return { valid: false, detail: error instanceof Error ? error.message : String(error) }
        }
      },
      async status(input) {
        return runtimeStatusData(home, options, input)
      },
      async updatePreference(id, value, input) {
        const data = await runtimeStatusData(home, options, input)
        const item = data.config.find((candidate) => candidate.id === id)
        if (!item) throw new Error(`Unknown configuration item: ${id}`)
        validateStatusConfigValue(item, value)
        const path = join(home, 'config.toml')
        let config: Record<string, JsonValue> = {}
        try {
          config = await parseTomlFile(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        const preferences = config.preferences
        const target =
          preferences && typeof preferences === 'object' && !Array.isArray(preferences)
            ? (preferences as Record<string, JsonValue>)
            : ((config.preferences = {}) as Record<string, JsonValue>)
        target[id] = value
        await mkdir(home, { recursive: true })
        const temporary = `${path}.${process.pid}.tmp`
        await writeFile(temporary, serializeConfig(config), { encoding: 'utf8', mode: 0o600 })
        await rename(temporary, path)
        return runtimeStatusData(home, options, input)
      },
    },
    native: {
      /** Tri-state availability snapshot (r13-P1): 'probing' until backfill. */
      available() {
        const availability = nativeProbes.available
        return {
          sandbox: availability.sandbox,
          search: availability.search,
          fs: availability.fs,
        }
      },
      /**
       * r13-P1 startup contract (spec 05-rust-sidecar.md §5.8): fires every
       * native probe (sandbox --probe + search/fs worker handshakes) in
       * parallel. The REPL never awaits them — `available.*` starts as
       * 'probing' and backfills asynchronously; side-effect waits are
       * budget-bounded instead.
       */
      startProbes() {
        nativeProbes.start()
      },
      async probe() {
        const info = await probeSandbox()
        const features = info.features as Record<string, unknown>
        const mechanism =
          typeof features.mechanism === 'string' ? features.mechanism : 'apollo-sandbox'
        const abi = typeof features.abi === 'string' ? features.abi : 'unknown'
        const disclosure = {
          tier: info.tier,
          mechanism,
          features: {
            filesystem: Boolean(features.filesystem ?? info.tier !== 'none'),
            network: Boolean(features.network),
          },
          degradationReasons: info.known_limitations,
        }
        await telemetry.emit('sandbox.probe', 'sandbox', {
          tier: disclosure.tier,
          mechanism: disclosure.mechanism,
          abi,
          version: options.identity.version,
          probedAt: new Date().toISOString(),
        })
        return disclosure
      },
      async health() {
        const [probe, search, fs] = await Promise.all([
          probeSandbox(),
          resolveBinary('search'),
          resolveBinary('fs'),
        ])
        return { sandbox: probe.tier !== 'none', search: search !== null, fs: fs !== null }
      },
    },
  }
}

async function runtimeStatusData(
  home: string,
  options: ProductionOptions,
  input: { cwd: string; sessionId?: string },
): Promise<StatusPanelData> {
  let config: Record<string, JsonValue> = {}
  try {
    config = await parseTomlFile(join(home, 'config.toml'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const preferences =
    config.preferences &&
    typeof config.preferences === 'object' &&
    !Array.isArray(config.preferences)
      ? (config.preferences as Record<string, JsonValue>)
      : {}
  const authSection =
    config.auth && typeof config.auth === 'object' && !Array.isArray(config.auth)
      ? (config.auth as Record<string, JsonValue>)
      : undefined
  const authMethod =
    authSection?.skipAuth === true ? 'skipped (auth.skipAuth)' : 'credential store (value hidden)'
  const providerSection =
    config.provider && typeof config.provider === 'object' && !Array.isArray(config.provider)
      ? (config.provider as Record<string, JsonValue>)
      : undefined
  const anthropicEntry =
    providerSection?.anthropic &&
    typeof providerSection.anthropic === 'object' &&
    !Array.isArray(providerSection.anthropic)
      ? (providerSection.anthropic as Record<string, JsonValue>)
      : undefined
  const providerModel = typeof anthropicEntry?.model === 'string' ? anthropicEntry.model : undefined
  const model =
    options.model ??
    (typeof preferences.model === 'string' ? preferences.model : undefined) ??
    providerModel ??
    'claude-sonnet-4-20250514'
  const editable: StatusConfigItem[] = [
    preference('language', 'Language', preferences.language ?? 'system', 'string'),
    preference('model', 'Model', model, 'string'),
    {
      ...preference(
        'reasoningEffort',
        'Reasoning Effort',
        preferences.reasoningEffort ?? 'medium',
        'enum',
      ),
      choices: ['low', 'medium', 'high'],
    },
    ...[
      ['autoCompact', 'Auto-compact'],
      ['notifications', 'Notifications'],
      ['promptSuggestions', 'Prompt suggestions'],
      ['showTokensCounter', 'Show tokens counter'],
      ['terminalProgressBar', 'Terminal progress bar'],
      ['autoMemory', 'Auto Memory'],
      ['typedMemory', 'Typed Memory'],
    ].map(([id, label]) => preference(id!, label!, preferences[id!] ?? false, 'boolean')),
    {
      ...preference('outputStyle', 'Output Style', preferences.outputStyle ?? 'default', 'enum'),
      choices: ['default', 'concise', 'explanatory'],
    },
    {
      ...preference('cleanupPeriod', 'Cleanup Period', preferences.cleanupPeriod ?? 30, 'number'),
      min: 1,
      max: 365,
    },
  ]
  const readonly = (id: string, label: string, value: string): StatusConfigItem => ({
    id,
    label,
    value,
    editable: false,
    readonlyReason: 'Security state cannot be changed here',
  })
  return {
    settings: [
      { label: 'Language', value: String(preferences.language ?? 'system') },
      { label: 'Model', value: model },
      { label: 'Output Style', value: String(preferences.outputStyle ?? 'default') },
      { label: 'Settings sources', value: 'defaults, user' },
    ],
    status: [
      { label: 'Version', value: options.identity.version },
      { label: 'Session ID', value: input.sessionId ?? 'not available' },
      { label: 'cwd', value: input.cwd },
      { label: 'Auth method', value: authMethod },
      { label: 'Model', value: model },
      { label: 'Lite model', value: 'not available' },
      { label: 'Reasoning model', value: 'not available' },
      { label: 'Memory', value: preferences.autoMemory === true ? 'auto' : 'off' },
      { label: 'Settings sources', value: 'defaults, user' },
      { label: 'Workspace', value: input.cwd },
      { label: 'MCP servers', value: 'not available' },
      { label: 'Skills', value: 'not available' },
      { label: 'Plugins', value: 'not available' },
      { label: 'Permissions', value: 'ask' },
      { label: 'Sandbox', value: 'resolved at session startup' },
      { label: 'Network', value: 'resolved at session startup' },
      { label: 'Filesystem', value: 'resolved at session startup' },
    ],
    config: [
      ...editable,
      readonly('authMethod', 'Auth method', authMethod),
      readonly('sessionId', 'Session ID', input.sessionId ?? 'not available'),
      readonly('enterprisePolicies', 'Enterprise managed policies', 'not available'),
      readonly('trustAllDirectory', 'Trust all Directory', 'read-only'),
      readonly('mcpPermissions', 'MCP Server permissions', 'read-only'),
      readonly('filesystemPermissions', 'Filesystem permissions', 'read-only'),
      readonly('externalAccounts', 'External account connections', 'not available'),
    ],
  }
}

function preference(
  id: string,
  label: string,
  value: JsonValue,
  kind: Exclude<StatusConfigItem['kind'], undefined>,
): StatusConfigItem {
  return { id, label, value: value as StatusValue, editable: true, kind }
}

function serializeConfig(config: Record<string, JsonValue>) {
  const lines: string[] = []
  for (const [section, raw] of Object.entries(config)) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      lines.push(`[${section}]`)
      for (const [key, value] of Object.entries(raw))
        lines.push(`${key} = ${JSON.stringify(value)}`)
      lines.push('')
    } else lines.push(`${section} = ${JSON.stringify(raw)}`)
  }
  return `${lines.join('\n').trim()}\n`
}
