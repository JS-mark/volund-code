import type { ProviderChunk, ProviderError, ProviderRequest } from '@volund/provider-kit'
import { describe, expect, it } from 'vitest'

import { MockProvider, scriptChunks } from './mock-provider'

const request = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: 'mock-1',
  messages: [
    {
      id: 'u1',
      role: 'user',
      createdAt: 0,
      content: [{ type: 'text', text: 'hi' }],
    },
  ],
  ...overrides,
})

const providerError: ProviderError = Object.assign(new Error('provider exploded'), {
  provider: 'mock',
  category: 'server' as const,
  retryable: true,
})

const signal = (): AbortSignal => new AbortController().signal

async function collect(
  provider: MockProvider,
  req: ProviderRequest = request(),
  abort: AbortSignal = signal(),
): Promise<ProviderChunk[]> {
  const chunks: ProviderChunk[] = []
  for await (const chunk of provider.stream(req, abort)) chunks.push(chunk)
  return chunks
}

describe('MockProvider', () => {
  it('satisfies the ProviderClient contract surface', () => {
    const provider = new MockProvider('mock', scriptChunks([]))
    expect(provider.name).toBe('mock')
    expect(provider.capabilities).toMatchObject({ streaming: true, toolUse: 'parallel' })
    expect(typeof provider.stream).toBe('function')
    expect(typeof provider.complete).toBe('function')
    expect(typeof provider.countTokens).toBe('function')
    expect(typeof provider.dispose).toBe('function')
  })

  it('yields the scripted chunks verbatim, in order, chunk by chunk', async () => {
    const chunks: ProviderChunk[] = [
      { kind: 'message.start', messageId: 'm1' },
      { kind: 'text.delta', text: 'hello' },
      { kind: 'tool_use.start', id: 't1', name: 'Read' },
      { kind: 'tool_use.delta', id: 't1', argsFragment: '{"path":"a.ts"' },
      { kind: 'tool_use.delta', id: 't1', argsFragment: '}' },
      { kind: 'tool_use.end', id: 't1' },
      { kind: 'usage', usage: { input: 10, output: 5 } },
      { kind: 'message.stop', stopReason: 'tool_use' },
    ]
    expect(await collect(new MockProvider('mock', scriptChunks(chunks)))).toEqual(chunks)
  })

  it('accepts a bare chunk array in place of a script', async () => {
    const provider = new MockProvider('mock', [{ kind: 'text.delta', text: 'x' }])
    expect(await collect(provider)).toEqual([{ kind: 'text.delta', text: 'x' }])
  })

  it('records every request handed to stream', async () => {
    const provider = new MockProvider('mock', [{ kind: 'message.stop', stopReason: 'end_turn' }])
    await collect(provider, request({ system: 'sys' }))
    await collect(provider, request({ model: 'other' }))
    expect(provider.streamCount).toBe(2)
    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[0]).toMatchObject({ model: 'mock-1', system: 'sys' })
    expect(provider.requests[1]).toMatchObject({ model: 'other' })
  })

  it('stops yielding once the abort signal fires', async () => {
    const provider = new MockProvider('mock', [
      { kind: 'text.delta', text: 'one' },
      { kind: 'text.delta', text: 'two' },
      { kind: 'text.delta', text: 'three' },
    ])
    const controller = new AbortController()
    const received: ProviderChunk[] = []
    for await (const chunk of provider.stream(request(), controller.signal)) {
      received.push(chunk)
      if (received.length === 1) controller.abort()
    }
    expect(received).toEqual([{ kind: 'text.delta', text: 'one' }])
  })

  it('repeats the last script by default once the queue drains', async () => {
    const provider = new MockProvider('mock', [{ kind: 'text.delta', text: 'again' }])
    expect(await collect(provider)).toEqual([{ kind: 'text.delta', text: 'again' }])
    expect(await collect(provider)).toEqual([{ kind: 'text.delta', text: 'again' }])
  })

  it('serves empty streams when exhausted is empty', async () => {
    const provider = new MockProvider('mock', [{ kind: 'text.delta', text: 'only' }], {
      exhausted: 'empty',
    })
    expect(await collect(provider)).toEqual([{ kind: 'text.delta', text: 'only' }])
    expect(await collect(provider)).toEqual([])
  })

  it('throws when exhausted is throw', async () => {
    const provider = new MockProvider('mock', [], { exhausted: 'throw' })
    await expect(collect(provider)).rejects.toThrow('mock_provider_script_exhausted')
  })

  it('serves enqueued scripts in order before repeating the last', async () => {
    const provider = new MockProvider('mock')
    provider
      .enqueue(scriptChunks([{ kind: 'text.delta', text: 'first' }]))
      .enqueue(scriptChunks([{ kind: 'text.delta', text: 'second' }]))
    expect(await collect(provider)).toEqual([{ kind: 'text.delta', text: 'first' }])
    expect(await collect(provider)).toEqual([{ kind: 'text.delta', text: 'second' }])
    expect(await collect(provider)).toEqual([{ kind: 'text.delta', text: 'second' }])
  })

  it('interruptAt emits message.interrupted after the nth chunk and ends the stream', async () => {
    const provider = new MockProvider(
      'mock',
      scriptChunks([
        { kind: 'message.start', messageId: 'm1' },
        { kind: 'text.delta', text: 'partial' },
        { kind: 'tool_use.start', id: 't1', name: 'Read' },
        { kind: 'tool_use.end', id: 't1' },
        { kind: 'message.stop', stopReason: 'end_turn' },
      ]),
    )
    provider.interruptAt(3, { reason: 'rst', partial: { text: 'partial', toolUseIds: ['t1'] } })
    expect(await collect(provider)).toEqual([
      { kind: 'message.start', messageId: 'm1' },
      { kind: 'text.delta', text: 'partial' },
      { kind: 'tool_use.start', id: 't1', name: 'Read' },
      {
        kind: 'message.interrupted',
        reason: 'rst',
        partial: { text: 'partial', toolUseIds: ['t1'] },
      },
    ])
  })

  it('interruptAt omits partial when not requested', async () => {
    const provider = new MockProvider('mock', [{ kind: 'text.delta', text: 'x' }])
    provider.interruptAt(1, { reason: 'rst' })
    expect(await collect(provider)).toEqual([
      { kind: 'text.delta', text: 'x' },
      { kind: 'message.interrupted', reason: 'rst' },
    ])
  })

  it('errorAfter emits an error chunk after the nth chunk and ends the stream', async () => {
    const provider = new MockProvider(
      'mock',
      scriptChunks([
        { kind: 'text.delta', text: 'a' },
        { kind: 'text.delta', text: 'b' },
        { kind: 'text.delta', text: 'c' },
      ]),
    )
    provider.errorAfter(2, providerError)
    const received = await collect(provider)
    expect(received).toHaveLength(3)
    expect(received[0]).toEqual({ kind: 'text.delta', text: 'a' })
    expect(received[1]).toEqual({ kind: 'text.delta', text: 'b' })
    expect(received[2]).toMatchObject({ kind: 'error', error: { message: 'provider exploded' } })
  })

  it('injections fire at most once across streams', async () => {
    const provider = new MockProvider('mock', [{ kind: 'text.delta', text: 'x' }])
    provider.interruptAt(1, { reason: 'rst' })
    expect(await collect(provider)).toHaveLength(2)
    expect(await collect(provider)).toEqual([{ kind: 'text.delta', text: 'x' }])
  })

  it('duplicateUsage emits every usage chunk twice', async () => {
    const usage = { input: 10, output: 5 }
    const provider = new MockProvider(
      'mock',
      scriptChunks([
        { kind: 'usage', usage },
        { kind: 'message.stop', stopReason: 'end_turn' },
      ]),
    )
    provider.duplicateUsage()
    expect(await collect(provider)).toEqual([
      { kind: 'usage', usage },
      { kind: 'usage', usage },
      { kind: 'message.stop', stopReason: 'end_turn' },
    ])
  })

  it('brokenToolJson keeps the delta count but makes concatenated args invalid JSON', async () => {
    const provider = new MockProvider(
      'mock',
      scriptChunks([
        { kind: 'tool_use.start', id: 't1', name: 'Bash' },
        { kind: 'tool_use.delta', id: 't1', argsFragment: '{"command":"ls' },
        { kind: 'tool_use.delta', id: 't1', argsFragment: ' -la"}' },
        { kind: 'tool_use.end', id: 't1' },
      ]),
    )
    provider.brokenToolJson('t1')
    const received = await collect(provider)
    const deltas = received.filter(
      (chunk): chunk is Extract<ProviderChunk, { kind: 'tool_use.delta' }> =>
        chunk.kind === 'tool_use.delta',
    )
    expect(deltas).toHaveLength(2)
    const concatenated = deltas.map((delta) => delta.argsFragment).join('')
    expect(() => JSON.parse(concatenated)).toThrow()
    expect(received[0]).toEqual({ kind: 'tool_use.start', id: 't1', name: 'Bash' })
    expect(received.at(-1)).toEqual({ kind: 'tool_use.end', id: 't1' })
  })

  it('truncateUtf8At splits an astral character across two text.delta chunks', async () => {
    const provider = new MockProvider('mock', [{ kind: 'text.delta', text: 'a😀b' }])
    provider.truncateUtf8At('😀')
    const received = await collect(provider)
    expect(received).toHaveLength(2)
    expect(received[0]).toMatchObject({ kind: 'text.delta' })
    expect(received[1]).toMatchObject({ kind: 'text.delta' })
    const first = received[0] as Extract<ProviderChunk, { kind: 'text.delta' }>
    const second = received[1] as Extract<ProviderChunk, { kind: 'text.delta' }>
    expect(first.text.endsWith('\ud83d')).toBe(true)
    expect(second.text.startsWith('\ude00')).toBe(true)
    expect(first.text + second.text).toBe('a😀b')
  })

  it('truncateUtf8At rejects characters that are not surrogate pairs', () => {
    const provider = new MockProvider('mock', [])
    expect(() => provider.truncateUtf8At('中')).toThrow(
      'testkit_truncate_utf8_requires_surrogate_pair',
    )
  })

  it('complete aggregates the script into a provider response', async () => {
    const provider = new MockProvider(
      'mock',
      scriptChunks([
        { kind: 'message.start', messageId: 'm1' },
        { kind: 'thinking.delta', text: 'hmm', signature: 'sig' },
        { kind: 'text.delta', text: 'hello' },
        { kind: 'tool_use.start', id: 't1', name: 'Read' },
        { kind: 'tool_use.delta', id: 't1', argsFragment: '{"path":"a.ts"}' },
        { kind: 'tool_use.end', id: 't1' },
        { kind: 'usage', usage: { input: 10, output: 5 } },
        { kind: 'message.stop', stopReason: 'tool_use' },
      ]),
    )
    const response = await provider.complete(request(), signal())
    expect(response.message).toMatchObject({ id: 'm1', role: 'assistant' })
    expect(response.message.content).toEqual([
      { type: 'thinking', text: 'hmm', signature: 'sig' },
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.ts' } },
    ])
    expect(response.message.meta).toMatchObject({
      provider: 'mock',
      model: 'mock-1',
      usage: { input: 10, output: 5 },
      stopReason: 'tool_use',
    })
    expect(response.usage).toEqual({ input: 10, output: 5 })
    expect(provider.requests).toHaveLength(1)
  })

  it('complete surfaces error chunks as rejections and defaults usage to zero', async () => {
    const failing = new MockProvider('mock', [{ kind: 'message.start', messageId: 'm1' }])
    failing.errorAfter(1, providerError)
    await expect(failing.complete(request(), signal())).rejects.toThrow('provider exploded')

    const empty = new MockProvider('mock', [{ kind: 'message.stop', stopReason: 'end_turn' }])
    const response = await empty.complete(request(), signal())
    expect(response.usage).toEqual({ input: 0, output: 0 })
  })

  it('countTokens returns a deterministic estimate from text lengths', async () => {
    const provider = new MockProvider('mock', [])
    const tokens = await provider.countTokens([
      {
        id: 'u1',
        role: 'user',
        createdAt: 0,
        content: [{ type: 'text', text: '12345678' }],
      },
    ])
    expect(tokens).toBe(2)
  })

  it('merges capability overrides over the test defaults', () => {
    const provider = new MockProvider('mock', [], {
      capabilities: { toolUse: 'none', vision: { formats: ['image/png'], maxSizeMB: 1 } },
    })
    expect(provider.capabilities.toolUse).toBe('none')
    expect(provider.capabilities.vision).toEqual({ formats: ['image/png'], maxSizeMB: 1 })
    expect(provider.capabilities.streaming).toBe(true)
  })

  it('refuses to stream and drops queued scripts after dispose', async () => {
    const provider = new MockProvider('mock', [{ kind: 'text.delta', text: 'x' }])
    await provider.dispose()
    expect(provider.disposed).toBe(true)
    await expect(collect(provider)).rejects.toThrow('mock_provider_disposed')
  })

  it('rejects non-integer or negative injection ordinals', () => {
    const provider = new MockProvider('mock', [])
    expect(() => provider.interruptAt(1.5, { reason: 'rst' })).toThrow(
      'testkit_injection_requires_non_negative_integer',
    )
    expect(() => provider.errorAfter(-1, providerError)).toThrow(
      'testkit_injection_requires_non_negative_integer',
    )
  })
})
