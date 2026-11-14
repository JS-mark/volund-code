import { randomUUID } from 'node:crypto'

import { isBubbledEvent, type EventBus, type SessionState } from '@volund/core'

/**
 * CHECKPOINTS-r1 CP-01：会话检查点打点控制器。
 *
 * checkpoint 是纯引用事件（checkpoint.created 落会话 JSONL，SessionStore 随总线
 * 持久化），不拷贝任何内容；文件域 = BackupStore batch 链（onPrepare/onCommit
 * 钩子推进，lineage root 归属与 /undo U1 同源），对话域 = envelope turnId 锚。
 *
 * 三钩点：turn-boundary（总线 turn.started 订阅，子代理冒泡副本不算）/ pre-mutation
 * （宿主把 BackupStore.onPrepare 转发进来）/ manual（facade port，CP-05 接命令）。
 * 环形上限按「本进程已打点数」执行：到顶后停发 turn-boundary（manual/pre-mutation
 * 不受限——两者语义上不可缺）；真正的跨进程环形淘汰在列出层（CP-03+）。
 */
export interface CheckpointsConfig {
  /** turn-boundary 自动打点开关（manual/pre-mutation 不受此开关控制）。 */
  enabled: boolean
  /** 本进程打点上限；到顶停发 turn-boundary。 */
  maxPerSession: number
  /** 保留期（批 1 仅登记；消费方 = CP-03 列出层 + BackupStore retention 联动）。 */
  retentionDays: number
}

export const CHECKPOINTS_DEFAULTS: CheckpointsConfig = {
  enabled: true,
  maxPerSession: 50,
  retentionDays: 7,
}

/** 防御式解析 [checkpoints] 配置段（对齐 resolveReflectionConfig；错型回落默认）。 */
export function resolveCheckpointsConfig(section: unknown): CheckpointsConfig {
  const defaults = { ...CHECKPOINTS_DEFAULTS }
  if (!section || typeof section !== 'object' || Array.isArray(section)) return defaults
  const raw = section as Record<string, unknown>
  if (typeof raw.enabled === 'boolean') defaults.enabled = raw.enabled
  if (typeof raw.max_per_session === 'number' && raw.max_per_session > 0)
    defaults.maxPerSession = Math.floor(raw.max_per_session)
  if (typeof raw.retention_days === 'number' && raw.retention_days > 0)
    defaults.retentionDays = Math.floor(raw.retention_days)
  return defaults
}

export interface CheckpointChainState {
  /** 本进程观察到的 batch 数（= chain 长度）。 */
  count: number
  /** 最近一次提交的 BackupStore batch id（stepId）。 */
  head?: string
}

export type CheckpointTrigger = 'turn-boundary' | 'pre-mutation' | 'manual'

export class CheckpointController {
  #disposed = false
  #unsubscribes: Array<() => void> = []
  #emitted = 0
  #chain: CheckpointChainState = { count: 0 }
  readonly #options: {
    state: () => SessionState
    events: EventBus
    config: CheckpointsConfig
    logger?: { warn(message: string): void } | undefined
  }

  constructor(options: {
    state: () => SessionState
    events: EventBus
    config: CheckpointsConfig
    logger?: { warn(message: string): void } | undefined
  }) {
    this.#options = options
  }

  /** 挂总线：turn-boundary 自动打点（每用户回合一个；冒泡副本不算，附录 D.3）。 */
  attach(): void {
    this.#unsubscribes.push(
      this.#options.events.subscribe((event) => {
        if (this.#disposed || event.type !== 'turn.started' || isBubbledEvent(event)) return
        void this.create('turn-boundary', event.turnId)
      }),
    )
  }

  /**
   * 宿主转发 BackupStore.onPrepare：mutation batch 提交前打点。
   * sessionId 必须等于本会话 id（mutateFiles 按 lineage root 传——子代理的改动
   * 归根，root 控制器收得到；别家会话忽略）。
   */
  onBeforeMutation(sessionId: string, turnId?: string): void {
    if (this.#disposed || sessionId !== this.#options.state().id) return
    void this.create('pre-mutation', turnId)
  }

  /** 宿主转发 BackupStore.onCommit：batch 链推进（打点 payload 的 batchHead/batchCount 源）。 */
  noteMutationBatch(sessionId: string, batchId: string): void {
    if (this.#disposed || sessionId !== this.#options.state().id) return
    this.#chain = { count: this.#chain.count + 1, head: batchId }
  }

  chain(): CheckpointChainState {
    return this.#chain
  }

  /** 手动打点（facade port；CP-05 接 /checkpoint 命令）。返回 checkpointId。 */
  createManual(): Promise<string | undefined> {
    return this.create('manual')
  }

  /** 当前会话可回卷的打点数（列出层 CP-03 起消费；批 1 供测试/诊断）。 */
  get emittedCount(): number {
    return this.#emitted
  }

  dispose(): void {
    this.#disposed = true
    for (const unsubscribe of this.#unsubscribes.splice(0)) unsubscribe()
  }

  async create(trigger: CheckpointTrigger, turnId?: string): Promise<string | undefined> {
    if (this.#disposed) return undefined
    if (trigger === 'turn-boundary') {
      if (!this.#options.config.enabled) return undefined
      if (this.#emitted >= this.#options.config.maxPerSession) return undefined
    }
    this.#emitted++
    const checkpointId = `cp_${randomUUID()}`
    const state = this.#options.state()
    await this.#options.events.emit({
      type: 'checkpoint.created',
      version: state.version,
      sessionId: state.id,
      ...(turnId ? { turnId } : {}),
      payload: {
        checkpointId,
        trigger,
        batchCount: this.#chain.count,
        ...(this.#chain.head ? { batchHead: this.#chain.head } : {}),
      },
    })
    return checkpointId
  }
}
