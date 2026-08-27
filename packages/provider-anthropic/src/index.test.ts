import { describe, expect, it, vi } from 'vitest'

import {
  AnthropicClient,
  mapAnthropicError,
  parseAnthropicSse,
  toAnthropicMessages,
  verifyAnthropicCredential,
} from './index'

async function* chunks(parts: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* parts
}
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of iterable) result.push(item)
  return result
}
describe('Anthropic adapter', () => {
  it('rejects unsupported image MIME before constructing a provider request', async () => {
    await expect(
      toAnthropicMessages([
        {
          id: 'u',
          role: 'user',
          createdAt: 0,
          content: [
            {
              type: 'image',
              mime: 'image/svg+xml',
              source: { kind: 'inline', bytes: new Uint8Array([1]) },
            },
          ],
        },
      ]),
    ).rejects.toThrow('Unsupported Anthropic image MIME')
  })
  it('verifies credentials only for a successful models response with a valid schema', async () => {
    const http = {
      request: vi.fn(async () => ({
        status: 200,
        body: chunks([new TextEncoder().encode('{"data":[]}')]),
      })),
    }
    await expect(verifyAnthropicCredential(http, 'never-log-this')).resolves.toBe(true)
    expect(http.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'https://api.anthropic.com/v1/models?limit=1',
      }),
    )
  })
  it('converts neutral multimodal and tool messages', async () => {
    const converted = await toAnthropicMessages([
      {
        id: '1',
        role: 'assistant',
        createdAt: 0,
        content: [
          { type: 'text', text: 'x' },
          {
            type: 'image',
            mime: 'image/png',
            source: { kind: 'inline', bytes: new Uint8Array([1]) },
          },
          { type: 'thinking', text: 'h', signature: 's' },
          { type: 'tool_use', id: 't', name: 'read', input: { path: 'a' } },
        ],
      },
    ])
    expect(converted[0]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text' }, { type: 'image' }, { type: 'thinking' }, { type: 'tool_use' }],
    })
  })
  it('uses streaming TextDecoder across UTF-8 boundaries', async () => {
    const text =
      'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"😀"}}\n\nevent: message_stop\ndata: {}\n\n'
    const bytes = new TextEncoder().encode(text)
    const split = bytes.indexOf(0xf0) + 2
    expect(
      await collect(parseAnthropicSse(chunks([bytes.slice(0, split), bytes.slice(split)]))),
    ).toContainEqual({ kind: 'text.delta', text: '😀' })
  })
  it('emits interrupted instead of stop for incomplete and aborted streams', async () => {
    expect(
      (
        await collect(
          parseAnthropicSse(chunks([new TextEncoder().encode('event: content_block_delta\n')])),
        )
      ).at(-1)?.kind,
    ).toBe('message.interrupted')
    const controller = new AbortController()
    controller.abort()
    expect(
      (await collect(parseAnthropicSse(chunks([new Uint8Array([1])]), controller.signal))).at(-1),
    ).toMatchObject({ kind: 'message.interrupted', reason: 'aborted' })
  })
  it('maps errors', () => {
    expect(mapAnthropicError(401).category).toBe('auth')
    expect(mapAnthropicError(429).retryable).toBe(true)
    expect(mapAnthropicError(500).category).toBe('server')
  })
  it('surfaces the upstream error body message on non-2xx instead of a generic status', async () => {
    const request = vi.fn(async (_input) => ({
      status: 400,
      body: chunks([
        new TextEncoder().encode(
          JSON.stringify({
            type: 'error',
            error: { type: 'error', message: "模型路径格式不正确，应为 'req_type/model_id' 格式" },
          }),
        ),
      ]),
    }))
    const client = new AnthropicClient({
      credentials: { getCredential: async () => 'secret' },
      http: { request },
    })
    await expect(
      collect(
        client.stream(
          { model: 'claude-sonnet-4-20250514', system: 's', messages: [] },
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow('模型路径格式不正确')
  })
  it('falls back to the generic status message when the error body is not JSON', async () => {
    const request = vi.fn(async (_input) => ({
      status: 400,
      body: chunks([new TextEncoder().encode('Bad Request')]),
    }))
    const client = new AnthropicClient({
      credentials: { getCredential: async () => 'secret' },
      http: { request },
    })
    await expect(
      collect(
        client.stream({ model: 'm', system: 's', messages: [] }, new AbortController().signal),
      ),
    ).rejects.toThrow('Anthropic request failed (400)')
  })
  it('passes credentials, system, and AbortSignal through injected ports', async () => {
    const signal = new AbortController().signal
    const request = vi.fn(async (_input) => ({
      status: 200,
      body: chunks([new TextEncoder().encode('event: message_stop\ndata: {}\n\n')]),
    }))
    const client = new AnthropicClient({
      credentials: { getCredential: async () => 'secret' },
      http: { request },
    })
    await collect(client.stream({ model: 'm', system: 'composed', messages: [] }, signal))
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      signal,
      headers: { 'x-api-key': 'secret' },
      body: { system: 'composed' },
    })
  })
  it('omits the x-api-key header when the credential port resolves undefined (skipAuth)', async () => {
    const request = vi.fn(async (_input) => ({
      status: 200,
      body: chunks([new TextEncoder().encode('event: message_stop\ndata: {}\n\n')]),
    }))
    const client = new AnthropicClient({
      credentials: { getCredential: async () => undefined },
      http: { request },
    })
    await collect(
      client.stream({ model: 'm', system: 'composed', messages: [] }, new AbortController().signal),
    )
    const headers = request.mock.calls[0]?.[0].headers as Record<string, string>
    expect(headers).not.toHaveProperty('x-api-key')
    expect(headers['anthropic-version']).toBe('2023-06-01')
  })
})
