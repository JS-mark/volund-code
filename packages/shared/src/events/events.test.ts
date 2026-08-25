import { describe, expect, it } from 'vitest'

import { contextCompactedPayloadSchema } from './context-compacted'
import { EVENT_NAMES, eventEnvelopeSchema, uuidV7Schema } from './envelope'
import { errorRaisedPayloadSchema } from './error-raised'
import { EVENT_SCHEMAS, eventEnvelopeFor } from './index'
import { messageAppendedPayloadSchema } from './message-appended'
import { routerSwitchedPayloadSchema } from './router-switched'
import { sessionEndedPayloadSchema } from './session-ended'
import { sessionResumedPayloadSchema } from './session-resumed'
import { sessionStartedPayloadSchema } from './session-started'
import { shellBackgroundExitedPayloadSchema } from './shell-background_exited'
import { shellBackgroundStartedPayloadSchema } from './shell-background_started'
import { streamCompletedPayloadSchema } from './stream-completed'
import { streamDeltaPayloadSchema } from './stream-delta'
import { streamStartedPayloadSchema } from './stream-started'
import { toolCompletedPayloadSchema } from './tool-completed'
import { toolPermissionAskedPayloadSchema } from './tool-permission_asked'
import { toolRequestedPayloadSchema } from './tool-requested'
import { toolStartedPayloadSchema } from './tool-started'
import { turnAbortedPayloadSchema } from './turn-aborted'
import { turnCompletedPayloadSchema } from './turn-completed'
import { turnStartedPayloadSchema } from './turn-started'

describe('EVENT_SCHEMAS registry (附录 D.2)', () => {
  it('registers exactly the 25 §2.3 event names', () => {
    expect(Object.keys(EVENT_SCHEMAS).sort()).toEqual([...EVENT_NAMES].sort())
    expect(EVENT_NAMES).toHaveLength(25)
  })

  it('pairs every envelope type with its payload contract via eventEnvelopeFor', () => {
    for (const name of EVENT_NAMES) {
      const envelope = eventEnvelopeFor(name).parse({
        id: '0195e4a1-0000-7000-8000-000000000001',
        type: name,
        version: 1,
        sessionId: 'session-1',
        at: 1_755_000_000_000,
        payload: payloadFixture(name),
      })
      expect(envelope.type).toBe(name)
    }
  })
})

describe('envelope (附录 D.1)', () => {
  const envelope = {
    id: '0195e4a1-0000-7000-8000-000000000001',
    type: 'session.started',
    version: 1,
    sessionId: 'session-1',
    at: 1_755_000_000_000,
    payload: { cwd: '/tmp' },
  } as const

  it('accepts the shared envelope shape with optional turnId', () => {
    expect(eventEnvelopeSchema.parse(envelope)).toBeTruthy()
    expect(eventEnvelopeSchema.parse({ ...envelope, turnId: 'turn-1' })).toBeTruthy()
  })

  it('rejects non-UUIDv7 ids (W9: event.id is the seen-set dedup key)', () => {
    expect(uuidV7Schema.safeParse('not-a-uuid').success).toBe(false)
    // UUIDv4 lacks the version-7 nibble.
    expect(
      eventEnvelopeSchema.safeParse({
        ...envelope,
        id: 'b8bec136-e98a-4c66-a3c3-1d0f9b5f6a90',
      }).success,
    ).toBe(false)
  })

  it('rejects event types outside the §2.3 table and unknown envelope fields', () => {
    expect(eventEnvelopeSchema.safeParse({ ...envelope, type: 'session.snapshot' }).success).toBe(
      false,
    )
    expect(eventEnvelopeSchema.safeParse({ ...envelope, extra: true }).success).toBe(false)
  })

  it('accepts appendix D.3 subagent bubbling tags on the envelope (payload untouched)', () => {
    expect(
      eventEnvelopeSchema.parse({
        ...envelope,
        parentTurnId: 'parent-turn-1',
        parentDepth: 1,
      }),
    ).toMatchObject({ parentTurnId: 'parent-turn-1', parentDepth: 1 })
    // D.3：冒泡 tag 只有 parentTurnId/parentDepth，其余未知 envelope 字段仍拒绝。
    expect(eventEnvelopeSchema.safeParse({ ...envelope, isSubagent: true }).success).toBe(false)
  })
})

