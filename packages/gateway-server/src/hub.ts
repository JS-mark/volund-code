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
  submit(input: {
    prompt: string
    model?: string
    attachments?: readonly GatewaySubmitAttachment[]
  }): Promise<'accepted'>
  interrupt(): Promise<void>
  closeActive(): Promise<void>
  subscribe(listener: (envelope: GatewayEnvelope) => void): () => void
  decide(requestId: string, kind: string): boolean
  pendingPermissionIds(): string[]
  /**
   * 附件暂存（返回面结构对齐 @volund/shared 的 StagedAttachmentInfo）：字节以
   * base64 进站（uplink RPC 只能载 JSON），本机侧解码后进 AttachmentStore 换
   * handle。hub 不支持附件时缺省，上传端点按 gateway_unsupported_content 应答。
   */
  stageAttachment?(input: { mime: string; dataBase64: string }): Promise<GatewayStagedAttachment>
  /**
   * 附件字节回放（GET /v1/attachments/:handle；uplink RPC 只能载 JSON，字节以 base64
   * 出站，网关侧解码写二进制应答）。hub 不支持读取/handle 不存在 → undefined → 404。
   */
  readAttachment?(handle: string): Promise<GatewayAttachmentBytes | undefined>
  /** 模型清单（relay 经隧道取自本机）；缺省 = hub 不支持，/v1/models 回空列表。 */
  listModels?(): Promise<GatewayModelsView>
}

/** 附件字节（uplink 回程的 base64 载荷 + 回放用的 Content-Type）。 */
export interface GatewayAttachmentBytes {
  readonly mime: string
  readonly dataBase64: string
}

/** 已暂存附件引用（内容寻址 handle 或本机路径；字节永不进事件流/日志）。 */
export interface GatewayStagedAttachment {
  readonly kind: 'file' | 'image'
  readonly mime: string
  readonly size: number
  readonly handle?: string
  readonly path?: string
}

/** turn.submit 随 prompt 携带的附件引用（chip 为客户端输入行占位 token）。 */
export interface GatewaySubmitAttachment extends GatewayStagedAttachment {
  readonly chip: string
}

/** GET /v1/models 的条目形状（OpenAI 兼容 data 数组元素）。 */
export interface GatewayModelListing {
  readonly id: string
  readonly label?: string
}

/** 本机模型面：当前生效模型 + 可切换候选（relay 经 uplink `models.list` 取自本机）。 */
export interface GatewayModelsView {
  readonly current?: string
  readonly options: readonly GatewayModelListing[]
}
