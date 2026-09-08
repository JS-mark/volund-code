/**
 * 网关侧会话枢纽的结构面（apps/cli 装配时传入 @volund/web-server 的 SessionHub）。
 * 用结构类型而非直接依赖，保持 gateway-server 不反向依赖 web-server 包。
 *
 * 方法语法声明是有意的：TS 方法参数双变（bivariant），SessionHub 的
 * WebEventEnvelope 订阅签名因此结构上满足本接口，无需 adapter。
 */
export interface GatewayEnvelope {
  readonly kind: string
  readonly event: unknown
  readonly cursor?: string
  readonly sessionId?: string
}

export interface GatewayHubLike {
  readonly active: { id: string; cwd?: string } | undefined
  start(input: { cwd: string }): Promise<{ id: string }>
  resume(id: string): Promise<{ id: string }>
  submit(input: { prompt: string; model?: string }): Promise<'accepted'>
  interrupt(): Promise<void>
  closeActive(): Promise<void>
  subscribe(listener: (envelope: GatewayEnvelope) => void): () => void
  decide(requestId: string, kind: string): boolean
  pendingPermissionIds(): string[]
}
