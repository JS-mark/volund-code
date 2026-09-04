import { Context, Service } from '@cordisjs/core'
import { InMemoryProviderRegistry } from '@volund/provider-kit'

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
