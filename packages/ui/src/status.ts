import type { WelcomePanelData } from './welcome'

export type StatusTabId = 'settings' | 'status' | 'config' | 'usage' | 'stats'
export type StatusValue = boolean | number | string
export type StatusConfigKind = 'boolean' | 'enum' | 'number' | 'string'

export interface StatusConfigItem {
  id: string
  label: string
  value: StatusValue
  editable: boolean
  kind?: StatusConfigKind
  choices?: readonly string[]
  min?: number
  max?: number
  readonlyReason?: string
}

/** /status → Usage 页签：当前会话的实时用量（由 CLI 从会话事件日志聚合）。 */
export interface StatusUsageData {
  costUSD: number
  apiDurationMs: number
  wallDurationMs: number
  linesAdded: number
  linesRemoved: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

export type StatsRangeId = 'all' | '7d' | '30d'

export const STATS_RANGES: readonly { id: StatsRangeId; label: string }[] = [
  { id: 'all', label: 'All time' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
]

export interface StatsModelShare {
  model: string
  tokens: number
  /** 0..1，占该 range 内全部模型 token 的比例。 */
  share: number
}

export interface StatsOverview {
  totalTokens: number
  sessions: number
  activeDays: number
  /** range 覆盖的天数（all = 首个活跃日到今天，含今天）。 */
  rangeDays: number
  favoriteModel?: string
  /** 预格式化（'Mar 3'）；range 内无活跃日时缺省。 */
  mostActiveDay?: string
  longestSessionMs: number
  longestStreakDays: number
  currentStreakDays: number
  models: readonly StatsModelShare[]
}

/** /status → Stats 页签：跨会话历史统计（CLI 从 sessions 目录挖掘）。 */
export interface StatusStatsData {
  /**
   * GitHub 风格日粒度活跃度：start 是周日（YYYY-MM-DD，本地时区），days[i]
   * 是 start+i 天的事件计数，覆盖到今天的整周。
   */
  heatmap: { start: string; days: readonly number[] }
  ranges: Record<StatsRangeId, StatsOverview>
}

/**
 * PLUGIN-STATUS-UI-r1 §S3.2：插件贡献页签的声明式体例。纯数据契约——
 * 描述符必须 JSON 可序列化，渲染权永远在 K0（插件自渲染是永久 non-goal）。
 */
export type PluginTabBody =
  | {
      kind: 'rows'
      sections: readonly {
        title?: string
        rows: readonly (readonly [string, string | number | boolean])[]
      }[]
    }
  | { kind: 'heatmap'; heatmap: { start: string; days: readonly number[] }; legend?: string }
  | { kind: 'table'; columns: readonly string[]; rows: readonly (readonly string[])[] }

export interface PluginStatusTab {
  schemaVersion?: 1
  id: string
  label: string
  body: PluginTabBody
}

/** sanitize 拒绝（含凭据模式命中）后的占位页签：渲染为一行降级提示。 */
export interface PluginStatusTabError {
  id: string
  label: string
  error: true
}

/** 内核保留页签 id：插件注册冲突即拒绝（PLUGIN-STATUS-UI-r1 §S3.2）。 */
export const STATUS_CORE_TAB_IDS: readonly string[] = [
  'settings',
  'status',
  'config',
  'usage',
  'stats',
]

export interface StatusPanelData {
  settings: readonly { label: string; value: string }[]
  status: readonly { label: string; value: string }[]
  config: readonly StatusConfigItem[]
  /** 缺省 = 当前会话用量不可用（如 welcome fallback 路径）。 */
  usage?: StatusUsageData
  /** 缺省 = 历史统计未加载（无 sessions 目录或端口未接）。 */
  stats?: StatusStatsData
  /**
   * 契约式扩展页签（PLUGIN-STATUS-UI-r1）；渲染前必须过 sanitizePluginTabs。
   * 插件 render 失败的贡献以 PluginStatusTabError 占位传入，sanitize 原样透传。
   */
  pluginTabs?: readonly (PluginStatusTab | PluginStatusTabError)[]
}

export interface StatusPanelController {
  update(id: string, value: StatusValue): Promise<StatusPanelData>
  /**
   * 面板打开时拉取最新数据。启动时传入的 statusPanel 是 REPL 启动快照
   * （usage/stats 会过时）；refresh 让 Usage/Stats 页签显示打开时刻的值。
   */
  refresh?(): Promise<StatusPanelData>
}

export interface StatusReason {
  code: string
}

export type StatusAvailability<T> =
  | { status: 'available'; value: T }
  | { status: 'disabled'; reason?: StatusReason }
  | { status: 'blocked'; reason: StatusReason }
  | { status: 'not_available'; reason: StatusReason }

export type StatusSource = 'default' | 'user' | 'project' | 'env' | 'flag' | 'session'
export type StatusModelSource = StatusSource | 'router' | 'derived_unreliable'

export interface StatusViewModel {
  identity: {
    version: string
    sessionId: string
    createdAt: string
    cwd: string
    workspace: StatusAvailability<string>
    project: StatusAvailability<string>
  }
  model:
    | {
        status: 'available'
        provider: string
        model: string
        liteModel: StatusAvailability<string>
        reasoningModel: StatusAvailability<string>
        source: Exclude<StatusModelSource, 'derived_unreliable'>
      }
    | {
        status: 'not_available'
        reason: StatusReason
        source: StatusModelSource
      }
  runtime: {
    sandbox: StatusAvailability<{ tier: 'full' | 'none' | 'partial' | 'weak'; mechanism: string }>
    filesystem: StatusAvailability<'isolated' | 'unrestricted' | 'workspace'>
    network: StatusAvailability<'available' | 'restricted' | 'unavailable'>
    permission: StatusAvailability<{
      mode: 'allow-session' | 'ask' | 'bypassed' | 'read-only' | 'yolo'
      source: StatusSource
    }>
    memory: StatusAvailability<{ mode: string }>
  }
  auth: {
    configured: StatusAvailability<boolean>
    method: StatusAvailability<'keychain' | 'encrypted_file' | 'env'>
  }
  settings: readonly StatusSetting[]
  config: {
    sources: StatusAvailability<readonly StatusSource[]>
  }
  capabilities: {
    mcpServers: StatusAvailability<StatusCapabilitySummary>
    skills: StatusAvailability<StatusCapabilitySummary>
    plugins: StatusAvailability<StatusCapabilitySummary>
  }
  usage: {
    tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
    context: { currentTokens: number; maxTokens: number; lastCompactedAt?: string }
    costUSD: number
  }
}

export interface StatusSetting {
  key: string
  effectiveValue: boolean | number | string
  source: StatusSource | 'not_available'
  readonly: boolean
  locked: boolean
  reason?: StatusReason
}

export interface StatusCapabilitySummary {
  count: number
  names?: readonly string[]
}

export interface StatusSection {
  id: 'config' | 'settings' | 'status'
  title: string
  items: readonly StatusSectionItem[]
}

export interface StatusSectionItem {
  key: string
  label: string
  value: boolean | number | string
  source?: string
  readonly?: boolean
  locked?: boolean
  reasonCode?: string
}

export function statusPanelFromWelcome(data: WelcomePanelData): StatusPanelData {
  const unavailable = 'not available'
  const model =
    data.model.status === 'available' ? `${data.model.provider}/${data.model.model}` : unavailable
  const sources = data.config.effectiveSources.length
    ? data.config.effectiveSources.join(', ')
    : 'defaults'
  return {
    settings: [
      { label: 'Language', value: 'system default' },
      { label: 'Model', value: model },
      { label: 'Settings sources', value: sources },
      { label: 'Memory', value: unavailable },
    ],
    status: [
      { label: 'Version', value: data.version },
      { label: 'Session ID', value: data.sessionId },
      { label: 'cwd', value: data.cwd },
      { label: 'Auth method', value: data.authMethod ?? unavailable },
      { label: 'Model', value: model },
      { label: 'Lite model', value: data.liteModel ?? unavailable },
      { label: 'Reasoning model', value: data.reasoningModel ?? unavailable },
      { label: 'Memory', value: data.memoryMode ?? unavailable },
      { label: 'Settings sources', value: sources },
      { label: 'Workspace', value: data.workspace ?? data.cwd },
      { label: 'MCP servers', value: summarizeMcp(data) },
      { label: 'Skills', value: data.skillsSummary ?? unavailable },
      { label: 'Plugins', value: data.pluginsSummary ?? unavailable },
      {
        label: 'Sandbox',
        value:
          data.sandbox.status === 'available'
            ? `${data.sandbox.tier} (${data.sandbox.mechanism})`
            : data.sandbox.status === 'probing'
              ? 'probing'
              : unavailable,
      },
      {
        label: 'Network',
        value: data.sandbox.status === 'available' ? data.sandbox.network : unavailable,
      },
      {
        label: 'Filesystem',
        value: data.sandbox.status === 'available' ? data.sandbox.filesystem : unavailable,
      },
      { label: 'Permissions', value: data.permission.mode },
    ],
    config: data.statusConfig ?? defaultStatusConfig(model),
  }
}

export const EDITABLE_STATUS_CONFIG_IDS = new Set([
  'language',
  'model',
  'reasoningEffort',
  'autoCompact',
  'notifications',
  'promptSuggestions',
  'showTokensCounter',
  'terminalProgressBar',
  'autoMemory',
  'typedMemory',
  'outputStyle',
  'cleanupPeriod',
])

export function validateStatusConfigValue(configItem: StatusConfigItem, value: StatusValue) {
  if (!configItem.editable || !EDITABLE_STATUS_CONFIG_IDS.has(configItem.id))
    throw new Error(`${configItem.label} is read-only`)
  if (configItem.kind === 'boolean' && typeof value !== 'boolean')
    throw new Error('Expected a boolean')
  if ((configItem.kind === 'enum' || configItem.kind === 'string') && typeof value !== 'string')
    throw new Error('Expected text')
  if (configItem.kind === 'enum' && !configItem.choices?.includes(String(value)))
    throw new Error(`Allowed values: ${configItem.choices?.join(', ')}`)
  if (configItem.kind === 'number') {
    if (typeof value !== 'number' || !Number.isInteger(value))
      throw new Error('Expected an integer')
    if (configItem.min !== undefined && value < configItem.min)
      throw new Error(`Minimum is ${configItem.min}`)
    if (configItem.max !== undefined && value > configItem.max)
      throw new Error(`Maximum is ${configItem.max}`)
  }
}

export function buildStatusSections(view: StatusViewModel): StatusSection[] {
  const model =
    view.model.status === 'available'
      ? `${view.model.provider}/${view.model.model}`
      : formatStatusAvailability(view.model)
  const statusItems: StatusSectionItem[] = [
    item('identity.version', 'Version', view.identity.version),
    item('identity.sessionId', 'Session ID', view.identity.sessionId),
    item('identity.createdAt', 'Created', view.identity.createdAt),
    item('identity.cwd', 'CWD', view.identity.cwd),
    item('identity.workspace', 'Workspace', formatStatusAvailability(view.identity.workspace)),
    item('identity.project', 'Project', formatStatusAvailability(view.identity.project)),
    item('model.current', 'Model', model),
    item('auth.configured', 'Auth configured', formatStatusAvailability(view.auth.configured)),
    item('auth.method', 'Auth method', formatStatusAvailability(view.auth.method)),
    item('runtime.sandbox', 'Sandbox', formatStatusAvailability(view.runtime.sandbox)),
    item('runtime.filesystem', 'Filesystem', formatStatusAvailability(view.runtime.filesystem)),
    item('runtime.network', 'Network', formatStatusAvailability(view.runtime.network)),
    item('runtime.permission', 'Permission', formatStatusAvailability(view.runtime.permission)),
    item('runtime.memory', 'Memory', formatStatusAvailability(view.runtime.memory)),
    item('capabilities.mcp', 'MCP servers', formatStatusAvailability(view.capabilities.mcpServers)),
    item('capabilities.skills', 'Skills', formatStatusAvailability(view.capabilities.skills)),
    item('capabilities.plugins', 'Plugins', formatStatusAvailability(view.capabilities.plugins)),
    item(
      'usage.tokens',
      'Tokens',
      `${view.usage.tokens.input} input / ${view.usage.tokens.output} output`,
    ),
    item(
      'usage.context',
      'Context',
      `${view.usage.context.currentTokens} / ${view.usage.context.maxTokens}`,
    ),
    item('usage.costUSD', 'Cost USD', view.usage.costUSD),
  ]
  if (view.model.status === 'not_available') {
    const index = statusItems.findIndex((entry) => entry.key === 'model.current')
    statusItems[index] = { ...statusItems[index]!, reasonCode: view.model.reason.code }
  }
  const status: StatusSection = {
    id: 'status',
    title: 'Status',
    items: statusItems,
  }
  const settings: StatusSection = {
    id: 'settings',
    title: 'Settings',
    items: view.settings
      .filter((setting) => !secretKey.test(setting.key))
      .map((setting) => settingItem(setting)),
  }
  const config: StatusSection = {
    id: 'config',
    title: 'Config',
    items: [
      {
        key: 'config.sources',
        label: 'Effective sources',
        value: formatStatusAvailability(view.config.sources),
        ...(view.config.sources.status !== 'available' && view.config.sources.reason
          ? { reasonCode: view.config.sources.reason.code }
          : {}),
      },
    ],
  }
  return [status, settings, config]
}

const secretKey = /(authorization|api[_-]?key|token|secret|credential|passphrase|password|oauth)/i

function defaultStatusConfig(model: string): StatusConfigItem[] {
  return [
    { id: 'language', label: 'Language', value: 'system', editable: true, kind: 'string' },
    { id: 'model', label: 'Model', value: model, editable: true, kind: 'string' },
    {
      id: 'reasoningEffort',
      label: 'Reasoning Effort',
      value: 'medium',
      editable: true,
      kind: 'enum',
      choices: ['low', 'medium', 'high'],
    },
    ...[
      'autoCompact',
      'notifications',
      'promptSuggestions',
      'showTokensCounter',
      'terminalProgressBar',
      'autoMemory',
      'typedMemory',
    ].map((id) => ({
      id,
      label: splitLabel(id),
      value: false,
      editable: true,
      kind: 'boolean' as const,
    })),
    {
      id: 'outputStyle',
      label: 'Output Style',
      value: 'default',
      editable: true,
      kind: 'enum',
      choices: ['default', 'concise', 'explanatory'],
    },
    {
      id: 'cleanupPeriod',
      label: 'Cleanup Period',
      value: 30,
      editable: true,
      kind: 'number',
      min: 1,
      max: 365,
    },
    ...[
      'authMethod',
      'sessionId',
      'enterprisePolicies',
      'trustAllDirectory',
      'mcpPermissions',
      'filesystemPermissions',
      'externalAccounts',
    ].map((id) => ({
      id,
      label: splitLabel(id),
      value: 'read-only',
      editable: false,
      readonlyReason: 'Security state cannot be changed here',
    })),
  ]
}

function splitLabel(value: string) {
  return value.replace(/([A-Z])/g, ' $1').replace(/^./, (character) => character.toUpperCase())
}

function summarizeMcp(data: WelcomePanelData) {
  return data.mcp.status === 'available'
    ? `${data.mcp.connected} connected / ${data.mcp.total} configured`
    : 'not available'
}

function item(key: string, label: string, value: boolean | number | string): StatusSectionItem {
  return { key, label, value }
}

function settingItem(setting: StatusSetting): StatusSectionItem {
  return {
    key: setting.key,
    label: setting.key,
    value: setting.effectiveValue,
    source: setting.source,
    readonly: setting.readonly,
    locked: setting.locked,
    ...(setting.reason ? { reasonCode: setting.reason.code } : {}),
  }
}

function formatStatusAvailability(
  value: StatusAvailability<unknown> | StatusViewModel['model'],
): string {
  if (value.status !== 'available') return `${value.status}:${value.reason?.code ?? 'disabled'}`
  if (!('value' in value)) return 'available'
  if (Array.isArray(value.value)) return value.value.join(', ')
  if (value.value && typeof value.value === 'object') {
    if ('count' in value.value && typeof value.value.count === 'number') {
      const names =
        'names' in value.value && Array.isArray(value.value.names) ? value.value.names : []
      return names.length
        ? `${value.value.count}: ${names.map(String).join(', ')}`
        : String(value.value.count)
    }
    return Object.entries(value.value)
      .map(([key, entry]) => `${key}=${String(entry)}`)
      .join(', ')
  }
  return String(value.value)
}

/** '1.1b' / '2.1k' / '134' — Stats/Usage 页签的大数缩写。 */
export function formatCompactCount(value: number): string {
  const abs = Math.abs(value)
  const units: readonly { limit: number; suffix: string }[] = [
    { limit: 1e9, suffix: 'b' },
    { limit: 1e6, suffix: 'm' },
    { limit: 1e3, suffix: 'k' },
  ]
  for (const unit of units) {
    if (abs >= unit.limit) {
      const scaled = value / unit.limit
      const text = scaled >= 100 ? Math.round(scaled).toString() : scaled.toFixed(1)
      return `${text.replace(/\.0$/, '')}${unit.suffix}`
    }
  }
  return String(Math.round(value))
}

/** '37s' / '3m 12s' / '18h 5m' / '13d 18h 5m'。 */
export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** Usage 页签成本列：小额 4 位小数（$0.0000），大额 2 位。 */
export function formatCostUSD(costUSD: number): string {
  return `$${costUSD < 1 ? costUSD.toFixed(4) : costUSD.toFixed(2)}`
}

/** 热力图档位：0 = 无活动，1-4 按当日计数相对最高日的分位数。 */
export function heatmapLevel(count: number, maxCount: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || maxCount <= 0) return 0
  const ratio = count / maxCount
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}

/** 《安娜·卡列尼娜》约 58.7 万词 ≈ 80 万 token，用于 Stats 的趣味对比行。 */
export const ANNA_KARENINA_TOKENS = 800_000

export function annaKareninaLine(totalTokens: number): string | undefined {
  const ratio = totalTokens / ANNA_KARENINA_TOKENS
  if (ratio < 1) return undefined
  return `You've used ~${Math.round(ratio)}x more tokens than Anna Karenina`
}

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

/** '2026-03-03'（本地日 key）→ 'Mar 3'；非法输入原样返回。 */
export function formatShortDay(dayKey: string): string {
  const [year, month, date] = dayKey.split('-').map(Number)
  if (!year || !month || !date || month < 1 || month > 12) return dayKey
  return `${SHORT_MONTHS[month - 1]} ${date}`
}

// ---------------------------------------------------------------------------
// PLUGIN-STATUS-UI-r1 §S3.3 sanitize：渲染前对插件贡献的页签描述符强制执行。
// ---------------------------------------------------------------------------

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\x00-\x1F\x7F\u202A-\u202E\u2066-\u2069]/g
const CREDENTIAL_PATTERN =
  /(authorization|api[_-]?key|token|REFID_003Q|credential|passphrase|REFID_001Q|oauth)/i

