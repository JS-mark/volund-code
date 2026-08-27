import { describe, expect, it } from 'vitest'

import { VolundNormalizedError, normalizeError } from './errors'

describe('normalized errors', () => {
  it('preserves the complete stable taxonomy', () => {
    const categories: VolundNormalizedError['category'][] = [
      'network',
      'auth',
      'rate_limit',
      'quota',
      'invalid_request',
      'content_filter',
      'model_not_found',
      'server',
      'context_length',
      'stream_truncated',
      'protocol',
      'permission',
      'sandbox',
      'timeout',
      'cancelled',
      'resource_exhausted',
      'unknown',
    ]
    expect(new Set(categories).size).toBe(17)
  })

  it('normalizes foreign errors and redacts details, message, and cause', () => {
    const error = normalizeError(
      {
        message: 'Bearer super-secret',
        status: 429,
        retryAfterMs: 250,
        apiKey: 'sk-secret',
        cause: new Error('https://user:password@example.com'),
      },
      { source: { kind: 'provider', name: 'openai' } },
    )

    expect(error).toMatchObject({ category: 'rate_limit', retryable: true, retryAfterMs: 250 })
    expect(JSON.stringify(error.toJSON())).not.toContain('super-secret')
    expect(JSON.stringify(error.toJSON())).not.toContain('sk-secret')
    expect(JSON.stringify(error.toJSON())).not.toContain('password')
  })

  it('does not expose raw causes through JSON serialization', () => {
    const cause = new Error('token=private')
    const error = new VolundNormalizedError({
      category: 'unknown',
      code: 'UNKNOWN',
      message: 'failed',
      retryable: false,
      source: { kind: 'core' },
      cause,
    })
    expect(error.cause).toBe(cause)
    expect(JSON.stringify(error)).not.toContain('private')
  })
})
