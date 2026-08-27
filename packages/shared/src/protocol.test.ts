import { describe, expect, it } from 'vitest'

import {
  VOLUND_PROTOCOL_VERSION,
  ProtocolViolationError,
  assertResourceLimits,
  createCancellationController,
  parseTransportEnvelope,
} from './protocol'

describe('transport protocol', () => {
  it('accepts a versioned JSON-RPC request envelope', () => {
    expect(
      parseTransportEnvelope({
        jsonrpc: '2.0',
        protocolVersion: VOLUND_PROTOCOL_VERSION,
        id: '1',
        method: 'tools/list',
        params: {},
        meta: { source: 'mcp', requestId: 'request-1' },
      }),
    ).toMatchObject({ method: 'tools/list', protocolVersion: 1 })
  })

  it.each([
    [{ jsonrpc: '2.0', protocolVersion: 99, id: '1', method: 'tools/list' }, 'protocol'],
    [{ jsonrpc: '2.0', protocolVersion: 1, id: '1', method: '' }, 'invalid_request'],
    [{ jsonrpc: '1.0', protocolVersion: 1, id: '1', method: 'tools/list' }, 'protocol'],
    [
      {
        jsonrpc: '2.0',
        protocolVersion: 1,
        id: '1',
        method: 'tools/list',
        params: { bad: undefined },
      },
      'invalid_request',
    ],
  ])('rejects invalid envelopes', (payload, category) => {
    expect(() => parseTransportEnvelope(payload)).toThrowError(
      expect.objectContaining({ category }),
    )
  })

  it('rejects unsupported methods when an allowlist is supplied', () => {
    expect(() =>
      parseTransportEnvelope(
        { jsonrpc: '2.0', protocolVersion: 1, id: 1, method: 'unknown' },
        { methods: ['tools/list'] },
      ),
    ).toThrowError(expect.objectContaining({ code: 'VOLUND_METHOD_NOT_FOUND' }))
  })

  it('enforces resource limits before dispatch', () => {
    expect(() => assertResourceLimits({ payloadBytes: 11 }, { maxPayloadBytes: 10 })).toThrow(
      ProtocolViolationError,
    )
  })

  it('settles cancellation races once and preserves the first reason', () => {
    const cancellation = createCancellationController()
    expect(cancellation.cancel('timeout')).toBe(true)
    expect(cancellation.cancel('caller')).toBe(false)
    expect(cancellation.signal.aborted).toBe(true)
    expect(cancellation.reason).toBe('timeout')
  })
})
