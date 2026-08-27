import type { JsonValue } from './index'
import { sanitize } from './sanitize'

export type VolundErrorCategory =
  | 'network'
  | 'auth'
  | 'rate_limit'
  | 'quota'
  | 'invalid_request'
  | 'content_filter'
  | 'model_not_found'
  | 'server'
  | 'context_length'
  | 'stream_truncated'
  | 'protocol'
  | 'permission'
  | 'sandbox'
  | 'timeout'
  | 'cancelled'
  | 'resource_exhausted'
  | 'unknown'

export type ErrorSource =
  | { kind: 'core' }
  | { kind: 'provider'; name: string; model?: string }
  | { kind: 'tool'; name: string }
  | { kind: 'mcp'; server: string }
  | { kind: 'plugin'; name: string }
  | { kind: 'transport'; name?: string }

export interface NormalizedErrorInit {
  category: VolundErrorCategory
  code: string
  message: string
  retryable: boolean
  source: ErrorSource
  retryAfterMs?: number
  status?: number
  details?: JsonValue
  cause?: unknown
}

export class VolundNormalizedError extends Error {
  readonly category: VolundErrorCategory
  readonly code: string
  readonly retryable: boolean
  readonly source: ErrorSource
  readonly retryAfterMs: number | undefined
  readonly status: number | undefined
  readonly details: JsonValue | undefined

  constructor(init: NormalizedErrorInit) {
    super(sanitize(init.message), init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'VolundNormalizedError'
    this.category = init.category
    this.code = init.code
    this.retryable = init.retryable
    this.source = sanitize(init.source)
    this.retryAfterMs = init.retryAfterMs
    this.status = init.status
    this.details = init.details === undefined ? undefined : sanitize(init.details)
  }

  toJSON(): Record<string, JsonValue | undefined> {
    return {
      name: this.name,
      category: this.category,
      code: this.code,
      message: sanitize(this.message),
      retryable: this.retryable,
      source: sanitize(this.source) as unknown as JsonValue,
      retryAfterMs: this.retryAfterMs,
      status: this.status,
      details: this.details,
      cause: serializeCause(this.cause),
    }
  }
}

export interface NormalizeErrorOptions {
  source: ErrorSource
  category?: VolundErrorCategory
  code?: string
  retryable?: boolean
}

const statusCategory = (status?: number): VolundErrorCategory => {
  if (status === 401) return 'auth'
  if (status === 403) return 'permission'
  if (status === 404) return 'model_not_found'
  if (status === 408 || status === 504) return 'timeout'
  if (status === 413) return 'resource_exhausted'
  if (status === 429) return 'rate_limit'
  if (status !== undefined && status >= 500) return 'server'
  if (status !== undefined && status >= 400) return 'invalid_request'
  return 'unknown'
}

const retryableByDefault = (category: VolundErrorCategory): boolean =>
  ['network', 'rate_limit', 'server', 'stream_truncated', 'timeout'].includes(category)

export function normalizeError(
  input: unknown,
  options: NormalizeErrorOptions,
): VolundNormalizedError {
  if (input instanceof VolundNormalizedError) return input
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const status = typeof record.status === 'number' ? record.status : undefined
  const category = options.category ?? statusCategory(status)
  const message = typeof record.message === 'string' ? record.message : String(input)
  const details = sanitize(record) as JsonValue
  return new VolundNormalizedError({
    category,
    code: options.code ?? `volund_${category.toUpperCase()}`,
    message,
    retryable: options.retryable ?? retryableByDefault(category),
    source: options.source,
    ...(status === undefined ? {} : { status }),
    ...(typeof record.retryAfterMs === 'number' ? { retryAfterMs: record.retryAfterMs } : {}),
    details,
    cause: 'cause' in record ? record.cause : input,
  })
}

function serializeCause(cause: unknown): JsonValue | undefined {
  if (cause === undefined) return undefined
  if (cause instanceof Error) return sanitize({ name: cause.name, message: cause.message })
  return sanitize(cause) as JsonValue
}
