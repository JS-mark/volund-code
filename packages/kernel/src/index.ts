import { Context, Service } from '@cordisjs/core'
import type { EventBus, SessionState } from '@volund/core'
import { InMemoryProviderRegistry } from '@volund/provider-kit'
import type { NativeBridge } from '@volund/tool-kit'
import { ToolRegistry } from '@volund/tool-kit'

export { Context }

/**
 * 内核 = Cordis Context 树。第一方子系统（model/tools/sandbox/session/events/ui）
 * 逐个落成同形态的 service，第三方插件经桥把贡献注册进同一棵树——第一方与
 * 第三方没有特权差异（S0 先落 `model`，作为服务形态的样板）。
 */

/** `model` 服务：会话级模型注册表（ProviderRegistry 的 Cordis 化封装）。 */
export class ModelService extends Service {
  readonly registry: InMemoryProviderRegistry
  constructor(ctx: Context) {
    // immediate：每会话组合根创建后同步可用（cordis 默认延迟到 context start）。
    super(ctx, 'model', true)
    this.registry = new InMemoryProviderRegistry()
  }
}

declare module '@cordisjs/core' {
  interface Context {
    model: ModelService
  }
}

/** `tools` 服务：会话级工具注册表（ToolRegistry 的 Cordis 化封装）。 */
export class ToolsService extends Service {
  readonly registry: ToolRegistry
  /** 插件卸载/禁用的按域摘除句柄（plugin 名 → register 返回的注销函数集）。 */
  readonly pluginUnregisters = new Map<string, Set<() => void>>()
  constructor(ctx: Context) {
    super(ctx, 'tools', true)
    this.registry = new ToolRegistry()
  }
  /** 插件一等公民：注册插件贡献工具并登记摘除句柄（供 unregisterPlugin 批量摘除）。 */
  registerPluginTool(plugin: string, tool: Parameters<ToolRegistry['register']>[0]): () => void {
    const unregister = this.registry.register(tool, { kind: 'plugin', plugin })
    const set = this.pluginUnregisters.get(plugin) ?? new Set()
    set.add(() => {
      unregister()
      set.delete(unregister)
    })
    this.pluginUnregisters.set(plugin, set)
    return unregister
  }
  /** 插件卸载/禁用时摘除其全部贡献工具（跨会话由宿主对每个活内核调用）。 */
  unregisterPlugin(plugin: string): number {
    const set = this.pluginUnregisters.get(plugin)
    if (!set) return 0
    const count = set.size
    for (const unregister of [...set]) unregister()
    this.pluginUnregisters.delete(plugin)
    return count
  }
  /** 会话结束：清空本内核挂的全部插件贡献工具。 */
  unregisterAllPluginTools(): void {
    for (const plugin of [...this.pluginUnregisters.keys()]) this.unregisterPlugin(plugin)
  }
}

declare module '@cordisjs/core' {
  interface Context {
    tools: ToolsService
  }
}

/**
 * 既有实例挂载为 service（值在 Context 创建前已存在的场景——EventBus /
 * SessionState / NativeBridge 都由宿主管线先造出来，S1 先挂上树让消费方统一
 * 从 ctx 取；S2 起贡献收集器也走这条路径注册进同一棵树）。
 */

/** `bus` 服务：会话 EventBus（D.2 十九事件契约的载体，命名避开 cordis 自身的 ctx.events）。 */
export class BusService extends Service {
  readonly events: EventBus
  constructor(ctx: Context, events: EventBus) {
    super(ctx, 'bus', true)
    this.events = events
  }
}

/** `session` 服务：会话状态（SessionState 只读视图 + lineage）。 */
export class SessionService extends Service {
  readonly state: SessionState
  constructor(ctx: Context, state: SessionState) {
    super(ctx, 'session', true)
    this.state = state
  }
}

/** `sandbox` 服务：沙箱执行后端（NativeBridge 端口）。 */
export class SandboxService extends Service {
  readonly native: NativeBridge
  constructor(ctx: Context, native: NativeBridge) {
    super(ctx, 'sandbox', true)
    this.native = native
  }
}

declare module '@cordisjs/core' {
  interface Context {
    bus: BusService
    session: SessionService
    sandbox: SandboxService
  }
}

/**
 * `ui` 服务：面板收集器（应用级内核持有）。控制器经 registerPanel 挂上树，
 * 渲染层按 id 取用——插件面板与原生面板同一条收集路径，渲染权仍在内核。
 * 控制器类型由消费方断言（内核不依赖 @volund/ui）。
 */
export class UiService extends Service {
  /** cordis 以代理转发服务访问，私有字段（#）会因品牌检查失败——用普通属性。 */
  readonly panels = new Map<string, unknown>()
  constructor(ctx: Context) {
    super(ctx, 'ui', true)
  }
  registerPanel(id: string, controller: unknown): () => void {
    this.panels.set(id, controller)
    return () => {
      if (this.panels.get(id) === controller) this.panels.delete(id)
    }
  }
  /** 取面板控制器；未注册即抛（登记顺序错误要炸在装配期而不是渲染期）。 */
  panel<T = unknown>(id: string): T {
    const controller = this.panels.get(id)
    if (controller === undefined) throw new Error(`UI panel not registered: ${id}`)
    return controller as T
  }
  peek<T = unknown>(id: string): T | undefined {
    return this.panels.get(id) as T | undefined
  }
  ids(): string[] {
    return [...this.panels.keys()].toSorted()
  }
}

declare module '@cordisjs/core' {
  interface Context {
    ui: UiService
  }
}
