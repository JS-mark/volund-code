import { describe, expect, it, vi } from 'vitest'

import { AuthManager, MemoryCredentialStore } from './index'
describe('AuthManager', () => {
  it('resolves keychain before env without leaking payload', async () => {
    const store = new MemoryCredentialStore()
    await store.set('anthropic', 'secret')
    const emit = vi.fn(async () => {}),
      auth = new AuthManager({
        keychain: store,
        env: { ANTHROPIC_API_KEY: 'env' },
        telemetry: { emit },
      })
    expect(await auth.getCredential('anthropic')).toBe('secret')
    expect(JSON.stringify(emit.mock.calls)).not.toContain('secret')
  })
  it('verifies before storing', async () => {
    const store = new MemoryCredentialStore(),
      auth = new AuthManager({ keychain: store, telemetry: { emit: async () => {} } })
    await expect(auth.login('x', 'secret', async () => false)).rejects.toThrow()
    expect(await store.get('x')).toBeUndefined()
  })
  it('resolves the config layer after env without leaking payload', async () => {
    const emit = vi.fn(
        async (_name: string, _source: string, _payload: Record<string, unknown>) => {},
      ),
      auth = new AuthManager({
        env: {},
        configKeys: async (provider) => (provider === 'anthropic' ? 'config-secret' : undefined),
        telemetry: { emit },
      })
    expect(await auth.getCredential('anthropic')).toBe('config-secret')
    const resolved = emit.mock.calls.find(([name]) => name === 'auth.credential.resolved')
    expect(resolved?.[2]).toMatchObject({ provider: 'anthropic', layer: 4, cache_hit: false })
    expect(JSON.stringify(emit.mock.calls)).not.toContain('config-secret')
  })
  it('reports every layer tried when the config layer also misses', async () => {
    const emit = vi.fn(
        async (_name: string, _source: string, _payload: Record<string, unknown>) => {},
      ),
      auth = new AuthManager({
        env: {},
        configKeys: async () => undefined,
        telemetry: { emit },
      })
    expect(await auth.getCredential('anthropic')).toBeUndefined()
    const miss = emit.mock.calls.find(([name]) => name === 'auth.credential.miss')
    expect(miss?.[2]).toMatchObject({ provider: 'anthropic', layers_tried: [1, 2, 3, 4] })
  })
})
