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
  handler(args: readonly string[]): void | Promise<void>
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
  name: `apollo-plugin-${string}`
  version: string
  engines: { apollo: string }
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
    apollo: readonly string[]
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
  name: `apollo-plugin-${string}`
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
  name: `apollo-plugin-${string}`
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
} from '@apollo-code/provider-kit'
export interface ApolloBridge {
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
     * `permissions.apollo` 包含 `'ui.status'`（deny-by-default）。
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
export interface ApolloPlugin {
  activate(apollo: ApolloBridge): void | Promise<void>
  deactivate?(): void | Promise<void>
}
export const definePlugin = <T extends ApolloPlugin>(plugin: T): T => plugin
export const defineTool = <T>(tool: T): T => tool