const PLUGIN_TAB_LIMITS = {
  idLength: 64,
  labelLength: 12,
  rowLabelLength: 40,
  rowValueLength: 200,
  sectionRows: 20,
  tabRows: 40,
  heatmapDays: 371,
  tableColumns: 4,
  tableRows: 20,
} as const

function stripControls(value: string): string {
  return value.replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, '')
}

function clip(value: string, max: number): string {
  const clean = stripControls(value)
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function hitsCredentialPattern(value: string): boolean {
  return CREDENTIAL_PATTERN.test(value)
}

function coerceRow(row: unknown): readonly [string, string] | undefined {
  if (!Array.isArray(row) || row.length !== 2) return undefined
  const label: unknown = row[0]
  const value: unknown = row[1]
  if (label === undefined || label === null) return undefined
  if (!['string', 'number', 'boolean'].includes(typeof value)) return undefined
  return [
    clip(String(label), PLUGIN_TAB_LIMITS.rowLabelLength),
    clip(String(value), PLUGIN_TAB_LIMITS.rowValueLength),
  ]
}

function markTruncated(
  rows: readonly (readonly [string, string])[],
): readonly (readonly [string, string])[] {
  if (rows.length === 0) return rows
  const last = rows[rows.length - 1]!
  return [...rows.slice(0, -1), [last[0], `${last[1]} … (truncated)`]]
}

/**
 * 校验并清洗插件页签描述符。凭据模式命中 → 整个描述符拒绝（返回 error 占位）；
 * 尺寸超限 → 截断并标注；id 保留字冲突 / 非法日期 / 非法数值 → 拒绝。
 */
export function sanitizePluginTabs(
  tabs: readonly (PluginStatusTab | PluginStatusTabError)[],
): readonly (PluginStatusTab | PluginStatusTabError)[] {
  const out: (PluginStatusTab | PluginStatusTabError)[] = []
  const seen = new Set(STATUS_CORE_TAB_IDS)
  for (const tab of tabs) {
    if ('error' in tab) {
      // 上游（桥渲染失败）已降级的占位：清洗 id/label 后透传，保留降级行。
      out.push({
        id: clip(String(tab.id ?? ''), PLUGIN_TAB_LIMITS.idLength) || 'unknown',
        label: clip(String(tab.label ?? ''), PLUGIN_TAB_LIMITS.labelLength) || 'plugin',
        error: true,
      })
      continue
    }
    const id = clip(String(tab.id ?? ''), PLUGIN_TAB_LIMITS.idLength)
    const label = clip(String(tab.label ?? ''), PLUGIN_TAB_LIMITS.labelLength)
    const reject = (): void => {
      out.push({ id: id || 'unknown', label: label || 'plugin', error: true })
    }
    if (!id || !label || seen.has(id)) {
      reject()
      continue
    }
    const body = sanitizePluginTabBody(tab.body)
    if (!body || hitsCredentialPattern(JSON.stringify(body)) || hitsCredentialPattern(label)) {
      reject()
      continue
    }
    seen.add(id)
    out.push({ schemaVersion: 1, id, label, body })
  }
  return out
}

function sanitizePluginTabBody(body: PluginStatusTab['body']): PluginTabBody | undefined {
  if (!body || typeof body !== 'object') return undefined
  if (body.kind === 'rows') {
    const rawSections: unknown = body.sections
    if (!Array.isArray(rawSections)) return undefined
    let budget = PLUGIN_TAB_LIMITS.tabRows
    const sections: { title?: string; rows: readonly (readonly [string, string])[] }[] = []
    for (const rawSection of rawSections) {
      const section = (rawSection ?? {}) as { title?: unknown; rows?: unknown }
      const rawRows: unknown[] = Array.isArray(section.rows) ? section.rows : []
      const coerced = rawRows
        .map(coerceRow)
        .filter((row): row is readonly [string, string] => row !== undefined)
      const clipped = coerced.slice(0, Math.max(0, Math.min(PLUGIN_TAB_LIMITS.sectionRows, budget)))
      budget -= clipped.length
      const truncated = clipped.length < coerced.length
      sections.push({
        ...(typeof section.title === 'string'
          ? { title: clip(section.title, PLUGIN_TAB_LIMITS.rowLabelLength) }
          : {}),
        rows: truncated ? markTruncated(clipped) : clipped,
      })
    }
    return { kind: 'rows', sections }
  }
  if (body.kind === 'heatmap') {
    const start = typeof body.heatmap?.start === 'string' ? body.heatmap.start : ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(Date.parse(`${start}T00:00:00`)))
      return undefined
    const rawDays: unknown = body.heatmap?.days
    const days = (Array.isArray(rawDays) ? rawDays : [])
      .slice(0, PLUGIN_TAB_LIMITS.heatmapDays)
      .map((day: unknown) =>
        typeof day === 'number' && Number.isFinite(day) && day >= 0 ? Math.floor(day) : 0,
      )
    return {
      kind: 'heatmap',
      heatmap: { start, days },
      ...(typeof body.legend === 'string'
        ? { legend: clip(body.legend, PLUGIN_TAB_LIMITS.rowValueLength) }
        : {}),
    }
  }
  if (body.kind === 'table') {
    const rawColumns: unknown = body.columns
    const rawRows: unknown = body.rows
    if (!Array.isArray(rawColumns) || !Array.isArray(rawRows)) return undefined
    const columns = rawColumns
      .slice(0, PLUGIN_TAB_LIMITS.tableColumns)
      .map((column: unknown) => clip(String(column), PLUGIN_TAB_LIMITS.rowLabelLength))
    const rows = rawRows.slice(0, PLUGIN_TAB_LIMITS.tableRows).map((row: unknown) => {
      const cells: unknown[] = Array.isArray(row) ? row : []
      return cells
        .slice(0, columns.length)
        .map((cell) => clip(String(cell), PLUGIN_TAB_LIMITS.rowValueLength))
    })
    return { kind: 'table', columns, rows }
  }
  return undefined
}
