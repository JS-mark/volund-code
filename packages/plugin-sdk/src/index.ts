export interface Disposable {
  dispose(): void | Promise<void>
}

export type HookEvent =
  | 'prePrompt'
  | 'postPrompt'
  | 'preToolUse'
  | 'postToolUse'
  | 'sessionStart'
  | 'sessionEnd'
  | 'pluginEnabled'
  | 'pluginDisabled'
  | 'permissionsChanged'
  | 'memory.preRecall'
  | 'memory.postRecall'
  | 'memory.preWrite'
  | 'memory.postWrite'
  | 'memory.preRead'
  | 'memory.deleted'

export interface HookResult {
  veto?: boolean
  reason?: string
  value?: unknown
}
export type HookHandler = (payload: unknown) => void | HookResult | Promise<void | HookResult>

export type PluginMemoryScope = 'workspace' | 'project' | 'session'
export type PluginMemoryMutationOperation =
  | 'create'
  | 'update'
  | 'delete'
  | 'pin'
  | 'unpin'
  | 'invalidateAttachment'
  | 'deleteAttachment'
export interface PluginMemoryHookPayload {
  readonly schemaVersion: 1
  readonly operation: PluginMemoryMutationOperation
  readonly phase: 'validation' | 'commit'
  readonly scope: PluginMemoryScope
  readonly id: string
  /** Candidate content is present only after the built-in secret guard accepts it. */
  readonly content?: string
}

export interface ToolSpec {
  name: string
  description: string
  inputSchema: Readonly<Record<string, unknown>>
  handler(input: unknown, context: Readonly<Record<string, unknown>>): Promise<unknown>
}
export interface CommandSpec {
  name: string
  description?: string
  /**
   * 建议列表与 /help 的排序键（升序，可选）。未设置 order 的命令保持在未排序
   * 段（内置命令在前、其余按注册序）；设置了 order 的命令按值升序浮到未排序
   * 段之前——插件用它在多个贡献命令之间声明展示顺序。桥值必须是有限数，
   * 非法值按未设置处理。
   */
  order?: number
  /**
   * 斜杠命令处理器。返回值契约：字符串 → 作为系统消息进 transcript；
   * CommandListView（`{ kind: 'list', ... }` 纯数据描述符）→ UI 打开可搜索的
   * 列表面板（resume 风格，选中条目的 detail 进 transcript）；
   * CommandTabsView（`{ kind: 'tabs', ... }`）→ UI 打开多页签列表面板
   * （/plugins 风格，←/→ 切页签）；void → 静默成功。抛出异常 → 消息按失败展示。
   */
  handler(
    args: readonly string[],
  ):
    | void
    | string
    | CommandListView
    | CommandTabsView
    | Promise<void | string | CommandListView | CommandTabsView>
}
/**
 * 命令的结构化列表输出（纯数据，可过桥）：UI 渲染成可搜索选择器。
 * 与 packages/ui 的 CommandListView 结构化一致（两侧各自定义，桥值是 JSON）。
 */
export interface CommandListView {
  readonly kind: 'list'
  readonly title: string
  readonly placeholder?: string
  readonly entries: readonly CommandListEntry[]
}
export interface CommandListEntry {
  readonly id: string
  readonly label: string
  readonly value?: string
  readonly status?: string
  /** 选中后进入 transcript 的完整文本（长值全文放这里）。 */
  readonly detail?: string
}
/**
 * 命令的多页签列表输出（纯数据，可过桥）：UI 渲染成带页签的可搜索面板
 * （/plugins 风格，←/→ 切页签，搜索词作用于当前页签）。条目形状复用
 * CommandListEntry。与 packages/ui 的 CommandTabsView 结构化一致。
 */
export interface CommandTabsView {
  readonly kind: 'tabs'
  readonly title: string
  readonly placeholder?: string
  readonly tabs: readonly CommandTabsSection[]
}
export interface CommandTabsSection {
  readonly id: string
  readonly label: string
  readonly entries: readonly CommandListEntry[]
}
/**
 * [env] 配置段的单条生效快照（`volund.env.getEffective` 的返回元素，宿主侧
 * 计算）：configured 是配置值经前置解析（`~` / `${VAR}`）后的应用值，actual
 * 是当前 process.env 里的实际值（null = 未设置）；status = effective（一致）/
 * overridden（被外部改写）/ pending（尚未应用，如未经 applyEnv 的一次性子命令）。
 * sandboxPassthrough 标出该名字是否经 [tools] pass_through_env（或最小继承集
 * PATH/HOME/LANG/TZ）进入沙箱。
 */
