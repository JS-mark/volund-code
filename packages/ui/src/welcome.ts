export interface UnavailableReason {
  code: string
  message: string
}

export interface WelcomePanelData {
  authMethod?: string
  config: WelcomeConfigStatus
  cwd: string
  history: WelcomeHistoryStatus
  mcp: WelcomeMcpStatus
  model: WelcomeModelStatus
  /** 欢迎屏 "Native modules"：native-bridge 三个探针的加载状态；缺省渲染 probing。 */
  native?: WelcomeNativeStatus
  permission: WelcomePermissionStatus
  sandbox: WelcomeSandboxStatus
  sessionId: string
  trustLabel?: string
  version: string
  liteModel?: string
  reasoningModel?: string
  memoryMode?: string
  workspace?: string
  skillsSummary?: string
  pluginsSummary?: string
  statusConfig?: import('./status').StatusPanelData['config']
}

export type WelcomeModelStatus =
  | {
      status: 'available'
      provider: string
      model: string
      source: 'config' | 'default' | 'explicit' | 'session'
    }
  | {
      status: 'unavailable'
      reason: UnavailableReason
    }
  | {
      status: 'unknown'
      reason?: UnavailableReason
    }

export type WelcomeSandboxStatus =
  | {
      status: 'available'
      tier: 'full' | 'none' | 'partial' | 'weak'
      mechanism: string
      filesystem: 'isolated' | 'unknown' | 'unrestricted' | 'workspace'
      network: 'available' | 'restricted' | 'unavailable' | 'unknown'
    }
  | {
      /** r13-P1: native probing still in flight; the result backfills asynchronously. */
      status: 'probing'
    }
  | {
      status: 'unavailable'
      reason: UnavailableReason
    }

export interface WelcomePermissionStatus {
  dangerous: boolean
  mode: 'ask' | 'auto' | 'full'
  source: 'config' | 'default' | 'flag' | 'session'
}

/** r13-P1 探针三态：probing 表示启动探针尚未回填。 */
export type NativeModuleStatus = 'probing' | 'loaded' | 'unavailable'

export interface WelcomeNativeStatus {
  /** 随探针快照携带但不渲染成行：sandbox 加载结果由底行 mechanism/tier 呈现。 */
  fs: NativeModuleStatus
  sandbox: NativeModuleStatus
  search: NativeModuleStatus
}

export interface WelcomeConfigStatus {
  effectiveSources: readonly ConfigSourceKind[]
  project: ConfigSourceStatus
  user: ConfigSourceStatus
}

export type ConfigSourceKind = 'defaults' | 'project' | 'user'

export type ConfigSourceStatus =
  | {
      status: 'available'
      path: string
      trusted: true
    }
  | {
      status: 'blocked'
      path: string
      trusted: false
      reason: UnavailableReason
    }
  | {
      status: 'disabled'
      reason?: UnavailableReason
    }
  | {
      status: 'unavailable'
      reason: UnavailableReason
    }

export type WelcomeMcpStatus =
  | {
      status: 'available'
      connected: number
      servers: readonly WelcomeMcpServerSummary[]
      total: number
    }
  | {
      status: 'disabled'
      reason?: UnavailableReason
    }
  | {
      status: 'unavailable'
      reason: UnavailableReason
    }

export interface WelcomeMcpServerSummary {
  name: string
  status: 'connected' | 'disabled' | 'failed'
}

export type WelcomeHistoryStatus =
  | {
      status: 'available'
      entries: number
      maxEntries: number
      path: string
    }
  | {
      status: 'disabled'
      reason?: UnavailableReason
    }
  | {
      status: 'unavailable'
      reason: UnavailableReason
    }
