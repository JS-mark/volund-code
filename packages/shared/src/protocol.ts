import { VolundNormalizedError } from './errors'
import type { JsonValue } from './index'

export const VOLUND_PROTOCOL_VERSION = 1 as const
export type VolundProtocolVersion = typeof VOLUND_PROTOCOL_VERSION
export type RequestId = number | string

export interface TransportMeta {
  source: 'core' | 'mcp' | 'plugin' | 'provider' | 'tool'
  requestId?: string
  traceId?: string
  deadlineMs?: number
  budget?: ResourceLimits
}

export interface ResourceLimits {
  maxPayloadBytes?: number
  maxOutputBytes?: number
  maxDurationMs?: number
  maxOperations?: number
  maxDepth?: number
}

export interface ResourceUsage {
  payloadBytes?: number
  outputBytes?: number
  durationMs?: number
  operations?: number
  depth?: number
}

export type TransportEnvelope =
  | {
      jsonrpc: '2.0'
      protocolVersion: VolundProtocolVersion
      id: RequestId
      method: string
      params?: JsonValue
      meta?: TransportMeta
    }
  | {
      jsonrpc: '2.0'
      protocolVersion: VolundProtocolVersion
      method: string
      params?: JsonValue
      meta?: TransportMeta
    }
  | {
      jsonrpc: '2.0'
      protocolVersion: VolundProtocolVersion
      id: RequestId
      result: JsonValue
      meta?: TransportMeta
    }
  | {
      jsonrpc: '2.0'
      protocolVersion: VolundProtocolVersion
      id: RequestId | null
      error: TransportError
      meta?: TransportMeta
    }

export interface TransportError {
  code: string
  message: string
  data?: JsonValue
}

export class ProtocolViolationError extends VolundNormalizedError {
  constructor(
    code: string,
    message: string,
    category: 'invalid_request' | 'protocol' | 'resource_exhausted' = 'protocol',
  ) {
    super({ category, code, message, retryable: false, source: { kind: 'transport' } })
    this.name = 'ProtocolViolationError'
  }
}

export function parseTransportEnvelope(
  input: unknown,
  options: { methods?: readonly string[] } = {},
): TransportEnvelope {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ProtocolViolationError(
      'VOLUND_INVALID_REQUEST',
      'Envelope must be an object',
      'invalid_request',
    )
  const value = input as Record<string, unknown>
  if (value.jsonrpc !== '2.0')
    throw new ProtocolViolationError('VOLUND_PROTOCOL_INVALID', 'Only JSON-RPC 2.0 is supported')
  if (value.protocolVersion !== VOLUND_PROTOCOL_VERSION)
    throw new ProtocolViolationError(
      'VOLUND_UNSUPPORTED_VERSION',
      `Unsupported protocol version: ${String(value.protocolVersion)}`,
    )
  const hasMethod = 'method' in value
  const hasResult = 'result' in value
  const hasError = 'error' in value
  if ([hasMethod, hasResult, hasError].filter(Boolean).length !== 1)
    throw new ProtocolViolationError(
      'VOLUND_INVALID_REQUEST',
      'Envelope must contain exactly one of method, result, or error',
      'invalid_request',
    )
  if (hasMethod && (typeof value.method !== 'string' || value.method.length === 0))
    throw new ProtocolViolationError(
      'VOLUND_INVALID_REQUEST',
      'Method must be a non-empty string',
      'invalid_request',
    )
  if (hasMethod && options.methods && !options.methods.includes(value.method as string))
    throw new ProtocolViolationError(
      'VOLUND_METHOD_NOT_FOUND',
      `Unsupported method: ${String(value.method)}`,
    )
  if (!hasMethod && !('id' in value))
    throw new ProtocolViolationError(
      'VOLUND_INVALID_REQUEST',
      'Responses require an id',
      'invalid_request',
    )
  if (
    'id' in value &&
    value.id !== null &&
    typeof value.id !== 'string' &&
    typeof value.id !== 'number'
  )
    throw new ProtocolViolationError(
      'VOLUND_INVALID_REQUEST',
      'Id must be a string, number, or null',
      'invalid_request',
    )
  for (const key of ['params', 'result', 'error', 'meta'] as const)
    if (key in value && !isJsonValue(value[key]))
      throw new ProtocolViolationError(
        'VOLUND_INVALID_REQUEST',
        `${key} must be JSON-compatible`,
        'invalid_request',
      )
  return value as unknown as TransportEnvelope
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): value is JsonValue {
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value))
    return typeof value !== 'number' || Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen))
  return (
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, seen))
  )
}

export function assertResourceLimits(usage: ResourceUsage, limits: ResourceLimits): void {
  const checks: Array<[keyof ResourceUsage, keyof ResourceLimits]> = [
    ['payloadBytes', 'maxPayloadBytes'],
    ['outputBytes', 'maxOutputBytes'],
    ['durationMs', 'maxDurationMs'],
    ['operations', 'maxOperations'],
    ['depth', 'maxDepth'],
  ]
  for (const [usageKey, limitKey] of checks) {
    const used = usage[usageKey]
    const limit = limits[limitKey]
    if (used !== undefined && limit !== undefined && used > limit)
      throw new ProtocolViolationError(
        'VOLUND_RESOURCE_EXHAUSTED',
        `${usageKey} exceeds ${limitKey}`,
        'resource_exhausted',
      )
  }
}

export type CancellationReason = 'caller' | 'shutdown' | 'timeout' | 'budget' | 'dependency'
export interface CancellationController {
  readonly signal: AbortSignal
  readonly reason: CancellationReason | undefined
  cancel(reason: CancellationReason): boolean
}

export function createCancellationController(): CancellationController {
  const controller = new AbortController()
  let reason: CancellationReason | undefined
  return {
    signal: controller.signal,
    get reason() {
      return reason
    },
    cancel(nextReason) {
      if (controller.signal.aborted) return false
      reason = nextReason
      controller.abort(nextReason)
      return true
    },
  }
}
