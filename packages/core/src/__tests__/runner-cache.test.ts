import type { ProviderCapabilities, ProviderClient, ProviderRequest } from '@volund/provider-kit'
import { describe, expect, it } from 'vitest'

import { EventBus } from '../event-bus'
import { DefaultPromptComposer } from '../prompt-composer'
import { Runner } from '../runner'
import { createSession } from '../session'

const capabilities = (cache: ProviderCapabilities['cache']): ProviderCapabilities => ({
  maxContextTokens: 1,
  maxOutputTokens: 1,
  toolUse: 'parallel',
  toolResultSchema: 'anthropic',
  vision: false,
  files: false,
  thinking: false,
  streaming: true,
  streamingReasoning: false,
  cache,
  jsonMode: false,
  structuredOutput: false,
  systemPromptLocation: 'system-field',
  toolChoiceRequired: false,
  interleavedThinking: false,
})

function capturingProvider(caps: ProviderCapabilities): {
  client: ProviderClient
  requests: ProviderRequest[]
} {
  const requests: ProviderRequest[] = []
  const client: ProviderClient = {
    name: 'p',
    capabilities: caps,
    async *stream(request) {
      requests.push(request)
      yield { kind: 'message.stop', stopReason: 'end_turn' }
    },
    async dispose() {},
  }
  return { client, requests }
}

const composer = new DefaultPromptComposer()
composer.register({ id: 'x', source: 'builtin', priority: 1000, text: 'system' })
const context = () =>
  createSession({ id: 's', cwd: '/repo', maxTokens: 100, toolRegistrySnapshot: '' })
const tools = {
  schemas: () => [],
  execute: async (tool: { id: string }) => ({
    toolUseId: tool.id,
    content: [{ type: 'text' as const, text: 'ok' }],
  }),
}
const router = (client: ProviderClient) => ({
  name: 'r',
  pick: async () => ({ provider: client, model: 'm', reason: 'test' }),
  onError: async () => 'give-up' as const,
})

describe('Runner prompt cache request', () => {
  it('sets request.cache for cache-capable providers when strategy is auto (default)', async () => {
    const { client, requests } = capturingProvider(capabilities('ephemeral'))
    await new Runner(context(), router(client), composer, tools, new EventBus(), {
      cache: { strategy: 'auto' },
    }).run('hi')
    expect(requests[0]?.cache).toEqual({ strategy: 'ephemeral' })
  })

  it('derives a persistent strategy from the provider capability and passes ttl through', async () => {
    const { client, requests } = capturingProvider(capabilities('persistent'))
    await new Runner(context(), router(client), composer, tools, new EventBus(), {
      cache: { strategy: 'auto', ttlSeconds: 3600 },
    }).run('hi')
    expect(requests[0]?.cache).toEqual({ strategy: 'persistent', ttlSeconds: 3600 })
  })

  it('omits request.cache for providers without a cache capability (auto-caching providers)', async () => {
    const { client, requests } = capturingProvider(capabilities('none'))
    await new Runner(context(), router(client), composer, tools, new EventBus(), {
      cache: { strategy: 'auto' },
    }).run('hi')
    expect(requests[0]?.cache).toBeUndefined()
  })

  it('omits request.cache when [cache] strategy is off', async () => {
    const { client, requests } = capturingProvider(capabilities('ephemeral'))
    await new Runner(context(), router(client), composer, tools, new EventBus(), {
      cache: { strategy: 'off' },
    }).run('hi')
    expect(requests[0]?.cache).toBeUndefined()
  })
})