export interface EffectiveEnvEntry {
  readonly key: string
  readonly configured: string
  readonly actual: string | null
  readonly status: 'effective' | 'pending' | 'overridden'
  readonly sandboxPassthrough: boolean
}
/**
 * 宿主侧装载清单的单个插件（`volund.plugins.list` 的返回元素，宿主侧计算）：
 * source = builtin（产物自带）/ dev（~/.volund/plugins-dev + VOLUND_DEV_PLUGINS）/
 * market（市场安装到 ~/.volund/plugins 的插件）。
 */
export interface PluginInventoryEntry {
  readonly name: string
  readonly version: string
  readonly dir: string
  readonly source: 'builtin' | 'dev' | 'market'
  readonly commands: number
  readonly statusTabs: number
  /** v2 生命周期；旧宿主可省略。installed / approved / enabled / loaded 不再混为一态。 */
  readonly lifecycle?: {
    readonly permissionHash: string
    readonly approved: boolean
    readonly enabled: boolean
    readonly loaded: boolean
  }
  /** 批准前供用户检查的完整权限声明。 */
  readonly permissions?: PluginManifest['permissions']
}
/** 市场索引里的单个可安装条目（files 摘要不进清单，仅宿主安装时使用）。 */
export interface PluginMarketListing {
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly publisher?: string
}
export interface PluginInventory {
  readonly builtin: readonly PluginInventoryEntry[]
  readonly dev: readonly PluginInventoryEntry[]
  readonly market: {
    readonly installed: readonly PluginInventoryEntry[]
    /** registry 缺省未配置 / 拉取失败时为 { error }，面板负责解释。 */
    readonly registry:
      | { source: string; plugins: readonly PluginMarketListing[] }
      | { error: string }
  }
}
export interface PluginInstallResult {
  readonly name: string
  readonly version: string
  readonly dir: string
  /** 市场安装只落盘，不激活；批准时必须回传这个完整哈希。 */
  readonly permissionHash?: string
  readonly approvalRequired?: boolean
  readonly permissions?: PluginManifest['permissions']
}
export interface PromptFragment {
  id: string
  content: string
  priority?: number
}
export interface Message {
  readonly role: string
  readonly content: unknown
}
export interface Usage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cost?: number
}
export interface FileStat {
  readonly size: number
  readonly type: 'file' | 'directory' | 'other'
  readonly modifiedAt: number
}
export interface ExecOptions {
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
}
export const PLUGIN_UI_SURFACES = ['status-bar'] as const
export type PluginUiSurface = (typeof PLUGIN_UI_SURFACES)[number]
export interface PluginUiContribution {
  id: string
  surface: PluginUiSurface
  /** Plain text only; executable components and markup are intentionally unsupported. */
  text: string
  priority?: number
}

// ---------------------------------------------------------------------------
// PLUGIN-STATUS-UI-r1 §S3.2：/status 面板贡献的声明式体例。纯数据契约——
// 描述符必须 JSON 可序列化，渲染权永远在 K0；插件自渲染是永久 non-goal。
// ---------------------------------------------------------------------------

export type PluginStatusTabBody =
  | {
      kind: 'rows'
      sections: readonly {
        title?: string
        rows: readonly (readonly [string, string | number | boolean])[]
      }[]
    }
  | { kind: 'heatmap'; heatmap: { start: string; days: readonly number[] }; legend?: string }
  | { kind: 'table'; columns: readonly string[]; rows: readonly (readonly string[])[] }

export interface PluginStatusTabSpec {
  /** 全局唯一；内核保留 id（settings/status/config/usage/stats）冲突即拒绝。 */
  id: string
  /** ≤ 12 字符（TabBar 单格宽度预算）。 */
  label: string
  /** 面板打开 / 用户按 r 时由 K0 回调；返回 null = 本次不渲染。 */
  render(): PluginStatusTabBody | null | Promise<PluginStatusTabBody | null>
}

