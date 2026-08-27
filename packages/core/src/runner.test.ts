import type { ContextPolicy, ProviderChunk, ProviderClient } from '@volund/provider-kit'
import type { RouterPolicy } from '@volund/router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EventBus } from './event-bus'
import { DefaultPromptComposer } from './prompt-composer'
import { messagesForCapabilities, Runner } from './runner'
import { createSession } from './session'

function provider(streams: ProviderChunk[][], name = 'p'): ProviderClient {
  return {
    name,
    capabilities: {
      maxContextTokens: 1,
      maxOutputTokens: 1,
      toolUse: 'parallel',
      toolResultSchema: 'anthropic',
      vision: false,
      files: false,
      thinking: false,
      streaming: true,
      streamingReasoning: false,
      cache: 'none',
      jsonMode: false,
      structuredOutput: false,
      systemPromptLocation: 'system-field',
      toolChoiceRequired: false,
      interleavedThinking: false,
    },
    async *stream(_request, signal) {
      const chunks = streams.shift() ?? []
      for (const chunk of chunks) {
        if (signal.aborted) return
        yield chunk
      }
    },
    async dispose() {},
  }
}
const context = () =>
  createSession({ id: 's', cwd: '/repo', maxTokens: 100, toolRegistrySnapshot: '' })
const tools = {
  schemas: () => [],
  execute: vi.fn(async (tool) => ({
    toolUseId: tool.id,
    content: [{ type: 'text' as const, text: 'ok' }],
  })),
}
const composer = new DefaultPromptComposer()
composer.register({ id: 'x', source: 'builtin', priority: 1000, text: 'system' })
function router(
  client: ProviderClient,
  onError: RouterPolicy['onError'] = async () => 'give-up',
): RouterPolicy {
  return {
    name: 'r',
    pick: vi.fn(async () => ({ provider: client, model: 'm', reason: 'test' })),
    onError,
  }
}