describe('per-event payload schemas', () => {
  it('session.started: cwd required, configHash/apolloVersion optional', () => {
    expect(sessionStartedPayloadSchema.parse({ cwd: '/repo' })).toEqual({ cwd: '/repo' })
    expect(
      sessionStartedPayloadSchema.parse({
        cwd: '/repo',
        configHash: 'abc123',
        apolloVersion: '0.1.0',
      }),
    ).toBeTruthy()
    expect(sessionStartedPayloadSchema.safeParse({}).success).toBe(false)
  })

  it('session.ended: reason enum required, exitCode optional', () => {
    expect(sessionEndedPayloadSchema.parse({ reason: 'exit', exitCode: 0 })).toBeTruthy()
    expect(sessionEndedPayloadSchema.parse({ reason: 'signal' })).toBeTruthy()
    expect(sessionEndedPayloadSchema.safeParse({}).success).toBe(false)
    expect(sessionEndedPayloadSchema.safeParse({ reason: 'crashed' }).success).toBe(false)
  })

  it('session.resumed: tailTurns and skippedTurns both required (W10)', () => {
    expect(sessionResumedPayloadSchema.parse({ tailTurns: 20, skippedTurns: 3 })).toBeTruthy()
    expect(sessionResumedPayloadSchema.safeParse({ tailTurns: 20 }).success).toBe(false)
  })

  it('turn.started: turnId required; parentTurnId/agentType optional', () => {
    expect(turnStartedPayloadSchema.parse({ turnId: 't1' })).toBeTruthy()
    expect(
      turnStartedPayloadSchema.parse({ turnId: 't1', parentTurnId: 't0', agentType: 'planner' }),
    ).toBeTruthy()
    expect(turnStartedPayloadSchema.safeParse({}).success).toBe(false)
  })

  it('turn.completed: turnId + usage required, stopReason optional', () => {
    expect(
      turnCompletedPayloadSchema.parse({
        turnId: 't1',
        usage: { input: 100, output: 20, costUSD: 0.01 },
        stopReason: 'end_turn',
      }),
    ).toBeTruthy()
    expect(turnCompletedPayloadSchema.safeParse({ turnId: 't1' }).success).toBe(false)
    expect(
      turnCompletedPayloadSchema.safeParse({ turnId: 't1', usage: { input: -1, output: 0 } })
        .success,
    ).toBe(false)
  })

  it('turn.aborted: reason restricted to the §2.3 enum', () => {
    expect(turnAbortedPayloadSchema.parse({ turnId: 't1', reason: 'user_interrupt' })).toBeTruthy()
    expect(turnAbortedPayloadSchema.safeParse({ turnId: 't1', reason: 'timeout' }).success).toBe(
      false,
    )
  })

  it('message.appended: role + reference-style content; inline binary rejected', () => {
    expect(
      messageAppendedPayloadSchema.parse({
        messageId: 'm1',
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', source: { kind: 'handle', handle: 'att-1' }, mime: 'image/png' },
          {
            type: 'tool_result',
            toolUseId: 'tu1',
            content: [{ type: 'text', text: 'nested' }],
            isError: true,
          },
        ],
      }),
    ).toBeTruthy()
    expect(messageAppendedPayloadSchema.safeParse({ messageId: 'm1' }).success).toBe(false)
    // 附录 D.1：附件二进制不进事件，只传引用——inline bytes 违规。
    expect(
      messageAppendedPayloadSchema.safeParse({
        messageId: 'm1',
        role: 'user',
        content: [
          {
            type: 'image',
            source: { kind: 'inline', bytes: new Uint8Array([1]) },
            mime: 'image/png',
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('stream.started: messageId required, provider/model optional', () => {
    expect(streamStartedPayloadSchema.parse({ messageId: 'm1', provider: 'openai' })).toBeTruthy()
    expect(streamStartedPayloadSchema.safeParse({ provider: 'openai' }).success).toBe(false)
  })

  it('stream.delta: only incremental fragments — whole-chunk payloads rejected', () => {
    expect(
      streamDeltaPayloadSchema.parse({ messageId: 'm1', kind: 'text', fragment: 'Hel' }),
    ).toBeTruthy()
    expect(
      streamDeltaPayloadSchema.parse({
        messageId: 'm1',
        kind: 'tool_use',
        fragment: '{"command":',
      }),
    ).toBeTruthy()
    // 附录 D 明示违规形状：delta 塞整 chunk。
    expect(
      streamDeltaPayloadSchema.safeParse({ chunk: { kind: 'text.delta', text: 'Hel' } }).success,
    ).toBe(false)
    expect(streamDeltaPayloadSchema.safeParse({ messageId: 'm1', kind: 'usage' }).success).toBe(
      false,
    )
    // fragment 是增量片段，不是累积全文——但 string 类型上无法区分，仅锁定形状。
    expect(streamDeltaPayloadSchema.safeParse({ messageId: 'm1', kind: 'text' }).success).toBe(
      false,
    )
  })

  it('stream.completed: messageId required, usage optional', () => {
    expect(streamCompletedPayloadSchema.parse({ messageId: 'm1' })).toBeTruthy()
    expect(
      streamCompletedPayloadSchema.parse({ messageId: 'm1', usage: { input: 1, output: 2 } }),
    ).toBeTruthy()
    expect(streamCompletedPayloadSchema.safeParse({}).success).toBe(false)
  })

  it('tool.requested: toolUseId/tool/input required', () => {
    expect(
      toolRequestedPayloadSchema.parse({
        toolUseId: 'tu1',
        tool: 'bash',
        input: { command: 'ls' },
      }),
    ).toBeTruthy()
    expect(toolRequestedPayloadSchema.safeParse({ toolUseId: 'tu1', tool: 'bash' }).success).toBe(
      false,
    )
  })

  it('tool.permission_asked: PermissionSpec summary shape', () => {
    expect(
      toolPermissionAskedPayloadSchema.parse({
        toolUseId: 'tu1',
        tool: 'bash',
        spec: { bash: { command: 'rm -rf /tmp/x' } },
      }),
    ).toBeTruthy()
    expect(
      toolPermissionAskedPayloadSchema.parse({
        toolUseId: 'tu1',
        tool: 'net.fetch',
        spec: { net: { url: 'https://example.com', method: 'GET' } },
      }),
    ).toBeTruthy()
    expect(
      toolPermissionAskedPayloadSchema.safeParse({ toolUseId: 'tu1', tool: 'bash' }).success,
    ).toBe(false)
    expect(
      toolPermissionAskedPayloadSchema.safeParse({
        toolUseId: 'tu1',
        tool: 'net.fetch',
        spec: { net: { url: 'https://example.com', method: 'TRACE' } },
      }).success,
    ).toBe(false)
  })

  it('tool.started: only toolUseId + tool', () => {
    expect(toolStartedPayloadSchema.parse({ toolUseId: 'tu1', tool: 'bash' })).toBeTruthy()
    // 实现漂移形状（toolName + input）不得通过契约。
    expect(
      toolStartedPayloadSchema.safeParse({
        toolUseId: 'tu1',
        toolName: 'bash',
        input: {},
      }).success,
    ).toBe(false)
  })

  it('tool.completed: isError required; blockedBy limited to hook', () => {
    expect(
      toolCompletedPayloadSchema.parse({
        toolUseId: 'tu1',
        tool: 'bash',
        isError: false,
        durationMs: 120,
        blocked: true,
        blockedBy: 'hook',
      }),
    ).toBeTruthy()
    expect(toolCompletedPayloadSchema.safeParse({ toolUseId: 'tu1', tool: 'bash' }).success).toBe(
      false,
    )
    expect(
      toolCompletedPayloadSchema.safeParse({
        toolUseId: 'tu1',
        tool: 'bash',
        isError: false,
        blockedBy: 'policy',
      }).success,
    ).toBe(false)
  })

  it('tool.completed: optional linesAdded/linesRemoved for file-mutating tools', () => {
    expect(
      toolCompletedPayloadSchema.parse({
        toolUseId: 'tu1',
        tool: 'Edit',
        isError: false,
        durationMs: 12,
        linesAdded: 5,
        linesRemoved: 3,
      }),
    ).toMatchObject({ linesAdded: 5, linesRemoved: 3 })
    expect(
      toolCompletedPayloadSchema.safeParse({
        toolUseId: 'tu1',
        tool: 'Edit',
        isError: false,
        linesAdded: -1,
      }).success,
    ).toBe(false)
  })

  it('shell.background_started / background_exited (r13-G2)', () => {
    expect(
      shellBackgroundStartedPayloadSchema.parse({
        shellId: 'sh1',
        command: 'npm run watch',
        cwd: '/repo',
      }),
    ).toBeTruthy()
    expect(
      shellBackgroundStartedPayloadSchema.safeParse({ shellId: 'sh1', command: 'npm run watch' })
        .success,
    ).toBe(false)
    expect(
      shellBackgroundExitedPayloadSchema.parse({
        shellId: 'sh1',
        exitCode: 0,
        reason: 'exit',
        droppedBytes: 0,
      }),
    ).toBeTruthy()
    expect(
      shellBackgroundExitedPayloadSchema.parse({ shellId: 'sh1', exitCode: 137, reason: 'killed' }),
    ).toBeTruthy()
    expect(
      shellBackgroundExitedPayloadSchema.safeParse({ shellId: 'sh1', reason: 'exit' }).success,
    ).toBe(false)
    expect(
      shellBackgroundExitedPayloadSchema.safeParse({
        shellId: 'sh1',
        exitCode: 1,
        reason: 'oom',
      }).success,
    ).toBe(false)
  })

  it('context.compacted: before/after token counts required', () => {
    expect(
      contextCompactedPayloadSchema.parse({
        before: 100_000,
        after: 12_000,
        strategy: 'summarize',
        removedMessageIds: ['m1', 'm2'],
      }),
    ).toBeTruthy()
    expect(contextCompactedPayloadSchema.safeParse({ strategy: 'summarize' }).success).toBe(false)
  })

  it('router.switched: from + reason required, to optional', () => {
    expect(routerSwitchedPayloadSchema.parse({ from: 'openai', reason: 'rate_limit' })).toBeTruthy()
    expect(
      routerSwitchedPayloadSchema.parse({ from: 'openai', to: 'anthropic', reason: 'error' }),
    ).toBeTruthy()
    expect(routerSwitchedPayloadSchema.safeParse({ from: 'openai' }).success).toBe(false)
  })

  it('error.raised: code is a registry string; context is a record', () => {
    expect(errorRaisedPayloadSchema.parse({ code: 'provider_request_failed' })).toBeTruthy()
    expect(
      errorRaisedPayloadSchema.parse({
        code: 'APOLLO_SUBAGENT_DEPTH_EXCEEDED',
        category: 'resource_exhausted',
        context: { depth: 4, max: 3 },
      }),
    ).toBeTruthy()
    expect(
      errorRaisedPayloadSchema.parse({
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
      }),
    ).toBeTruthy()
    // code 必须是 string（附录 B registry 键），不是 enum/number。
    expect(errorRaisedPayloadSchema.safeParse({ code: 42 }).success).toBe(false)
    expect(errorRaisedPayloadSchema.safeParse({}).success).toBe(false)
    expect(errorRaisedPayloadSchema.safeParse({ code: 'x', context: 'not-a-record' }).success).toBe(
      false,
    )
  })
})

/** 每事件一个最小合法 payload（eventEnvelopeFor 全量校验用）。 */
function payloadFixture(name: (typeof EVENT_NAMES)[number]): unknown {
  const fixtures = {
    'session.started': { cwd: '/repo' },
    'session.ended': { reason: 'exit' },
    'session.resumed': { tailTurns: 20, skippedTurns: 0 },
    'turn.started': { turnId: 't1' },
    'turn.completed': { turnId: 't1', usage: { input: 1, output: 1 } },
    'turn.aborted': { turnId: 't1', reason: 'user_interrupt' },
    'message.appended': { messageId: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }] },
    'stream.started': { messageId: 'm1' },
    'stream.delta': { messageId: 'm1', kind: 'text', fragment: 'hi' },
    'stream.completed': { messageId: 'm1' },
    'tool.requested': { toolUseId: 'tu1', tool: 'bash', input: {} },
    'tool.permission_asked': { toolUseId: 'tu1', tool: 'bash', spec: {} },
    'tool.started': { toolUseId: 'tu1', tool: 'bash' },
    'tool.completed': { toolUseId: 'tu1', tool: 'bash', isError: false },
    'shell.background_started': { shellId: 'sh1', command: 'watch', cwd: '/repo' },
    'shell.background_exited': { shellId: 'sh1', exitCode: 0 },
    'context.compacted': { before: 10, after: 5 },
    'router.switched': { from: 'openai', reason: 'error' },
    'error.raised': { code: 'unknown' },
    'reflection.scheduled': { trigger: 'on_error', turnId: 't1' },
    'reflection.started': { runId: 'r1', trigger: 'on_error' },
    'reflection.completed': {
      runId: 'r1',
      usage: { input: 1, output: 1 },
      lessonCount: 1,
      durationMs: 10,
    },
    'reflection.failed': { runId: 'r1', code: 'reflection_output_invalid' },
    'reflection.skipped': { reason: 'budget_exhausted' },
    'reflection.promoted': { lessonId: 'l1', memoryId: 'm1', scope: 'project' },
  } as const
  return fixtures[name]
}
