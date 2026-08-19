export type SandboxTier = 'full' | 'none' | 'partial' | 'weak'
export * from './permission-display'
export * from './components/welcome/index'
export const THEME_SCHEMA_VERSION = 1 as const
export const THEME_TOKEN_NAMES = [
  'background',
  'foreground',
  'muted',
  'accent',
  'success',
  'warning',
  'error',
  'border',
] as const
export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number]
export type ThemeTokens = Readonly<Record<ThemeTokenName, string>>
export interface ThemeDefinition {
  schemaVersion: typeof THEME_SCHEMA_VERSION
  name: string
  tokens: ThemeTokens
}
const themeColor = /^#[0-9a-f]{6}$/i
const builtinTokens = {
  dark: {
    background: '#101214',
    foreground: '#f2f4f5',
    muted: '#92999f',
    accent: '#72a7ff',
    success: '#61c995',
    warning: '#e5b95c',
    error: '#ef7272',
    border: '#353b40',
  },
  light: {
    background: '#ffffff',
    foreground: '#17191b',
    muted: '#687078',
    accent: '#245fc5',
    success: '#18794e',
    warning: '#8a6100',
    error: '#c62f2f',
    border: '#d7dadd',
  },
} satisfies Record<string, ThemeTokens>
export const BUILTIN_THEMES: Readonly<Record<'dark' | 'light', ThemeDefinition>> = Object.freeze({
  dark: Object.freeze({
    schemaVersion: 1,
    name: 'dark',
    tokens: Object.freeze(builtinTokens.dark),
  }),
  light: Object.freeze({
    schemaVersion: 1,
    name: 'light',
    tokens: Object.freeze(builtinTokens.light),
  }),
})
export function validateTheme(value: unknown): ThemeDefinition {
  if (!value || typeof value !== 'object') throw new Error('theme_invalid: expected an object')
  const theme = value as Partial<ThemeDefinition>
  if (theme.schemaVersion !== THEME_SCHEMA_VERSION)
    throw new Error(`theme_version_unsupported: ${String(theme.schemaVersion)}`)
  if (typeof theme.name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(theme.name))
    throw new Error('theme_invalid: invalid name')
  if (!theme.tokens || typeof theme.tokens !== 'object')
    throw new Error('theme_invalid: tokens are required')
  const entries = Object.entries(theme.tokens)
  if (
    entries.length !== THEME_TOKEN_NAMES.length ||
    entries.some(([key]) => !THEME_TOKEN_NAMES.includes(key as ThemeTokenName))
  )
    throw new Error('theme_invalid: token set must match schema v1')
  for (const token of THEME_TOKEN_NAMES)
    if (!themeColor.test(theme.tokens[token]))
      throw new Error(`theme_invalid: invalid token ${token}`)
  return Object.freeze({
    schemaVersion: 1,
    name: theme.name,
    tokens: Object.freeze({ ...theme.tokens }),
  })
}
export function resolveTheme(value: unknown, fallback: 'dark' | 'light' = 'dark') {
  try {
    return { theme: validateTheme(value), fallback: false as const }
  } catch (error) {
    return {
      theme: BUILTIN_THEMES[fallback],
      fallback: true as const,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
export function parseTheme(source: string, fallback: 'dark' | 'light' = 'dark') {
  try {
    return resolveTheme(JSON.parse(source), fallback)
  } catch (error) {
    return {
      theme: BUILTIN_THEMES[fallback],
      fallback: true as const,
      error: `theme_invalid_json: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
export type UiContribution = { id: string; surface: 'status-bar'; text: string; priority?: number }
export interface UiDisposable {
  dispose(): void
}
export class PluginUiRegistry {
  #items = new Map<string, Map<string, UiContribution>>()
  constructor(readonly headless = false) {}
  register(plugin: string, contribution: UiContribution): UiDisposable {
    if (this.headless) return { dispose() {} }
    const items = this.#items.get(plugin) ?? new Map<string, UiContribution>()
    items.set(contribution.id, structuredClone(contribution))
    this.#items.set(plugin, items)
    return {
      dispose: () => {
        items.delete(contribution.id)
        if (items.size === 0) this.#items.delete(plugin)
      },
    }
  }
  list(
    surface: UiContribution['surface'],
  ): ReadonlyArray<Readonly<UiContribution & { plugin: string }>> {
    if (this.headless) return []
    return [...this.#items]
      .flatMap(([plugin, items]) =>
        [...items.values()].map((item) => Object.freeze({ ...item, plugin })),
      )
      .filter((item) => item.surface === surface)
      .sort(
        (a, b) =>
          (b.priority ?? 0) - (a.priority ?? 0) ||
          a.plugin.localeCompare(b.plugin) ||
          a.id.localeCompare(b.id),
      )
  }
  clear(plugin: string) {
    this.#items.delete(plugin)
  }
}
export interface SandboxDisclosure {
  tier: SandboxTier
  mechanism: string
  features: { filesystem: boolean; network: boolean }
  degradationReasons: readonly string[]
}

export interface TelemetryPanelState {
  samples: number
  corruptLines: number
  tiers: Record<string, number>
  escape: { allow: number; deny: number; ratio: number | null }
  probe: {
    mechanism: string
    tier: SandboxTier
    abi?: string
    version?: string
    probedAt: string
  } | null
}
export function renderTelemetryPanel(state: TelemetryPanelState, now = Date.now()): string {
  const tiers =
    Object.entries(state.tiers)
      .map(([tier, count]) => `${tier}=${count}`)
      .join(', ') || 'no samples'
  const escape =
    state.escape.ratio === null
      ? 'no samples (unknown)'
      : `${state.escape.allow} pass / ${state.escape.deny} deny (${Math.round(state.escape.ratio * 100)}% denied)`
  const probe = state.probe
    ? `${state.probe.mechanism}; tier=${state.probe.tier}; ABI=${state.probe.abi ?? 'unknown'}; version=${state.probe.version ?? 'unknown'}; age=${Math.max(0, Math.round((now - Date.parse(state.probe.probedAt)) / 1000))}s`
    : 'no sample (unknown)'
  return [
    `Telemetry (local)`,
    `Samples: ${state.samples}; corrupt lines ignored: ${state.corruptLines}`,
    `Tiers: ${tiers}`,
    `Escape decisions: ${escape}`,
    `Probe: ${probe}`,
  ].join('\n')
}
export type DangerousMode = 'no-sandbox' | 'skip-permissions'
export { statusPanelFromWelcome, validateStatusConfigValue } from './status'
export * from './status'
export { renderDirectoryTrustPrompt, renderInteractiveApp } from './tui'
export * from './tui'
export * from './session-picker'
export * from './memory-panel'
export type {
  InteractiveAppOptions,
  ResumedInteractiveSession,
  SessionResumeController,
  SlashCommand,
  TranscriptEntry,
} from './app'
export {
  BUILTIN_SLASH_COMMAND_NAMES,
  MutableSlashCommandRegistry,
  normalizeSlashCommandName,
} from './slash-command-registry'
export type {
  RegisteredSlashCommand,
  SlashCommandRegistry,
  SlashCommandSource,
} from './slash-command-registry'

export interface ContextPanelState {
  strategy: string
  currentTokens: number
  maxTokens: number
  threshold: number
  sources: Record<string, number>
  recentCompactions: readonly { at: string; removed: number; turns?: string }[]
}
export function renderContextPanel(state: ContextPanelState): string {
  const percent = Math.round((state.currentTokens / Math.max(1, state.maxTokens)) * 100)
  const sources = Object.entries(state.sources)
    .map(([name, tokens]) => `  ${name}: ${tokens}`)
    .join('\n')
  const history = state.recentCompactions.length
    ? state.recentCompactions
        .map(
          (item) =>
            `  ${item.at} removed ${item.removed} msgs${item.turns ? ` (${item.turns})` : ''}`,
        )
        .join('\n')
    : '  none'
  return [
    `Context`,
    `Strategy: ${state.strategy}   Budget: ${state.currentTokens} / ${state.maxTokens} (${percent}%)`,
    `Compacts at: ${Math.round(state.threshold * 100)}%`,
    'Sources:',
    sources,
    'Recent compactions:',
    history,
    '[K] keep selected  [C] compact  [Esc] close',
  ].join('\n')
}
export type ContextPanelAction =
  | { type: 'close' }
  | { type: 'compact' }
  | { type: 'keep'; messageId: string }
export function contextPanelKey(
  key: string,
  selectedMessageId?: string,
): ContextPanelAction | undefined {
  if (key === 'Escape') return { type: 'close' }
  if (key.toLowerCase() === 'c') return { type: 'compact' }
  if (key.toLowerCase() === 'k' && selectedMessageId)
    return { type: 'keep', messageId: selectedMessageId }
}

export function renderSecurityBanner(modes: readonly DangerousMode[], color: boolean): string {
  const labels = modes.map((mode) =>
    mode === 'no-sandbox' ? 'DANGER: NO SANDBOX' : 'DANGER: PERMISSIONS DISABLED',
  )
  if (labels.length === 0) return ''
  const text = ` ${labels.join(' | ')} `
  return color ? `\u001B[41m\u001B[97m${text}\u001B[0m` : text
}

export function renderSandboxDisclosure(probe: SandboxDisclosure): string {
  const limitations =
    probe.degradationReasons.length === 0 ? 'none' : probe.degradationReasons.join('; ')
  return [
    `Sandbox: ${probe.tier.toUpperCase()}`,
    `Mechanism: ${probe.mechanism}`,
    `Filesystem isolation: ${probe.features.filesystem ? 'enforced' : 'unavailable'}`,
    `Network egress: ${probe.features.network ? 'enforced' : 'unavailable'}`,
    `Limitations: ${limitations}`,
  ].join('\n')
}

export function renderPrivacyDisclosure(): string {
  return [
    'Before we start:',
    'Apollo saves session logs locally.',
    'Apollo does not send analytics anywhere by default.',
    'Prompts and code are sent only through the provider you choose.',
  ].join('\n')
}

export interface SessionView {
  id: string
  interruptedText: string | null
  pendingText: string
  status: 'active' | 'ended' | 'interrupted'
  transcript: string[]
}
export type SessionViewEvent =
  | { type: 'message.interrupted' | 'session.ended' }
  | { type: 'stream.completed' | 'stream.delta'; text?: string }
export function createSessionView(id: string): SessionView {
  return { id, interruptedText: null, pendingText: '', status: 'active', transcript: [] }
}
export function applySessionEvent(view: SessionView, event: SessionViewEvent): void {
  if (event.type === 'stream.delta') view.pendingText += event.text ?? ''
  if (event.type === 'stream.completed') {
    view.transcript.push(event.text ?? view.pendingText)
    view.pendingText = ''
  }
  if (event.type === 'message.interrupted') {
    view.interruptedText = view.pendingText
    view.pendingText = ''
    view.status = 'interrupted'
  }
  if (event.type === 'session.ended') view.status = 'ended'
}

export interface ModelAlias {
  alias: string
  model: string
}
export interface PickerCandidate {
  kind: 'file' | 'model'
  label: string
  value: string
}
export type PickerMode = 'file' | 'model' | 'unified'

export function pickerMode(input: string): PickerMode {
  if (input.startsWith('@@')) return 'file'
  if (input.startsWith('@!')) return 'model'
  return 'unified'
}

export function createPickerCandidates(
  input: string,
  aliases: readonly ModelAlias[],
  files: readonly string[],
): PickerCandidate[] {
  const mode = pickerMode(input)
  const prefix = input.slice(mode === 'unified' ? 1 : 2).toLocaleLowerCase()
  const models =
    mode === 'file'
      ? []
      : aliases
          .filter((item) => item.alias.toLocaleLowerCase().startsWith(prefix))
          .map((item) => ({ kind: 'model' as const, label: `⭐ ${item.alias}`, value: item.model }))
  const paths =
    mode === 'model'
      ? []
      : files
          .filter((path) => path.toLocaleLowerCase().startsWith(prefix))
          .map((path) => ({ kind: 'file' as const, label: `📄 ${path}`, value: path }))
  return [...models, ...paths]
}

export interface PickerSelection {
  attachment?: string
  hint?: { explicitModel: string }
  text: string
}
export function applyPickerSelection(input: string, candidate: PickerCandidate): PickerSelection {
  const suffix = input.replace(/^@{1,2}!?[^\s]*/, '').trimStart()
  if (candidate.kind === 'model') return { hint: { explicitModel: candidate.value }, text: suffix }
  return {
    attachment: candidate.value,
    text: `[@file:${candidate.value}]${suffix ? ` ${suffix}` : ''}`,
  }
}

export interface PermissionPrompt {
  description: string
  diff?: string
  id: string
  risk: 'high' | 'low' | 'medium'
}
export type PermissionDecision = 'allow-once' | 'allow-session' | 'deny'
export class PermissionPromptQueue {
  #tail: Promise<void> = Promise.resolve()
  constructor(private readonly show: (prompt: PermissionPrompt) => Promise<PermissionDecision>) {}
  request(prompt: PermissionPrompt): Promise<PermissionDecision> {
    const result = this.#tail.then(() => this.show(prompt))
    this.#tail = result.then(
      () => {},
      () => {},
    )
    return result
  }
}

export function renderPermissionPrompt(prompt: PermissionPrompt): string {
  return [
    `Permission required [${prompt.risk.toUpperCase()}]`,
    prompt.description,
    prompt.diff ? renderDiff(prompt.diff) : '',
    '[allow once] [allow session] [deny]',
  ]
    .filter(Boolean)
    .join('\n')
}
export function renderDiff(diff: string): string {
  return diff
    .split('\n')
    .map((line) =>
      line.startsWith('+') && !line.startsWith('+++')
        ? `+ ${line.slice(1)}`
        : line.startsWith('-') && !line.startsWith('---')
          ? `- ${line.slice(1)}`
          : `  ${line}`,
    )
    .join('\n')
}

export function resumeSessionView(view: SessionView, transcript: readonly string[]): void {
  view.transcript = [...transcript]
  view.pendingText = ''
  view.interruptedText = null
  view.status = 'active'
}

export * from './app'
export * from './model-picker'
export * from './permission'
export * from './status'
export * from './tui'
export * from './components/InputBox'
export * from './components/DirectoryTrustPrompt'
export * from './components/MessageBlock'
export * from './components/ModelPicker'
export * from './components/PanelFrame'
export * from './components/PermissionPromptStack'
export * from './components/ScrollableTranscript'
export * from './components/SelectList'
export * from './components/StatusLine'
export * from './components/StatusPanel'
export * from './components/TabBar'
export * from './components/TopBar'
export * from './components/WelcomePanel'
export * from './hooks/useSessionEvents'
export * from './hooks/useStreamBuffer'
export * from './welcome'
