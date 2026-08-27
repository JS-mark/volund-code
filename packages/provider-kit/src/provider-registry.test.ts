import { describe, expect, it, vi } from 'vitest'

import { InMemoryProviderRegistry, type ProviderCapabilities, type ProviderClient } from './index'

const capabilities: ProviderCapabilities = {
  maxContextTokens: 8192,
  maxOutputTokens: 1024,
  toolUse: 'none',
  toolResultSchema: 'openai',
  vision: false,
  files: false,
  thinking: false,
  streaming: true,
  streamingReasoning: false,
  cache: 'none',
  jsonMode: true,
  structuredOutput: false,
  systemPromptLocation: 'system-field',
  toolChoiceRequired: false,
  interleavedThinking: false,
}
const client = (name: string): ProviderClient => ({
  name,
  capabilities,
  async *stream() {},
  dispose: vi.fn(async () => {}),
})

describe('InMemoryProviderRegistry', () => {
  it('freezes metadata, rejects conflicts, and disposes clients', async () => {
    const registry = new InMemoryProviderRegistry(),
      first = client('plugin-vllm')
    const registration = registry.register(
      first,
      { kind: 'plugin', plugin: 'volund-plugin-vllm' },
      {
        capabilities,
        displayName: 'vLLM',
        models: [{ id: 'llama' }],
      },
    )
    expect(Object.isFrozen(registry.describe('plugin-vllm')!.meta.capabilities)).toBe(true)
    expect(() =>
      registry.register(
        client('plugin-vllm'),
        { kind: 'core' },
        {
          capabilities,
          displayName: 'conflict',
        },
      ),
    ).toThrow('provider_name_conflict')
    await registration.dispose()
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(registry.get('plugin-vllm')).toBeUndefined()
  })
})
