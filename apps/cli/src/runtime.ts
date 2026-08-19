import { AsyncLocalStorage } from 'node:async_hooks'
import {
  access,
  appendFile,
  chmod,
  glob,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
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
  wrapUntrusted,
} from '@apollo-code/core'
import type { PromptComposer, RunnerToolPort, SessionState } from '@apollo-code/core'
import { execSandbox, nativeProbes, probeSandbox, resolveBinary } from '@apollo-code/native-bridge'
import { PermissionManager } from '@apollo-code/permission'
import type { PermissionDecision, PermissionRequest } from '@apollo-code/permission'
import {
  BridgeRuntime,
  createToolHookDispatcher,
  PluginManager,
  PluginRuntime,
} from '@apollo-code/plugin-runtime'
import type { HookPipelineSignal, PluginRuntimeOptions } from '@apollo-code/plugin-runtime'
import type {
  CommandSpec,
  PluginManifest,
  PluginMemoryHookPayload,
  PluginMemoryScope,
  ToolSpec,
} from '@apollo-code/plugin-sdk'
import { AnthropicClient, verifyAnthropicCredential } from '@apollo-code/provider-anthropic'
import type { HttpPort, HttpRequest, HttpResponse } from '@apollo-code/provider-anthropic'
import { InMemoryProviderRegistry } from '@apollo-code/provider-kit'
import { parseRoleRouterConfig, RoleRouter, SingleProviderRouter } from '@apollo-code/router'
import type { RouterPolicy } from '@apollo-code/router'
import { sanitize, type JsonValue, type Logger } from '@apollo-code/shared'
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
import type {
  MemoryMutationHookContext,
  MemoryMutationHooks,
  MemoryRecallService,
  MemoryRecord,
  MemoryRecordScope,
  MemoryService,
} from '@apollo-code/storage'
import { SubagentDispatcher } from '@apollo-code/subagent'
import {
  LocalTelemetrySink,
  Telemetry,
  TelemetryLogger,
  TelemetryStore,
} from '@apollo-code/telemetry'
import { ToolRegistry } from '@apollo-code/tool-kit'
import type { ToolContext } from '@apollo-code/tool-kit'
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
        const text = messageText(message.content)
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