describe('Runner', () => {
  it('accepts referenced images and degrades them for providers without vision', () => {
    const messages = [
      {
        id: 'u',
        role: 'user' as const,
        createdAt: 0,
        content: [
          {
            type: 'image' as const,
            mime: 'image/png',
            source: { kind: 'handle' as const, handle: 'h' },
          },
        ],
      },
    ]
    const mapped = messagesForCapabilities(messages, 'text-only', {
      ...provider([]).capabilities,
      vision: false,
    })
    expect(mapped[0]?.content).toEqual([
      {
        type: 'text',
        text: '[Attachment omitted: provider text-only does not support vision (image/png)]',
      },
    ])
  })
  beforeEach(() => {
    tools.execute.mockClear()
  })
  it('limits tool loops to 25', async () => {
    const toolStream: ProviderChunk[] = [
      { kind: 'tool_use.start', id: 'id', name: 'x' },
      { kind: 'tool_use.delta', id: 'id', argsFragment: '{}' },
      { kind: 'tool_use.end', id: 'id' },
      { kind: 'message.stop', stopReason: 'tool_use' },
    ]
    const client = provider(Array.from({ length: 25 }, () => toolStream))
    const events: string[] = []
    const bus = new EventBus()
    bus.subscribe((event) => {
      if (event.type === 'error.raised') events.push((event.payload as { code: string }).code)
    })
    await new Runner(context(), router(client), composer, tools, bus).run('hi')
    expect(tools.execute).toHaveBeenCalledTimes(25)
    expect(events).toContain('tool_loop_exhausted')
  })
  it('enforces a subagent token budget between loops and preserves partial output', async () => {
    const client = provider([
      [
        { kind: 'text.delta', text: 'partial answer' },
        { kind: 'usage', usage: { input: 4, output: 6, costUSD: 0.01 } },
        { kind: 'tool_use.start', id: 'id', name: 'x' },
        { kind: 'tool_use.delta', id: 'id', argsFragment: '{}' },
        { kind: 'tool_use.end', id: 'id' },
        { kind: 'message.stop', stopReason: 'tool_use' },
      ],
    ])
    const state = context()
    state.resourceBudget = { tokenMax: 10 }
    const raised: unknown[] = []
    const bus = new EventBus()
    bus.subscribe((event) => {
      if (event.type === 'error.raised') raised.push(event.payload)
    })
    const final = await new Runner(state, router(client), composer, tools, bus).run('hi')
    expect(final.cumulativeUsage).toMatchObject({ input: 4, output: 6, costUSD: 0.01 })
    expect(final.messages).toContainEqual(
      expect.objectContaining({
        role: 'assistant',
        content: expect.arrayContaining([{ type: 'text', text: 'partial answer' }]),
      }),
    )
    expect(raised).toContainEqual(
      expect.objectContaining({
        code: 'subagent_budget_exhausted',
        context: expect.objectContaining({ dimension: 'token' }),
      }),
    )
    expect(final.turns.at(-1)?.status).toBe('aborted')
  })
  it('propagates abort to provider stream', async () => {
    let seen: AbortSignal | undefined
    let ready!: () => void
    const started = new Promise<void>((resolve) => {
      ready = resolve
    })
    const client = provider([])
    client.stream = async function* (_request, signal) {
      seen = signal
      ready()
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      )
    }
    const runner = new Runner(context(), router(client), composer, tools)
    const running = runner.run('hi')
    await started
    runner.interrupt()
    await running
    expect(seen?.aborted).toBe(true)
  })
  it('settles the turn when a provider stream throws', async () => {
    const client = provider([])
    client.stream = async function* () {
      throw new Error('provider failed')
    }
    const raised: unknown[] = []
    const bus = new EventBus()
    bus.subscribe((event) => {
      if (event.type === 'error.raised') raised.push(event.payload)
    })
    const state = await new Runner(context(), router(client), composer, tools, bus).run('hi')
    expect(state.activeTurn).toBeNull()
    expect(state.turns.at(-1)?.status).toBe('aborted')
    expect(raised).toContainEqual(
      expect.objectContaining({
        code: 'runner_error',
        context: expect.objectContaining({ message: 'provider failed' }),
      }),
    )
  })
  it('fails closed on partial tool_use without consulting retry routing or executing it', async () => {
    const first = provider(
      [
        [
          { kind: 'text.delta', text: 'partial' },
          { kind: 'tool_use.start', id: 'id', name: 'x' },
          { kind: 'message.interrupted', reason: 'rst' },
        ],
      ],
      'first',
    )
    const second = provider([], 'second')
    const events: string[] = []
    const bus = new EventBus()
    bus.subscribe((event) => {
      if (event.type === 'error.raised') events.push((event.payload as { code: string }).code)
    })
    const retry = vi.fn(async () => ({
      provider: second,
      model: 'm2',
      reason: 'fallback',
    }))
    const policy = router(first, retry)
    const state = await new Runner(context(), policy, composer, tools, bus).run('hi')
    expect(events).toContain('stream_resume_unsafe_partial_tool_use')
    expect(retry).not.toHaveBeenCalled()
    expect(
      state.messages.some((message) =>
        message.content.some((part) => part.type === 'text' && part.text === 'partial'),
      ),
    ).toBe(false)
    expect(tools.execute).not.toHaveBeenCalled()
  })
  it('does not replay a completed side-effect tool when the following stream is retried', async () => {
    const client = provider([
      [
        { kind: 'tool_use.start', id: 'side-effect-1', name: 'write' },
        { kind: 'tool_use.delta', id: 'side-effect-1', argsFragment: '{"value":1}' },
        { kind: 'tool_use.end', id: 'side-effect-1' },
        { kind: 'message.stop', stopReason: 'tool_use' },
      ],
      [
        { kind: 'text.delta', text: 'discarded' },
        { kind: 'message.interrupted', reason: 'rst' },
      ],
      [
        { kind: 'text.delta', text: 'done' },
        { kind: 'message.stop', stopReason: 'end_turn' },
      ],
    ])
    const policy = router(client, async () => ({ provider: client, model: 'm', reason: 'retry' }))
    const state = await new Runner(context(), policy, composer, tools).run('hi')
    expect(tools.execute).toHaveBeenCalledTimes(1)
    expect(tools.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'side-effect-1' }),
      expect.any(AbortSignal),
    )
    expect(state.messages.at(-1)?.content).toContainEqual({ type: 'text', text: 'done' })
  })
  it('injects composed system prompt', async () => {
    const client = provider([[{ kind: 'message.stop', stopReason: 'end_turn' }]])
    const spy = vi.spyOn(client, 'stream')
    const state = await new Runner(context(), router(client), composer, tools).run('hi')
    expect(spy.mock.calls[0]?.[0].system).toBe('<!-- source: builtin, priority: 1000 -->\nsystem')
    expect(state.systemPromptSnapshot).toBe('<!-- source: builtin, priority: 1000 -->\nsystem')
  })
  it('uses the router retry decision before sticky lock without picking again', async () => {
    const first = provider(
      [
        [
          { kind: 'text.delta', text: 'discard' },
          { kind: 'message.interrupted', reason: 'rst' },
        ],
      ],
      'first',
    )
    const second = provider(
      [
        [
          { kind: 'text.delta', text: 'kept' },
          { kind: 'message.stop', stopReason: 'end_turn' },
        ],
      ],
      'second',
    )
    const policy = router(first, async () => ({
      provider: second,
      model: 'm2',
      reason: 'fallback',
    }))
    const switched: unknown[] = []
    const bus = new EventBus()
    bus.subscribe((event) => {
      if (event.type === 'router.switched') switched.push(event.payload)
    })
    const state = await new Runner(context(), policy, composer, tools, bus).run('hi')
    expect(policy.pick).toHaveBeenCalledTimes(1)
    // 附录 D.2 router.switched：{from, to?, reason}（category 移出契约）。
    expect(switched).toContainEqual({ from: 'first', to: 'second', reason: 'fallback' })
    expect(state.messages.at(-1)?.content).toContainEqual({ type: 'text', text: 'kept' })
  })

  it('assembles interleaved tool_use deltas per id and parses each at tool_use.end (spec 3.2 rule 1)', async () => {
    const client = provider([
      [
        { kind: 'tool_use.start', id: 't1', name: 'first' },
        { kind: 'tool_use.start', id: 't2', name: 'second' },
        { kind: 'tool_use.delta', id: 't1', argsFragment: '{"a"' },
        { kind: 'tool_use.delta', id: 't2', argsFragment: '{"b":' },
        { kind: 'tool_use.delta', id: 't1', argsFragment: ': 1}' },
        { kind: 'tool_use.delta', id: 't2', argsFragment: ' 2}' },
        { kind: 'tool_use.end', id: 't2' },
        { kind: 'tool_use.end', id: 't1' },
        { kind: 'message.stop', stopReason: 'tool_use' },
      ],
      [
        { kind: 'text.delta', text: 'done' },
        { kind: 'message.stop', stopReason: 'end_turn' },
      ],
    ])
    const state = await new Runner(context(), router(client), composer, tools).run('hi')
    expect(tools.execute).toHaveBeenCalledTimes(2)
    expect(tools.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', input: { a: 1 } }),
      expect.any(AbortSignal),
    )
    expect(tools.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't2', input: { b: 2 } }),
      expect.any(AbortSignal),
    )
    expect(state.messages).toContainEqual(
      expect.objectContaining({
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'first', input: { a: 1 } },
          { type: 'tool_use', id: 't2', name: 'second', input: { b: 2 } },
        ],
      }),
    )
    expect(state.turns.at(-1)?.status).toBe('done')
  })

  it('never executes a tool_use whose args fail JSON.parse and returns the fixed-format error tool_result (spec 3.2 rule 2)', async () => {
    const brokenRaw = `{"pad":"${'y'.repeat(192)}ENDMARK` // 207 chars, unterminated JSON string
    const client = provider([
      [
        { kind: 'tool_use.start', id: 'ok', name: 'fine' },
        { kind: 'tool_use.delta', id: 'ok', argsFragment: '{}' },
        { kind: 'tool_use.end', id: 'ok' },
        { kind: 'tool_use.start', id: 'bad', name: 'broken' },
        { kind: 'tool_use.delta', id: 'bad', argsFragment: brokenRaw.slice(0, 100) },
        { kind: 'tool_use.delta', id: 'bad', argsFragment: brokenRaw.slice(100) },
        { kind: 'tool_use.end', id: 'bad' },
        { kind: 'message.stop', stopReason: 'tool_use' },
      ],
      [
        { kind: 'text.delta', text: 'recovered' },
        { kind: 'message.stop', stopReason: 'end_turn' },
      ],
    ])
    const started: string[] = []
    const completed: unknown[] = []
    const bus = new EventBus()
    bus.subscribe((event) => {
      const payload = event.payload as { toolUseId?: string }
      if (event.type === 'tool.started' && payload.toolUseId) started.push(payload.toolUseId)
      if (event.type === 'tool.completed') completed.push(event.payload)
    })
    const state = await new Runner(context(), router(client), composer, tools, bus).run('hi')
    expect(tools.execute).toHaveBeenCalledTimes(1)
    expect(tools.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ok', input: {} }),
      expect.any(AbortSignal),
    )
    expect(started).toEqual(['ok'])
    // 附录 D.2 tool.completed：{toolUseId, tool, isError, durationMs?}（content 移出事件，
    // 完整 tool_result 内容走 message.appended）。
    expect(completed).toContainEqual({
      toolUseId: 'bad',
      tool: 'broken',
      isError: true,
    })
    expect(completed).toContainEqual(
      expect.objectContaining({ toolUseId: 'ok', tool: 'fine', isError: false }),
    )
    const badResult = state.messages.find((message) =>
      message.content.some((part) => part.type === 'tool_result' && part.toolUseId === 'bad'),
    )
    expect(badResult).toBeDefined()
    const badPart = badResult?.content[0] as {
      type: string
      isError?: boolean
      content: { type: string; text: string }[]
    }
    const expected = `Invalid JSON arguments for tool broken (stream truncated?): ${brokenRaw.slice(0, 200)}...`
    expect(badPart.type).toBe('tool_result')
    expect(badPart.isError).toBe(true)
    expect(badPart.content[0]?.type).toBe('text')
    expect(badPart.content[0]?.text).toContain(expected)
    expect(badPart.content[0]?.text).not.toContain('ENDMARK')
    expect(state.messages.at(-1)?.content).toContainEqual({ type: 'text', text: 'recovered' })
    expect(state.turns.at(-1)?.status).toBe('done')
  })

  it('voids every aggregation entry, including ended ones, when message.interrupted arrives (spec 3.2 rule 4)', async () => {
    const client = provider([
      [
        { kind: 'text.delta', text: 'partial' },
        { kind: 'tool_use.start', id: 't1', name: 'never' },
        { kind: 'tool_use.delta', id: 't1', argsFragment: '{"a":' },
        { kind: 'tool_use.start', id: 't2', name: 'ended-but-void' },
        { kind: 'tool_use.delta', id: 't2', argsFragment: '{"b":2}' },
        { kind: 'tool_use.end', id: 't2' },
        { kind: 'message.interrupted', reason: 'rst' },
      ],
    ])
    const events: string[] = []
    const bus = new EventBus()
    bus.subscribe((event) => {
      if (event.type === 'error.raised') events.push((event.payload as { code: string }).code)
    })
    const state = await new Runner(context(), router(client), composer, tools, bus).run('hi')
    expect(events).toContain('stream_interrupted')
    expect(events).toContain('stream_resume_unsafe_partial_tool_use')
    expect(tools.execute).not.toHaveBeenCalled()
    expect(
      state.messages.some((message) => message.content.some((part) => part.type === 'tool_use')),
    ).toBe(false)
    expect(
      state.messages.some((message) => message.content.some((part) => part.type === 'tool_result')),
    ).toBe(false)
    expect(state.turns.at(-1)?.status).toBe('aborted')
  })

  it('emits appendix D payload shapes through the whole turn (r13-I8)', async () => {
    const client = provider([
      [
        { kind: 'text.delta', text: 'hi ' },
        { kind: 'text.delta', text: 'there' },
        { kind: 'usage', usage: { input: 3, output: 4, costUSD: 0.02 } },
        { kind: 'tool_use.start', id: 't1', name: 'Read' },
        { kind: 'tool_use.delta', id: 't1', argsFragment: '{"path":"a"}' },
        { kind: 'tool_use.end', id: 't1' },
        { kind: 'message.stop', stopReason: 'tool_use' },
      ],
      [
        { kind: 'text.delta', text: 'done' },
        { kind: 'message.stop', stopReason: 'end_turn' },
      ],
    ])
    const byType = new Map<string, unknown[]>()
    const bus = new EventBus()
    bus.subscribe((event) => {
      const list = byType.get(event.type) ?? []
      list.push(event.payload)
      byType.set(event.type, list)
    })
    await new Runner(context(), router(client), composer, tools, bus).run('hi')
    // message.appended：★messageId ★role ★content（引用式）
    expect(byType.get('message.appended')).toEqual(
      expect.arrayContaining([
        { messageId: expect.any(String), role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          messageId: expect.any(String),
          role: 'assistant',
          content: [
            { type: 'text', text: 'hi there' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a' } },
          ],
        },
      ]),
    )
    // tool.requested：★toolUseId ★tool ★input（执行/权限判定之前）
    expect(byType.get('tool.requested')).toEqual([
      { toolUseId: 't1', tool: 'Read', input: { path: 'a' } },
    ])
    // tool.started：{toolUseId, tool}；tool.completed：含 durationMs
    expect(byType.get('tool.started')).toEqual([{ toolUseId: 't1', tool: 'Read' }])
    expect(byType.get('tool.completed')).toEqual([
      expect.objectContaining({ toolUseId: 't1', tool: 'Read', isError: false }),
    ])
    // stream.delta：只传增量片段
    expect(byType.get('stream.delta')).toEqual([
      { messageId: expect.any(String), kind: 'text', fragment: 'hi ' },
      { messageId: expect.any(String), kind: 'text', fragment: 'there' },
      { messageId: expect.any(String), kind: 'tool_use', fragment: '{"path":"a"}' },
      { messageId: expect.any(String), kind: 'text', fragment: 'done' },
    ])
    // turn.completed：★turnId ★usage ?stopReason
    expect(byType.get('turn.completed')).toEqual([
      {
        turnId: expect.any(String),
        usage: {
          input: 3,
          output: 4,
          cacheRead: 0,
          cacheWrite: 0,
          costUSD: 0.02,
        },
        stopReason: 'end_turn',
      },
    ])
  })

  it('emits appendix D context.compacted with before/after tokens (r13-I8)', async () => {
    const client = provider([
      [
        { kind: 'text.delta', text: 'ok' },
        { kind: 'message.stop', stopReason: 'end_turn' },
      ],
    ])
    const bus = new EventBus()
    const compacted: unknown[] = []
    bus.subscribe((event) => {
      if (event.type === 'context.compacted') compacted.push(event.payload)
    })
    const policy: ContextPolicy = {
      name: 'stub',
      shouldCompact: () => true,
      estimateTokens: () => 1,
      buildPrompt: (ctx) => ({
        messages: ctx.session.messages,
        removedMessageIds: [],
        estimatedTokens: 1,
        hasSummary: false,
      }),
      compact: async () => ({
        messages: [],
        compactedMessageIds: ['m0'],
        beforeTokens: 100,
        afterTokens: 10,
        strategy: 'truncate',
        hookIntercepted: false,
      }),
    }
    await new Runner(context(), router(client), composer, tools, bus, {}, policy).run('hi')
    // 附录 D.2：★before ★after（token 数）?strategy ?removedMessageIds
    expect(compacted).toEqual([
      { before: 100, after: 10, strategy: 'truncate', removedMessageIds: ['m0'] },
    ])
  })

  it('derives role hints from built-in subagent types while preserving explicit hints', async () => {
    const client = provider([
      [{ kind: 'message.stop', stopReason: 'end_turn' }],
      [{ kind: 'message.stop', stopReason: 'end_turn' }],
    ])
    const policy = router(client)
    const state = context()
    state.lineage = { depth: 1, agentType: 'planner' }
    const runner = new Runner(state, policy, composer, tools)
    await runner.run('plan')
    expect(policy.pick).toHaveBeenLastCalledWith(expect.anything(), { role: 'planner' })
    await runner.run('review', { role: 'reviewer', costPreference: 'quality' })
    expect(policy.pick).toHaveBeenLastCalledWith(expect.anything(), {
      role: 'reviewer',
      costPreference: 'quality',
    })
  })
})

