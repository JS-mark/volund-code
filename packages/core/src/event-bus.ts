import { EVENT_NAMES, EVENT_SCHEMAS, type EventName, type JsonValue } from '@volund/shared'
import { v7 as uuidv7 } from 'uuid'

/**
 * r13-I8：事件名全集唯一来源是 shared 的 EVENT_NAMES（附录 D.2 十九事件，
 * verify-event-schemas 对 §2.3 表做双向 diff）——core 侧不再手抄清单。
 */
export const eventTypes = EVENT_NAMES
export type EventType = EventName
export interface CoreEvent<T extends EventType = EventType> {
  id: string
  type: T
  version: number
  sessionId: string
  turnId?: string
  /** 附录 D.3 subagent 冒泡 tag：只在 forward 到父总线时出现，payload 不动。 */
  parentTurnId?: string
  parentDepth?: number
  payload: JsonValue
  at: number
}
export type EventListener = (event: CoreEvent) => void | Promise<void>

/** r13-I8（附录 D.1）：emit 出口的 payload 契约校验——失败即抛（内部不变量）。 */
function assertPayloadContract(type: EventType, payload: JsonValue): void {
  const schema = EVENT_SCHEMAS[type as EventName]
  if (!schema) throw new Error(`No appendix D payload schema registered for event: ${type}`)
  const result = schema.safeParse(payload)
  if (!result.success) {
    throw new Error(
      `Event payload violates appendix D contract for ${type}: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'} ${issue.message}`)
        .join('; ')}`,
    )
  }
}

export class EventBus {
  readonly #listeners = new Set<EventListener>()
  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  async emit(
    input: Omit<CoreEvent, 'at' | 'id' | 'parentTurnId' | 'parentDepth'>,
  ): Promise<CoreEvent> {
    assertPayloadContract(input.type, input.payload)
    const event: CoreEvent = { ...input, id: uuidv7(), at: Date.now() }
    await Promise.all([...this.#listeners].map((listener) => listener(event)))
    return event
  }
  /**
   * 附录 D.3 subagent 冒泡：保留原 event.id / at / payload / turnId，只在 envelope 上加
   * parentTurnId / parentDepth tag 后广播。seen-set 去重与 JSONL 重放幂等以 event.id 为键，
   * 因此绝不重新生成 id（r13-D1）。
   */
  async forward(
    event: CoreEvent,
    tags: { parentTurnId: string; parentDepth: number },
  ): Promise<CoreEvent> {
    assertPayloadContract(event.type, event.payload)
    const bubbled: CoreEvent = {
      ...event,
      parentTurnId: tags.parentTurnId,
      parentDepth: tags.parentDepth,
    }
    await Promise.all([...this.#listeners].map((listener) => listener(bubbled)))
    return bubbled
  }
}

export function idempotentSubscriber(listener: EventListener, capacity = 10_000): EventListener {
  const seen = new Map<string, true>()
  return async (event) => {
    if (seen.has(event.id)) return
    seen.set(event.id, true)
    if (seen.size > capacity) seen.delete(seen.keys().next().value!)
    await listener(event)
  }
}
