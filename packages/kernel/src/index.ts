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
  constructor(ctx: Context) {
    super(ctx, 'tools', true)
    this.registry = new ToolRegistry()
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