export interface PluginStatusSectionSpec {
  /** 插件内唯一；section 追加到内置 status 页签末尾。 */
  id: string
  title: string
  render():
    | { rows: readonly (readonly [string, string | number | boolean])[] }
    | null
    | Promise<{ rows: readonly (readonly [string, string | number | boolean])[] } | null>
}

export interface PluginManifest {
  kind?: 'plugin' | 'provider'
  name: `volund-plugin-${string}`
  version: string
  engines: { volund: string }
  main: string
  type: 'module'
  contributes?: { ui?: readonly PluginUiContribution[]; [key: string]: unknown }
  provider?: {
    name: string
    displayName: string
    auth:
      | {
          mode: 'header-template'
          credentialScope: string
          headerTemplate: string
        }
      | {
          mode: 'signing'
          credentialScope: string
          signing: {
            algorithm: 'aws-sigv4' | 'acs3' | 'custom'
            envKeys: readonly string[]
          }
        }
    models?: readonly { id: string; maxContext?: number }[]
  }
  permissions: {
    fs?: { read?: readonly string[]; write?: readonly string[] }
    bash?: { allowlist: readonly string[] }
    net?: false | { allowlist: readonly string[] }
    volund: readonly string[]
    memory?: {
      read?: readonly PluginMemoryScope[]
      write?: boolean
      search?: boolean
      export?: boolean
    }
  }
  config?: Readonly<Record<string, unknown>>
}

