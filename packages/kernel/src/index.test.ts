import { Context } from '@cordisjs/core'
import { MockProvider, scriptChunks } from '@volund/testkit'
import type { Tool } from '@volund/tool-kit'
import { describe, expect, it } from 'vitest'

import { ModelService, ToolsService } from './index'

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

describe('ToolsService (tool registry service)', () => {
  const tool: Tool = {
    name: 'probe',
    description: 'probe tool',
    inputSchema: { type: 'object', properties: {} },
    permissionSpec: () => ({}),
    invoke: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  }
  it('is reachable as ctx.tools and registers/unregisters tools', () => {
    const ctx = new Context()
    ctx.plugin(ToolsService)
    expect(ctx.tools).toBeInstanceOf(ToolsService)
    const unregister = ctx.tools.registry.register(tool)
    expect(ctx.tools.registry.get('probe')).toBeDefined()
    unregister()
    expect(ctx.tools.registry.get('probe')).toBeUndefined()
  })
  it('isolates tool registries per context', () => {
    const a = new Context()
    a.plugin(ToolsService)
    const b = new Context()
    b.plugin(ToolsService)
    a.tools.registry.register(tool)
    expect(a.tools.registry.get('probe')).toBeDefined()
    expect(b.tools.registry.get('probe')).toBeUndefined()
  })
})
