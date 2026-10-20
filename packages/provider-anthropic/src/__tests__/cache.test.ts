import { describe, expect, it, vi } from 'vitest'

import { anthropicCapabilities, anthropicCachePlan, AnthropicClient, parseAnthropicSse } from '../index'
import type { ProviderRequest } from '@volund/provider-kit'

async function* chunks(parts: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* parts
}
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of iterable) result.push(item)
  return result
}

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: 'claude-test',
    messages: [
      {
        id: 'u1',
        role: 'user',
        createdAt: 0,
        content: [{ type: 'text', text: 'hello' }],
      },
    ],
    system: 'sys',
    tools: [
      { name: 'a', description: 'a', inputSchema: {} },
      { name: 'b', description: 'b', inputSchema: {} },
    ],
    ...overrides,
  }
}

describe('anthropicCachePlan', () => {
  it('returns undefined without cache strategy or for cache-incapable providers', () => {
    expect(anthropicCachePlan(request(), anthropicCapabilities)).toBeUndefined()
    expect(
      anthropicCachePlan(request({ cache: { strategy: 'ephemeral' } }), anthropicCapabilities),
    ).toBeDefined()
    const noCacheProvider = { ...anthropicCapabilities, cache: 'none' as const }
    expect(
      anthropicCachePlan(request({ cache: { strategy: 'ephemeral' } }), noCacheProvider),
    ).toBeUndefined()
    expect(
      anthropicCachePlan(request({ cache: { strategy: 'off' } }), anthropicCapabilities),
    ).toBeUndefined()
  })

  it('marks tools, system, and the last message, honoring the 4-breakpoint cap', () => {
    const messages = [0, 1, 2, 3].map((index) => ({
      id: `u${index}`,
      role: 'user' as const,
      createdAt: 0,
      content: [{ type: 'text' as const, text: `m${index}` }],
    }))
    const plan = anthropicCachePlan(
      request({ messages, cache: { strategy: 'ephemeral' } }),
      anthropicCapabilities,
    )
    expect(plan?.tools).toEqual({ type: 'ephemeral' })
    expect(plan?.system).toEqual({ type: 'ephemeral' })
    // 4 断点已被 tools+system+3 条 rawMeta 占满时不再有自动对话尾断点。
    const marked = plan!.messages.filter((mark) => mark !== undefined)
    expect(marked.length).toBeLessThanOrEqual(1)
    expect(plan!.messages.at(-1)).toEqual({ type: 'ephemeral' })
  })

  it('rawMeta marks win their message slot and consume the breakpoint budget', () => {
    const rawControl = { type: 'ephemeral' as const }
    const messages = [0, 1, 2].map((index) => ({
      id: `u${index}`,
      role: 'user' as const,
      createdAt: 0,
      content: [{ type: 'text' as const, text: `m${index}` }],
    }))
    const plan = anthropicCachePlan(
      request({
        messages,
        cache: { strategy: 'ephemeral' },
        rawMeta: { anthropic: { cacheControl: [rawControl, rawControl, rawControl] } },
      }),
      anthropicCapabilities,
    )
    // 3 条 rawMeta + tools + system = 5 > 4 —— 不裁 rawMeta，裁的是自动断点：
    // 预算只剩 1，按 tools → system 顺序落在 tools 上，尾消息不再吃自动断点。
    expect(plan?.messages[0]).toEqual(rawControl)
    expect(plan?.messages[1]).toEqual(rawControl)
    expect(plan?.messages[2]).toEqual(rawControl)
    expect(plan?.tools).toEqual({ type: 'ephemeral' })
    expect(plan?.system).toBeUndefined()
  })

  it('maps ttlSeconds=3600 to the 1h TTL', () => {
    const plan = anthropicCachePlan(
      request({ cache: { strategy: 'ephemeral', ttlSeconds: 3600 } }),
      anthropicCapabilities,
    )
    expect(plan?.system).toEqual({ type: 'ephemeral', ttl: '1h' })
  })
})

describe('AnthropicClient prompt cache', () => {
  function client() {
    const http = {
      request: vi.fn(async (_input: { body?: unknown }) => ({
        status: 200,
        body: chunks([
          new TextEncoder().encode('event: message_stop\ndata: {"stop_reason":"end_turn"}\n\n'),
        ]),
      })),
    }
    const adapter = new AnthropicClient({
      credentials: { getCredential: async () => 'k' },
      http,
    })
    return { http, adapter }
  }

  it('injects cache_control into system (array form), last tool, and last message block', async () => {
    const { http, adapter } = client()
    await collect(
      adapter.stream(request({ cache: { strategy: 'ephemeral' } }), new AbortController().signal),
    )
    const body = http.request.mock.calls[0]![0].body as Record<string, unknown>
    expect(body.system).toEqual([
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
    ])
    const tools = body.tools as Array<Record<string, unknown>>
    expect(tools.at(-1)).toMatchObject({ name: 'b', cache_control: { type: 'ephemeral' } })
    expect(tools[0]).not.toHaveProperty('cache_control')
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>
    expect(messages.at(-1)!.content.at(-1)).toMatchObject({
      type: 'text',
      cache_control: { type: 'ephemeral' },
    })
  })

  it('leaves the request body free of cache marks when strategy is off', async () => {
    const { http, adapter } = client()
    await collect(
      adapter.stream(request({ cache: { strategy: 'off' } }), new AbortController().signal),
    )
    const body = http.request.mock.calls[0]![0].body as {
      system: unknown
      tools: Array<Record<string, unknown>>
    }
    expect(body.system).toBe('sys')
    expect(body.tools.every((tool) => !('cache_control' in tool))).toBe(true)
  })
})

describe('Anthropic usage across message_start/message_delta', () => {
  it('merges cache fields reported at message_start into the delta usage', async () => {
    const sse =
      'event: message_start\n' +
      'data: {"message":{"id":"m1","usage":{"input_tokens":100,"cache_read_input_tokens":50,"cache_creation_input_tokens":7,"output_tokens":1}}}\n\n' +
      'event: message_delta\n' +
      'data: {"usage":{"output_tokens":21}}\n\n' +
      'event: message_stop\ndata: {"stop_reason":"end_turn"}\n\n'
    const events = await collect(parseAnthropicSse(chunks([new TextEncoder().encode(sse)])))
    expect(events).toContainEqual({
      kind: 'usage',
      usage: { input: 100, output: 21, cacheRead: 50, cacheWrite: 7 },
    })
  })

  it('lets delta-reported cache fields win over message_start', async () => {
    const sse =
      'event: message_start\n' +
      'data: {"message":{"id":"m1","usage":{"input_tokens":100,"cache_read_input_tokens":50}}}\n\n' +
      'event: message_delta\n' +
      'data: {"usage":{"output_tokens":21,"cache_read_input_tokens":80}}\n\n' +
      'event: message_stop\ndata: {"stop_reason":"end_turn"}\n\n'
    const events = await collect(parseAnthropicSse(chunks([new TextEncoder().encode(sse)])))
    expect(events).toContainEqual({
      kind: 'usage',
      usage: { input: 100, output: 21, cacheRead: 80 },
    })
  })
})
