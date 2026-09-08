/**
 * 单 runner 串行门（volund 的 SessionController 是单活动会话模型）：
 * chat/completions 与 WS turn 共用同一把 FIFO 锁——等待超时的请求拿
 * 409 gateway_session_busy，而不是静默排队到天荒地老。
 */

export class GatewayError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}

export class TurnQueue {
  private tail: Promise<void> = Promise.resolve()

  /** FIFO 取锁；timeoutMs 内拿不到即抛 409。release 必须配对调用。 */
  async acquire(timeoutMs: number): Promise<() => void> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        previous,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new GatewayError('gateway_session_busy', 409, 'session runner is busy'))
          }, timeoutMs)
          timer.unref?.()
        }),
      ])
    } catch (error) {
      // 超时放弃：锁位仍在链上——立刻放行后继者，避免死锁。
      release()
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
    return () => {
      release()
    }
  }
}