describe('Runner B7 truncation continuation (r13-G5)', () => {
  const textTurn = (stopReason: 'end_turn' | 'max_tokens'): ProviderChunk[][] => [
    [
      { kind: 'message.start', messageId: 'm1' },
      { kind: 'text.delta', text: 'partial answer' },
      { kind: 'message.stop', stopReason },
    ],
  ]

  it('passes preferredProvider + explicitModel hint after a max_tokens-truncated turn', async () => {
    const client = provider(textTurn('max_tokens'), 'truncator')
    const policy = router(client)
    const runner = new Runner(context(), policy, composer, tools)
    await runner.run('write a long answer')
    expect(policy.pick).toHaveBeenLastCalledWith(expect.anything(), undefined)
    await runner.run('continue')
    expect(policy.pick).toHaveBeenLastCalledWith(expect.anything(), {
      preferredProvider: 'truncator',
      explicitModel: 'm',
    })
  })

  it('does not inject B7 preference after a normally completed turn', async () => {
    const client = provider(textTurn('end_turn'), 'normal')
    const policy = router(client)
    const runner = new Runner(context(), policy, composer, tools)
    await runner.run('hi')
    await runner.run('continue')
    expect(policy.pick).toHaveBeenLastCalledWith(expect.anything(), undefined)
  })

  it('caller-provided explicitModel wins over the B7 preference', async () => {
    const client = provider([...textTurn('max_tokens'), ...textTurn('end_turn')], 'truncator')
    const policy = router(client)
    const runner = new Runner(context(), policy, composer, tools)
    await runner.run('write a long answer')
    await runner.run('continue', { explicitModel: 'other-model' })
    expect(policy.pick).toHaveBeenLastCalledWith(expect.anything(), {
      explicitModel: 'other-model',
    })
  })

  it('continue is a normal new turn — no special-cased turn semantics', async () => {
    const client = provider([...textTurn('max_tokens'), ...textTurn('end_turn')], 'truncator')
    const bus = new EventBus()
    bus.subscribe(() => {})
    const runner = new Runner(context(), router(client), composer, tools, bus)
    await runner.run('long')
    const turnsBefore = runner.state.turns.length
    await runner.run('continue')
    // 恰好新增一个 turn（普通 sendUserMessage 语义，无隐式续传分支）
    expect(runner.state.turns.length).toBe(turnsBefore + 1)
    expect(runner.state.messages.filter((m) => m.role === 'user')).toHaveLength(2)
  })
})