function messageText(content: SessionState['messages'][number]['content']): string {
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join(' ')
    .replace(/\s+/g, ' ')
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

export class NodeHttpPort implements HttpPort {
  async request(input: HttpRequest): Promise<HttpResponse> {
    const url = new URL(input.url)
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
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
}

async function promptLine(question: string): Promise<string> {
  return (await promptLineMaybe(question)) ?? ''
}
function isInteractiveTerminal(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY)
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

function buildPermissionDisplay(
  raw: Pick<PermissionRequest, 'spec' | 'toolName'>,
  sanitized: Pick<InteractivePermissionRequest, 'spec' | 'toolName'>,
): InteractivePermissionRequest['display'] {
  const rawSpec = formatPermissionValueForDisplay(raw.spec)
  const sanitizedSpec = formatPermissionValueForDisplay(sanitized.spec)
  const rawToolName = formatPermissionTextForDisplay(raw.toolName)
  const sanitizedToolName = formatPermissionTextForDisplay(sanitized.toolName)
  if (
    !rawSpec.approvable ||
    !sanitizedSpec.approvable ||
    !rawToolName.approvable ||
    !sanitizedToolName.approvable
  )
    return {
      approvable: false,
      spec: '[permission details unavailable - deny only]',
      toolName: sanitizedToolName.text,
    }
  if (rawSpec.text !== sanitizedSpec.text || rawToolName.text !== sanitizedToolName.text)
    return {
      approvable: false,
      spec: '[sensitive permission details hidden - deny only]',
      toolName:
        rawToolName.text === sanitizedToolName.text
          ? sanitizedToolName.text
          : '[sensitive tool name hidden]',
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
  const sanitizedSpec = sanitize(input.request.spec as JsonValue)
  const sanitizedToolName = sanitize(input.request.toolName)
  const uiRequest: InteractivePermissionRequest = {
    display: buildPermissionDisplay(input.request, {
      spec: sanitizedSpec,
      toolName: sanitizedToolName,
    }),
    id,
    attempt: input.request.attempt,
    input: sanitize(input.request.input as JsonValue),
    spec: sanitizedSpec,
    toolName: sanitizedToolName,
  }
  // 附录 D.2 tool.permission_asked：{toolUseId, tool, spec}——toolUseId 优先用真实
  // tool_use id（ToolExecutor 透传），非模型路径回退本次弹窗请求 id。
  await input.events.emit({
    type: 'tool.permission_asked',
    version: input.version,
    sessionId: input.request.session.id,
    payload: {
      toolUseId: input.request.toolUseId ?? id,
      tool: input.request.toolName,
      spec: sanitizedSpec,
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
  if (!uiRequest.display.approvable) return { kind: 'deny' }
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
  /** Test seam for the native plugin transport; production uses startPluginHost. */
  pluginHostStart?: PluginRuntimeOptions['start']
  /** Diagnostics hook fired only after a contribution reaches its production registry. */
  onPluginContribution?: (
    value: Readonly<{
      kind: 'tool' | 'command'
      name: string
      plugin: string
    }>,
  ) => void
  pluginApproval?: (manifest: PluginManifest, expanded: boolean) => Promise<boolean>
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

class ProductionMemoryPluginHooks implements MemoryMutationHooks {
  readonly #active = new AsyncLocalStorage<MemoryMutationHookContext>()
  #auditQueue = Promise.resolve()
  #dispatchQueue = Promise.resolve()
  #dispatchContext: MemoryMutationHookContext | undefined

  constructor(
    readonly bridge: BridgeRuntime,
    readonly ready: () => Promise<void>,
    readonly auditPath: string,
  ) {}

  current(): MemoryMutationHookContext | undefined {
    return this.#dispatchContext ?? this.#active.getStore()
  }

  async preWrite(context: MemoryMutationHookContext): Promise<void> {
    if (this.#active.getStore())
      throw new MemoryError(
        'memory_hook_reentrant',
        'Memory hooks cannot perform recursive memory writes',
      )
    try {
      await this.ready()
      await this.#audit('attempt', 'memory.preWrite', context)
      await this.#dispatch(context, async () => {
        const veto = await this.bridge.runMemoryHooks(
          'memory.preWrite',
          this.#payload(context, true),
        )
        if (!veto) {
          await this.#audit('accepted', 'memory.preWrite', context)
          return
        }
        const reason = this.#safeReason(veto.result.reason)
        await this.#audit('veto', 'memory.preWrite', context, {
          plugin: veto.plugin,
          reasonProvided: Boolean(reason),
        })
        throw new MemoryError('memory_hook_veto', reason || `Memory write vetoed by ${veto.plugin}`)
      })
    } catch (error) {
      if (error instanceof MemoryError) throw error
      await this.#audit('error', 'memory.preWrite', context, {
        code:
          error && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : 'memory_hook_failed',
      }).catch(() => undefined)
      throw new MemoryError('memory_hook_failed', 'Memory policy hook failed closed', {
        cause: error,
      })
    }
  }

  async postWrite(context: MemoryMutationHookContext, _record: MemoryRecord): Promise<void> {
    await this.#observe('memory.postWrite', context)
  }

  async deleted(context: MemoryMutationHookContext, _record: MemoryRecord): Promise<void> {
    await this.#observe('memory.deleted', context)
  }

  async #observe(
    event: 'memory.postWrite' | 'memory.deleted',
    context: MemoryMutationHookContext,
  ): Promise<void> {
    try {
      await this.ready()
      await this.#dispatch(context, async () => {
        await this.bridge.runMemoryHooks(event, this.#payload(context, false))
      })
      await this.#audit('observed', event, context)
    } catch (error) {
      await this.#audit('observer_error', event, context, {
        code:
          error && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : 'memory_hook_failed',
      }).catch(() => undefined)
    }
  }

  #payload(context: MemoryMutationHookContext, includeContent: boolean): PluginMemoryHookPayload {
    return {
      schemaVersion: 1,
      operation: context.operation,
      phase: context.phase,
      scope: context.scope.kind,
      id: context.id,
      ...(includeContent && context.content !== undefined ? { content: context.content } : {}),
    }
  }

  #safeReason(value: string | undefined): string {
    return value ? String(sanitize(value)).replace(/\s+/g, ' ').trim().slice(0, 240) : ''
  }

  async #dispatch<T>(context: MemoryMutationHookContext, task: () => Promise<T>): Promise<T> {
    const queued = this.#dispatchQueue.then(() =>
      this.#active.run(context, async () => {
        this.#dispatchContext = context
        try {
          return await task()
        } finally {
          this.#dispatchContext = undefined
        }
      }),
    )
    this.#dispatchQueue = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }

  async #audit(
    result: string,
    event: 'memory.preWrite' | 'memory.postWrite' | 'memory.deleted',
    context: MemoryMutationHookContext,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    const line = `${JSON.stringify({
      schemaVersion: 1,
      at: new Date().toISOString(),
      event,
      result,
      operation: context.operation,
      phase: context.phase,
      scope: context.scope.kind,
      id: sanitize(context.id),
      ...extra,
    })}\n`
    const write = this.#auditQueue.then(async () => {
      await mkdir(dirname(this.auditPath), { recursive: true, mode: 0o700 })
      await appendFile(this.auditPath, line, { encoding: 'utf8', mode: 0o600 })
      await chmod(this.auditPath, 0o600)
    })
    this.#auditQueue = write.catch(() => undefined)
    return write
  }
}

