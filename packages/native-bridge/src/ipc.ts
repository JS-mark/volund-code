import type { Readable, Writable } from 'node:stream'

interface Deferred {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

/** Structural telemetry port (spec §5.6.2 r13-I6); satisfied by `@volund/telemetry` Telemetry. */
export interface IpcTelemetry {
  emit(name: string, source: string, payload: Record<string, unknown>): Promise<void> | void
}
export interface RpcPeerOptions {
  /** NDJSON single-line byte cap; lines at or below the cap are processed, larger lines are rejected. Default 4 MiB. */
  maxLineBytes?: number | undefined
  telemetry?: IpcTelemetry | undefined
}
/** Default `max_line_bytes` per spec §5.6.2 r13-I6 (4 MiB). Configurable via `[native] ipc_max_line_bytes`. */
export const DEFAULT_IPC_MAX_LINE_BYTES = 4 * 1024 * 1024

const NEWLINE = 0x0a
const EMPTY = Buffer.alloc(0)
const ID_IN_HEAD = /"id"\s*:\s*(-?\d+)/

export class RpcPeer {
  private readonly pending = new Map<number, Deferred>()
  private readonly notifications = new Map<string, Array<(params: unknown) => void>>()
  private nextId = 1
  private readonly maxLineBytes: number
  private readonly telemetry: IpcTelemetry | undefined
  private buffer: Buffer = EMPTY
  private discarding = false
  private discardedBytes = 0

  constructor(
    input: Readable,
    private readonly output: Writable,
    options: RpcPeerOptions = {},
  ) {
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_IPC_MAX_LINE_BYTES
    this.telemetry = options.telemetry
    input.on('data', (chunk: string | Buffer) =>
      this.onData(typeof chunk === 'string' ? Buffer.from(chunk) : chunk),
    )
  }

  request(method: string, params: unknown): Promise<unknown> {
    return this.requestWithId(this.nextId++, method, params)
  }

  notification(method: string): Promise<unknown> {
    return new Promise((resolve) =>
      this.notifications.set(method, [...(this.notifications.get(method) ?? []), resolve]),
    )
  }

  requestWithId(id: number, method: string, params: unknown): Promise<unknown> {
    const result = new Promise<unknown>((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    )
    this.output.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return result
  }

  close(reason = new Error('worker closed')): void {
    for (const deferred of this.pending.values()) deferred.reject(reason)
    this.pending.clear()
  }

  private onData(chunk: Buffer): void {
    let rest = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    this.buffer = EMPTY
    for (;;) {
      const newline = rest.indexOf(NEWLINE)
      if (this.discarding) {
        if (newline === -1) {
          this.discardedBytes += rest.length
          return
        }
        this.discardedBytes += newline
        this.reportLineTooLarge(this.discardedBytes)
        this.discarding = false
        rest = rest.subarray(newline + 1)
        continue
      }
      if (newline === -1) {
        if (rest.length > this.maxLineBytes) {
          // Oversized line detected before its newline: reject the RPC now, then drop the
          // buffered bytes so an unbounded line can never accumulate in memory.
          this.rejectOversizedHead(rest)
          this.discarding = true
          this.discardedBytes = rest.length
          return
        }
        this.buffer = rest
        return
      }
      const line = rest.subarray(0, newline)
      if (line.length > this.maxLineBytes) {
        this.rejectOversizedHead(line)
        this.reportLineTooLarge(line.length)
      } else if (line.length > 0) {
        this.handleLine(line)
      }
      rest = rest.subarray(newline + 1)
    }
  }

  private handleLine(line: Buffer): void {
    let frame: {
      id?: number
      method?: string
      params?: unknown
      result?: unknown
      error?: { message?: string }
    }
    try {
      frame = JSON.parse(line.toString('utf8')) as typeof frame
    } catch {
      return
    }
    if (frame.method) {
      for (const listener of this.notifications.get(frame.method) ?? []) listener(frame.params)
      this.notifications.delete(frame.method)
    }
    if (typeof frame.id !== 'number') return
    const deferred = this.pending.get(frame.id)
    if (!deferred) return
    this.pending.delete(frame.id)
    if (frame.error) deferred.reject(new Error(frame.error.message ?? 'worker RPC failed'))
    else deferred.resolve(frame.result)
  }

  /** Reply -32600 (invalid request) for an oversized line: error response when its id is recoverable from the head, otherwise an error notification. */
  private rejectOversizedHead(head: Buffer): void {
    const match = ID_IN_HEAD.exec(head.subarray(0, 4096).toString('utf8'))
    const error = {
      code: -32600,
      message: `ipc line exceeds max_line_bytes (${this.maxLineBytes} bytes)`,
    }
    const frame = match
      ? { jsonrpc: '2.0' as const, id: Number(match[1]), error }
      : { jsonrpc: '2.0' as const, error }
    this.output.write(`${JSON.stringify(frame)}\n`)
  }

  private reportLineTooLarge(bytes: number): void {
    void this.telemetry?.emit('ipc.line_too_large', 'ipc', {
      bytes,
      max_line_bytes: this.maxLineBytes,
    })
  }
}
