import { Context } from '@cordisjs/core'
import { MockProvider, scriptChunks } from '@volund/testkit'
import { describe, expect, it } from 'vitest'

import { ModelService } from './index'

describe('ModelService (first kernel service)', () => {
  it('is reachable as ctx.model after plugin installation', () => {
    const ctx = new Context()
    ctx.plugin(ModelService)
    expect(ctx.model).toBeInstanceOf(ModelService)
    expect(ctx.model.registry.get('nope')).toBeUndefined()
  })
  it('exposes the provider registry to dependent plugins via inject', () => {
    const ctx = new Context()
    ctx.plugin(ModelService)
    const provider = new MockProvider('mock', scriptChunks([]))
    ctx.model.registry.register(
      provider,
      { kind: 'core' },
      {
        displayName: 'Mock',
        capabilities: provider.capabilities,
      },
    )
    let seen: string | undefined
    ctx.inject(['model'], (injected) => {
      seen = injected.model.registry.get('mock')?.name
    })
    expect(seen).toBe('mock')
  })
  it('keeps per-context registries isolated', () => {
    const a = new Context()
    a.plugin(ModelService)
    const b = new Context()
    b.plugin(ModelService)
    const provider = new MockProvider('only-a', scriptChunks([]))
    a.model.registry.register(
      provider,
      { kind: 'core' },
      {
        displayName: 'A',
        capabilities: provider.capabilities,
      },
    )
    expect(a.model.registry.get('only-a')).toBeDefined()
    expect(b.model.registry.get('only-a')).toBeUndefined()
  })
})