function memoryScopeForPolicyHook(
  requested: PluginMemoryScope,
  context: MemoryMutationHookContext | undefined,
): MemoryRecordScope {
  if (!context)
    throw new MemoryError(
      'memory_scope_denied',
      'Policy hook memory access requires an active memory event',
    )
  if (requested === 'workspace')
    return { kind: 'workspace', workspaceId: context.scope.workspaceId }
  if (requested === 'project' && context.scope.kind !== 'workspace')
    return {
      kind: 'project',
      workspaceId: context.scope.workspaceId,
      projectId: context.scope.projectId,
    }
  if (requested === 'session' && context.scope.kind === 'session') return context.scope
  throw new MemoryError('memory_scope_denied', `Policy hook cannot widen to ${requested} scope`)
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
  const plugins = new PluginManager(
    pluginRoot,
    options.identity.version,
    async (manifest, expanded) => {
      if (options.pluginApproval) return options.pluginApproval(manifest, expanded)
      const permissions = manifest.permissions.apollo.join(', ') || 'none'
      const answer = await promptLine(
        `${expanded ? 'Expanded' : 'Requested'} plugin permissions for ${manifest.name}: ${permissions}\nApprove? [y/N] `,
      )
      return answer.trim().toLowerCase() === 'y'
    },
  )
  const pluginsReady = plugins.init()
  const pluginRuntimes = new Set<PluginRuntime>()
  const memoryPolicyFailures = new Map<string, Error>()
  const policyStorage = new Map<string, unknown>()
  let memory: MemoryService
  let memoryRecall: DefaultMemoryRecallService
  let memoryTransfer: MemoryTransferService
  let memoryHooks: ProductionMemoryPluginHooks
  const memoryPolicyBridge = new BridgeRuntime(
    {
      session: {
        id: 'memory-policy',
        cwd: process.cwd(),
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      register: () => ({ dispose() {} }),
      fs: {
        readFile: (path, encoding) => readFile(path, encoding === 'binary' ? undefined : 'utf8'),
        writeFile,
        exists: async (path) =>
          access(path).then(
            () => true,
            () => false,
          ),
        glob: async (pattern, cwd) => Array.fromAsync(glob(pattern, { cwd })),
        stat: async (path) => {
          const value = await stat(path)
          return {
            size: value.size,
            type: value.isFile() ? 'file' : value.isDirectory() ? 'directory' : 'other',
            modifiedAt: value.mtimeMs,
          }
        },
      },
      exec: async (command, rawOptions, signal) => {
        const execOptions = (rawOptions ?? {}) as { cwd?: string; timeoutMs?: number }
        const result = await execSandbox(
          {
            command,
            cwd: execOptions.cwd ?? process.cwd(),
            ...(execOptions.timeoutMs === undefined ? {} : { timeout_ms: execOptions.timeoutMs }),
            permissions: {
              fs: { read: [process.cwd()], write: [process.cwd()] },
              net: false,
              env: { read: [] },
            },
          },
          signal,
        )
        return { stdout: result.stdout, stderr: result.stderr, code: result.exit_code }
      },
      fetch: async () => {
        throw new Error('plugin_http_not_connected')
      },
      ui: () => {
        throw new Error('plugin_ui_not_connected')
      },
      storage: async (plugin, operation, key, value) => {
        const isolated = `${plugin}:${key}`
        if (operation === 'set') policyStorage.set(isolated, value)
        if (operation === 'delete') policyStorage.delete(isolated)
        return policyStorage.get(isolated)
      },
      memory: async (plugin, operation, rawParams) => {
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
        const scope = memoryScopeForPolicyHook(params.scope, memoryHooks.current())
        if (operation === 'create' || operation === 'update' || operation === 'delete')
          throw new MemoryError(
            'memory_hook_reentrant',
            'Memory hooks cannot perform recursive memory writes',
          )
        if (operation === 'get') return (await memory.get(scope, String(params.id))) ?? null
        if (operation === 'list') return memory.list(scope, params.options)
        if (operation === 'search')
          return memoryRecall.recall(scope, String(params.query ?? ''), params.options)
        return memoryTransfer.export([scope])
      },
      config: () => undefined,
      log: (level, message) => {
        if (level === 'error') logger.error(message)
        else if (level === 'warn') logger.warn(message)
        else if (level === 'debug') logger.debug(message)
        else logger.info(message)
      },
    },
    { timeoutMs: 10_000 },
  )
  const memoryPolicyRuntime = new PluginRuntime(plugins, memoryPolicyBridge, {
    dataRoot: join(home, 'plugin-data', 'memory-policy'),
    ...(options.pluginHostStart ? { start: options.pluginHostStart } : {}),
  })
  const usesMemoryPolicyHooks = async (name: string) => {
    const manifest = await plugins.inspect(join(pluginRoot, name))
    return (
      manifest.permissions.apollo.includes('hooks.on') &&
      Boolean(manifest.permissions.memory?.read?.length)
    )
  }
  let memoryPolicyStarted: Promise<void> | undefined
  const startMemoryPolicy = () =>
    (memoryPolicyStarted ??= pluginsReady.then(async () => {
      for (const [name, approval] of Object.entries(plugins.list())) {
        if (!approval.enabled || !(await usesMemoryPolicyHooks(name))) continue
        try {
          await memoryPolicyRuntime.load(name)
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error))
          memoryPolicyFailures.set(name, failure)
          logger.warn(`Memory policy plugin activation failed: ${name}`)
        }
      }
    }))
  const ensureMemoryPolicy = async () => {
    await startMemoryPolicy()
    const failure = memoryPolicyFailures.entries().next().value as [string, Error] | undefined
    if (failure)
      throw new Error(`Memory policy plugin is unavailable: ${failure[0]}`, {
        cause: failure[1],
      })
  }
  memoryHooks = new ProductionMemoryPluginHooks(
    memoryPolicyBridge,
    ensureMemoryPolicy,
    join(home, 'memory', 'hook-audit.jsonl'),
  )
  memory = new IndexingMemoryService(
    new DefaultMemoryService(memoryRepository),
    memoryRepository,
    memoryIndex,
    memoryHooks,
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
  const auth = new AuthManager({ encrypted, env: process.env, telemetry })
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
    let evolutionEnabled = true
    let userConfig: Record<string, JsonValue> = {}
    try {
      // r13-I4 §8.3：未知 key warn + 忽略（key 全名 + 文件）；类型错的 fail 面在 config.health
      userConfig = await loadTomlFile(join(home, 'config.toml'), {
        onWarning: (message) => logger.warn(message),
      })
      const section = userConfig.evolution
      if (section && typeof section === 'object' && !Array.isArray(section))
        evolutionEnabled = section.enabled !== false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        logger.warn(
          error instanceof Error && error.message
            ? error.message
            : 'Unable to read evolution config',
        )
    }
    const tuned = await new EvolutionEngine(evolution, { enabled: evolutionEnabled }).values()
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
          const value = await auth.getCredential('anthropic')
          if (!value) throw new Error('Anthropic credential unavailable')
          return value
        },
      },
      http,
      attachments,
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
      options.model ?? 'claude-sonnet-4-20250514',
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
    const registry = new ToolRegistry()
    for (const tool of builtinTools({
      backups,
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
    const native = {
      async execute(command: string, args: string[], signal: AbortSignal) {
        const result = await execSandbox(
          {
            command: [command, ...args].join(' '),
            cwd: runner.state.cwd,
            permissions: {
              fs: { read: [runner.state.cwd], write: [runner.state.cwd] },
              net: false,
              env: { read: [] },
            },
          },
          signal,
        )
        for (const reason of result.sandbox_violations) {
          await telemetry.violation({
            mechanism: 'apollo-sandbox',
            tier: result.sandbox_tier,
            operation: 'sandbox-exec',
            decision: 'deny',
            reason,
          })
        }
        return result.stdout
      },
    }
    // REM-52 (spec 02-agent-loop.md §2.6, r13-I10): pre/postToolUse hooks dispatch from
    // the tool invoke chain. The session bridge below is assigned after the executor is
    // constructed (its host eagerly reads runner state); until then the lazy dispatcher
    // reports "no hooks" so tool execution degrades gracefully during startup.
    let sessionHooks: BridgeRuntime | undefined
    const reportHookSignal = (signal: HookPipelineSignal) => {
      if (signal.kind === 'builtin_hook_timeout' || signal.kind === 'builtin_hook_error') {
        void events
          .emit({
            type: 'error.raised',
            version: state.version,
            sessionId: state.id,
            ...(runner?.state.activeTurn ? { turnId: runner.state.activeTurn } : {}),
            payload: { code: signal.code, context: { hook: signal.hook, event: signal.event } },
          })
          .catch(() => undefined)
        return
      }
      if (signal.kind === 'hook_skipped') {
        logger.warn(
          `Hook skipped (${signal.domain} ${signal.hook} on ${signal.event}, ${signal.cause}): ${signal.message}`,
        )
        void telemetry
          .emit('hook.skipped', 'plugin-runtime', {
            domain: signal.domain,
            hook: signal.hook,
            event: signal.event,
            cause: signal.cause,
          })
          .catch(() => undefined)
        return
      }
      logger.warn(
        `Hook payload truncated for ${signal.hook} on ${signal.event}: ${signal.truncatedBytes} bytes over ${signal.limitBytes}`,
      )
      void telemetry
        .emit('hook.payload_truncated', 'plugin-runtime', {
          hook: signal.hook,
          event: signal.event,
          limitBytes: signal.limitBytes,
          truncatedBytes: signal.truncatedBytes,
        })
        .catch(() => undefined)
    }
    const executor = permissionChain.bindExecutor(
      (signal) => ({
        abortSignal: signal,
        session: { id: state.id, cwd: state.cwd, turnId: runner.state.activeTurn ?? '' },
        native,
        logger,
        ui: { requestInput: promptLine },
      }),
      createToolHookDispatcher(() => sessionHooks, { report: reportHookSignal }),
    )
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
        }
      },
    }
    runner = new Runner(state, router, composer, tools, events, {}, contextPolicy)
    await pluginsReady
    const pluginStorage = new Map<string, unknown>()
    const sessionBridge = new BridgeRuntime({
      get session() {
        return {
          id: runner.state.id,
          cwd: runner.state.cwd,
          messages: runner.state.messages,
          usage: {
            inputTokens: runner.state.cumulativeUsage.input,
            outputTokens: runner.state.cumulativeUsage.output,
            cost: runner.state.cumulativeUsage.costUSD,
          },
        }
      },
      register(kind, value, plugin) {
        if (kind === 'command') {
          // Only the top-level interactive session contributes commands. Child and
          // non-interactive runners still activate safely without acquiring TUI state.
          if (runner.state.lineage.depth !== 0) return { dispose() {} }
          const spec = value as CommandSpec
          const dispose = slashCommands.register(
            {
              name: spec.name,
              description: spec.description ?? `Run ${spec.name}`,
              run: ({ args }) => spec.handler(args),
            },
            { kind: 'plugin', plugin },
          )
          options.onPluginContribution?.({ kind: 'command', name: spec.name, plugin })
          return { dispose }
        }
        if (kind !== 'tool') throw new Error(`plugin_${kind}_registration_not_supported`)
        const spec = value as ToolSpec
        const dispose = registry.register(
          {
            name: spec.name,
            description: spec.description,
            inputSchema: spec.inputSchema as never,
            permissionSpec: () => ({}),
            async invoke(input, context) {
              const result = await spec.handler(input, {
                session: context.session,
                aborted: context.abortSignal.aborted,
              })
              const content =
                result &&
                typeof result === 'object' &&
                Array.isArray((result as { content?: unknown }).content)
                  ? (result as { content: Array<{ type: 'text'; text: string }> }).content
                  : [
                      {
                        type: 'text' as const,
                        text: typeof result === 'string' ? result : JSON.stringify(result),
                      },
                    ]
              return {
                content: wrapUntrusted(content, `plugin:${plugin}:${spec.name}`),
                meta: { durationMs: 0 },
              }
            },
          },
          { kind: 'plugin', plugin },
        )
        options.onPluginContribution?.({ kind: 'tool', name: spec.name, plugin })
        return { dispose }
      },
      fs: {
        readFile: (path, encoding) => readFile(path, encoding === 'binary' ? undefined : 'utf8'),
        writeFile,
        exists: async (path) =>
          access(path).then(
            () => true,
            () => false,
          ),
        glob: async (pattern, cwd) => Array.fromAsync(glob(pattern, { cwd })),
        stat: async (path) => {
          const value = await stat(path)
          return {
            size: value.size,
            type: value.isFile() ? 'file' : value.isDirectory() ? 'directory' : 'other',
            modifiedAt: value.mtimeMs,
          }
        },
      },
      exec: async (command, rawOptions, signal) => {
        const execOptions = (rawOptions ?? {}) as { cwd?: string; timeoutMs?: number }
        const result = await execSandbox(
          {
            command,
            cwd: execOptions.cwd ?? runner.state.cwd,
            ...(execOptions.timeoutMs === undefined ? {} : { timeout_ms: execOptions.timeoutMs }),
            permissions: {
              fs: { read: [runner.state.cwd], write: [runner.state.cwd] },
              net: false,
              env: { read: [] },
            },
          },
          signal,
        )
        return { stdout: result.stdout, stderr: result.stderr, code: result.exit_code }
      },
      fetch: async () => {
        throw new Error('plugin_http_not_connected')
      },
      ui: () => {
        throw new Error('plugin_ui_not_connected')
      },
      storage: async (plugin, operation, key, value) => {
        const isolated = `${plugin}:${key}`
        if (operation === 'set') pluginStorage.set(isolated, value)
        if (operation === 'delete') pluginStorage.delete(isolated)
        return pluginStorage.get(isolated)
      },
      memory: createPluginMemoryHost({
        home,
        cwd: runner.state.cwd,
        sessionId: runner.state.id,
        memory,
        memoryRecall,
        memoryTransfer,
      }),
      config: () => undefined,
      log: (level, message) => {
        if (level === 'error') logger.error(message)
        else if (level === 'warn') logger.warn(message)
        else if (level === 'debug') logger.debug(message)
        else logger.info(message)
      },
    })
    sessionHooks = sessionBridge
    const pluginRuntime = new PluginRuntime(plugins, sessionBridge, {
      dataRoot: join(home, 'plugin-data'),
      ...(options.pluginHostStart ? { start: options.pluginHostStart } : {}),
    })
    for (const failure of await pluginRuntime.loadEnabled())
      logger.warn(`Plugin activation failed: ${failure.name}`)
    pluginRuntimes.add(pluginRuntime)
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
      await Promise.all([...pluginRuntimes].map((runtime) => runtime.dispose()))
      pluginRuntimes.clear()
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
    },
    memory,
    memoryRecall,
    memoryMaintenance,
    memoryTransfer,
    plugin: {
      async install(source) {
        await startMemoryPolicy()
        const manifest = await plugins.install(source)
        if (
          manifest.permissions.apollo.includes('hooks.on') &&
          manifest.permissions.memory?.read?.length
        ) {
          try {
            await memoryPolicyRuntime.load(manifest.name)
            memoryPolicyFailures.delete(manifest.name)
          } catch (error) {
            memoryPolicyFailures.set(
              manifest.name,
              error instanceof Error ? error : new Error(String(error)),
            )
            throw error
          }
        }
        await Promise.all([...pluginRuntimes].map((runtime) => runtime.load(manifest.name)))
        return manifest
      },
      async uninstall(name) {
        await startMemoryPolicy()
        await Promise.all([
          memoryPolicyRuntime.deactivate(name),
          ...[...pluginRuntimes].map((runtime) => runtime.deactivate(name)),
        ])
        memoryPolicyFailures.delete(name)
        await plugins.uninstall(name)
      },
      async list() {
        await pluginsReady
        return plugins.list()
      },
      async setEnabled(name, enabled) {
        await startMemoryPolicy()
        await plugins.setEnabled(name, enabled)
        if (enabled) {
          if (await usesMemoryPolicyHooks(name)) {
            try {
              await memoryPolicyRuntime.load(name)
              memoryPolicyFailures.delete(name)
            } catch (error) {
              memoryPolicyFailures.set(
                name,
                error instanceof Error ? error : new Error(String(error)),
              )
              throw error
            }
          }
          await Promise.all([...pluginRuntimes].map((runtime) => runtime.load(name)))
        } else {
          await Promise.all([
            memoryPolicyRuntime.deactivate(name),
            ...[...pluginRuntimes].map((runtime) => runtime.deactivate(name)),
          ])
          memoryPolicyFailures.delete(name)
        }
      },
      async doctor(name) {
        await pluginsReady
        const state = plugins.list()[name]
        if (!state) throw new Error(`plugin_not_installed: ${name}`)
        const manifest = await plugins.inspect(join(pluginRoot, name))
        return {
          name: manifest.name,
          version: manifest.version,
          permissions: manifest.permissions.apollo,
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
        const configured = Boolean(await auth.getCredential('anthropic'))
        return {
          configured,
          detail: configured
            ? 'anthropic credential available'
            : 'anthropic credential unavailable',
        }
      },
      async login(input) {
        const credential = input.credential ?? (await promptSecret('Anthropic API key: ')).trim()
        if (!credential) throw new Error('Credential input was cancelled')
        await auth.login(
          input.provider,
          credential,
          (value) => verifyAnthropicCredential(http, value),
          { flow: input.flow, dangerouslySkipVerify: input.dangerouslySkipVerify },
        )
        return { detail: `${input.provider} credential stored in encrypted credential store` }
      },
      async logout(provider) {
        await auth.logout(provider)
        return { detail: `${provider} credential removed` }
      },
    },
    config: {
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
  const model =
    typeof preferences.model === 'string'
      ? preferences.model
      : (options.model ?? 'claude-sonnet-4-20250514')
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
      { label: 'Auth method', value: 'credential store (value hidden)' },
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
      readonly('authMethod', 'Auth method', 'credential store (value hidden)'),
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