export interface PluginMemoryRecord {
  readonly schemaVersion: 1
  readonly id: string
  readonly scope: Readonly<Record<string, string>>
  readonly content: string
  readonly tags: readonly string[]
  readonly pinned: boolean
  readonly provenance: Readonly<Record<string, unknown>>
  readonly attachments: readonly Readonly<Record<string, unknown>>[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly deletedAt: string | null
}

export interface PluginMemoryBridge {
  get(scope: PluginMemoryScope, id: string): Promise<PluginMemoryRecord | null>
  list(
    scope: PluginMemoryScope,
    options?: { limit?: number; tags?: readonly string[]; pinned?: boolean },
  ): Promise<readonly PluginMemoryRecord[]>
  search(
    scope: PluginMemoryScope,
    query: string,
    options?: { limit?: number; tags?: readonly string[] },
  ): Promise<readonly Readonly<{ record: PluginMemoryRecord; score: number }>[]>
  create(input: {
    scope: PluginMemoryScope
    id?: string
    content: string
    tags?: readonly string[]
    pinned?: boolean
  }): Promise<PluginMemoryRecord>
  update(
    scope: PluginMemoryScope,
    id: string,
    patch: Readonly<{ content?: string; tags?: readonly string[]; pinned?: boolean }>,
  ): Promise<PluginMemoryRecord>
  delete(scope: PluginMemoryScope, id: string): Promise<PluginMemoryRecord>
  export(scope: PluginMemoryScope): Promise<Readonly<Record<string, unknown>>>
}

/** Versioned, data-only metadata returned by a plugin registry. */
export interface PluginRegistryMetadata {
  schemaVersion: 1
  name: `volund-plugin-${string}`
  version: string
  source: string
  bundle: {
    url: string
    digest: `sha256-${string}`
  }
  signature: {
    keyId: string
    value: string
  }
  revoked: boolean
}

/** The signed payload excludes the signature bytes but binds every trust decision field. */
export interface PluginRegistrySignedPayload {
  schemaVersion: 1
  name: `volund-plugin-${string}`
  version: string
  source: string
  bundle: PluginRegistryMetadata['bundle']
  revoked: boolean
}
export type {
  ModelDescriptor,
  ProviderCapabilities,
  ProviderChunk,
  ProviderClient,
  ProviderRequest,
} from '@volund/provider-kit'
export interface VolundBridge {
  readonly apiVersion: '1.0'
  readonly plugin: Readonly<{ name: string; version: string; dataDir: string }>
  readonly tools: {
    register(spec: ToolSpec): Disposable
    unregister(name: string): void
  }
  readonly hooks: {
    on(event: HookEvent, handler: HookHandler, options?: { priority?: number }): Disposable
    off(event: HookEvent, handler: HookHandler): void
    readonly kv: {
      get<T = unknown>(key: string): T | undefined
      set(key: string, value: unknown): void
      delete(key: string): void
      clear(): void
    }
  }
  readonly commands: { register(spec: CommandSpec): Disposable }
  /**
   * [env] 配置段的生效视图（宿主侧数据，沙箱内读不到 process.env）。
   * 需要 manifest `permissions.volund` 包含 `'env.read'`（deny-by-default）。
   * 仅本地（dev / 内置）通道提供；冻结中的 legacy Catalog 路径不实现，
   * 插件侧应 `volund.env?.getEffective()` 或 try/catch 降级。
   */
  readonly env?: {
    getEffective(): Promise<readonly EffectiveEnvEntry[]>
  }
  /**
   * 插件装载清单与市场管理（宿主侧数据 + 宿主侧动作；沙箱内无网络，市场索引
   * 的拉取/安装都由宿主完成）。需要 manifest `permissions.volund` 包含
   * `'plugins.read'`（list / inspect）与 `'plugins.manage'`（install / approve /
   * enable / disable / uninstall），
   * deny-by-default。仅本地（内置 / dev / 市场）通道提供；插件侧应判空降级。
   */
  readonly plugins?: {
    list(): Promise<PluginInventory>
    inspect(name: string): Promise<PluginInventoryEntry>
    install(name: string): Promise<PluginInstallResult>
    approve(name: string, permissionHash: string): Promise<PluginInventoryEntry>
    enable(name: string): Promise<PluginInventoryEntry>
    disable(name: string): Promise<PluginInventoryEntry>
    uninstall(name: string): Promise<{ name: string }>
  }
  readonly prompt: { contribute(fragment: PromptFragment): Disposable; revoke(id: string): void }
  readonly session: {
    readonly id: string
    readonly cwd: string
    getMessages(range?: { limit?: number }): readonly Readonly<Message>[]
    getUsage(): Readonly<Usage>
    on(event: string, handler: (payload: Readonly<unknown>) => void): Disposable
  }
  readonly fs: {
    readFile(path: string, encoding?: 'utf-8' | 'binary'): Promise<string | Uint8Array>
    writeFile(path: string, data: string | Uint8Array): Promise<void>
    exists(path: string): Promise<boolean>
    glob(pattern: string): Promise<string[]>
    stat(path: string): Promise<FileStat>
  }
  exec(
    command: string,
    options?: ExecOptions,
  ): Promise<{ stdout: string; stderr: string; code: number }>
  readonly http: { fetch(url: string, init?: Readonly<Record<string, unknown>>): Promise<unknown> }
  readonly ui: {
    confirm(message: string): Promise<boolean>
    prompt(
      question: string,
      options?: { default?: string; secret?: boolean },
    ): Promise<string | null>
    pick<T>(options: readonly T[], settings?: { label: (value: T) => string }): Promise<T | null>
    notify(message: string, level?: 'info' | 'warn' | 'error'): void
    /**
     * /status 面板贡献（PLUGIN-STATUS-UI-r1）。需要 manifest
     * `permissions.volund` 包含 `'ui.status'`（deny-by-default）。
     */
    readonly status: {
      registerTab(spec: PluginStatusTabSpec): Disposable
      registerSection(spec: PluginStatusSectionSpec): Disposable
    }
  }
  readonly storage: {
    get<T = unknown>(key: string): Promise<T | undefined>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
  }
  readonly memory: PluginMemoryBridge
  readonly config: { get<T = unknown>(key: string): T }
  readonly log: {
    debug(message: string, meta?: object): void
    info(message: string, meta?: object): void
    warn(message: string, meta?: object): void
    error(message: string, error?: unknown, meta?: object): void
  }
  /** Low-level transport retained for sandbox hosts. Prefer the typed namespaces above. */
  call<T = unknown>(method: string, params?: unknown): Promise<T>
}
export interface VolundPlugin {
  activate(volund: VolundBridge): void | Promise<void>
  deactivate?(): void | Promise<void>
}
export const definePlugin = <T extends VolundPlugin>(plugin: T): T => plugin
export const defineTool = <T>(tool: T): T => tool
