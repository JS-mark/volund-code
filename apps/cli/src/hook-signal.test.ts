import type { HookPipelineSignal } from '@apollo-code/plugin-runtime'
import { describe, expect, it } from 'vitest'

import { mapHookPipelineSignal } from './runtime'

describe('hook pipeline runtime observability mapping', () => {
  it('maps an oversized builtin payload to error.raised evidence and payload_rejected telemetry', () => {
    const signal: HookPipelineSignal = {
      kind: 'builtin_hook_payload_too_large',
      code: 'builtin_hook_payload_too_large',
      domain: 'builtin',
      hook: 'apollo.secret-scan',
      event: 'preToolUse',
      limitBytes: 1_048_576,
      rawBytes: 1_048_577,
      rawDigest: `sha256:${'a'.repeat(64)}`,
      scanStatus: 'not_started',
      scannedBytes: 0,
      scannedDigest: null,
      decision: 'veto',
    }
    expect(mapHookPipelineSignal(signal)).toEqual({
      error: {
        code: 'builtin_hook_payload_too_large',
        context: {
          domain: 'builtin',
          hook: 'apollo.secret-scan',
          event: 'preToolUse',
          limitBytes: 1_048_576,
          rawBytes: 1_048_577,
          rawDigest: `sha256:${'a'.repeat(64)}`,
          scanStatus: 'not_started',
          scannedBytes: 0,
          scannedDigest: null,
          decision: 'veto',
        },
      },
      warning:
        'Builtin hook payload rejected for apollo.secret-scan on preToolUse: 1048577 bytes exceeds 1048576',
      telemetry: {
        name: 'hook.payload_rejected',
        payload: {
          domain: 'builtin',
          hook: 'apollo.secret-scan',
          event: 'preToolUse',
          limitBytes: 1_048_576,
          rawBytes: 1_048_577,
          rawDigest: `sha256:${'a'.repeat(64)}`,
          scanStatus: 'not_started',
          scannedBytes: 0,
          scannedDigest: null,
          decision: 'veto',
        },
      },
    })
  })

  it('keeps builtin timeout/error and fail-open skip mappings distinct', () => {
    expect(
      mapHookPipelineSignal({
        kind: 'builtin_hook_timeout',
        code: 'builtin_hook_timeout',
        domain: 'builtin',
        hook: 'apollo.scan',
        event: 'postToolUse',
        timeoutMs: 5_000,
      }),
    ).toEqual({
      error: {
        code: 'builtin_hook_timeout',
        context: { hook: 'apollo.scan', event: 'postToolUse' },
      },
    })
    expect(
      mapHookPipelineSignal({
        kind: 'hook_skipped',
        code: 'hook_skipped',
        domain: 'plugin',
        hook: 'example.plugin',
        event: 'preToolUse',
        cause: 'error',
        message: 'boom',
      }),
    ).toEqual({
      warning: 'Hook skipped (plugin example.plugin on preToolUse, error): boom',
      telemetry: {
        name: 'hook.skipped',
        payload: {
          domain: 'plugin',
          hook: 'example.plugin',
          event: 'preToolUse',
          cause: 'error',
        },
      },
    })
  })
})
