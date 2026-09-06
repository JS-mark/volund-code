/**
 * StatusController 域（§11.3.14 / §22.7.1 / Web 计划 P1-04a）：/status 视图模型组装。
 *
 * 从 apps/cli/src/runtime.ts 迁入，行为等价。`volund status --json` 与未来
 * Web `/api/v1/status` 必须同源——parity 由共享这里的实现保证（P4-07）。
 */
import { join } from 'node:path'

import { parseTomlFile } from '@volund/config'
import type { SessionState } from '@volund/core'
import type { PermissionSessionMode } from '@volund/permission'
import { sanitize } from '@volund/shared'
import type { JsonValue } from '@volund/shared'

import { SESSION_ID_PATTERN } from './session-controller'
import { buildStatsData, buildUsageData, scanSessionFile, scanSessionsDir } from './session-stats'
import type {
  PluginStatusTab,
  StatusConfigItem,
  StatusPanelData,
  StatusSetting,
  StatusSource,
  StatusValue,
  StatusViewModel,
} from './status-view'
import type { SandboxDisclosure } from './status-view'

/** 插件 /status 页签贡献的最小结构面（与 plugin-runtime StatusTabContribution 同构）。 */
export interface StatusPluginTabLike {
  readonly id: string
  readonly label: string
  render(): Promise<unknown>
}

/** runtimeStatusData 需要的最小产品身份（避免反向依赖 apps/cli 的 AppIdentity）。 */
export interface StatusRuntimeOptions {
  readonly identity: { readonly version: string }
  readonly model?: string | undefined
}

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
  /** §4.4 三档会话模式（--yolo 旁路时显示 full）。 */
  permissionMode?: PermissionSessionMode
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
              value: {
                mode: input.dangerousPermissions ? 'full' : (input.permissionMode ?? 'ask'),
                source: input.dangerousPermissions ? 'flag' : 'default',
              },
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
  /** §4.4 当前生效的三档模式（活动会话优先，否则该会话冻结快照/默认 ask）。 */
  permissionMode(state: SessionState): PermissionSessionMode
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
      permissionMode: options.permissionMode(state),
      configSources: userConfigAvailable ? ['default', 'user'] : ['default'],
    })
  }
}

export async function runtimeStatusData(
  home: string,
  options: StatusRuntimeOptions,
  input: { cwd: string; sessionId?: string; includeStats?: boolean },
  localPluginHub?: {
    tabs: readonly StatusPluginTabLike[]
    onUsage?: (usage: StatusPanelData['usage']) => void
  },
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
  // Usage（当前会话）与 Stats（全历史）从 sessions 事件日志聚合；
  // 扫描失败只意味着页签显示不可用，绝不让 /status 本身失败。
  const sessionsDir = join(home, 'sessions')
  let usage: StatusPanelData['usage']
  let sessionScan: Awaited<ReturnType<typeof scanSessionFile>> | undefined
  if (input.sessionId && SESSION_ID_PATTERN.test(input.sessionId)) {
    try {
      sessionScan = await scanSessionFile(
        join(sessionsDir, `${input.sessionId}.jsonl`),
        input.sessionId,
      )
      usage = buildUsageData(sessionScan, Date.now())
    } catch {
      usage = undefined
    }
  }
  let stats: StatusPanelData['stats']
  if (input.includeStats) {
    try {
      stats = buildStatsData(await scanSessionsDir(sessionsDir), Date.now())
    } catch {
      stats = undefined
    }
  }
  // PLUGIN-STATUS-UI-r1：插件页签的 render 在此经桥回调取值（面板打开 / 刷新时）。
  // render 失败 → error 占位行（§S3.4 降级语义）；返回 null → 本次不渲染。
  let pluginTabs: StatusPanelData['pluginTabs']
  if (localPluginHub && localPluginHub.tabs.length > 0) {
    localPluginHub.onUsage?.(usage)
    const rendered = await Promise.all(
      localPluginHub.tabs.map(async (tab) => {
        try {
          const body = await tab.render()
          if (!body || typeof body !== 'object') return null
          return {
            schemaVersion: 1 as const,
            id: tab.id,
            label: tab.label,
            body: body as PluginStatusTab['body'],
          }
        } catch {
          return { id: tab.id, label: tab.label, error: true as const }
        }
      }),
    )
    pluginTabs = rendered.filter((tab): tab is NonNullable<typeof tab> => tab !== null)
  }
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
    ...(usage ? { usage } : {}),
    ...(stats ? { stats } : {}),
    ...(pluginTabs ? { pluginTabs } : {}),
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
