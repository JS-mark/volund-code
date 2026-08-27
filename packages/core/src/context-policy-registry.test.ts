import type { ContextCtx, ContextPolicy } from '@volund/provider-kit'
import { describe, expect, it } from 'vitest'

import { ContextPolicyRegistry } from './context-policy-registry'

const policy = (name: string): ContextPolicy => ({
  name,
  shouldCompact: () => false,
  buildPrompt: (ctx) => ({
    messages: ctx.session.messages,
    removedMessageIds: [],
    estimatedTokens: 0,
    hasSummary: false,
  }),
  compact: async (ctx) => ({
    messages: ctx.session.messages,
    compactedMessageIds: [],
    beforeTokens: 0,
    afterTokens: 0,
    strategy: name,
    hookIntercepted: false,
  }),
  estimateTokens: () => 0,
})
const ctx = {
  session: { messages: [] },
  capabilities: { maxContextTokens: 1 },
  turnId: 't',
  model: 'm',
} as unknown as ContextCtx
describe('ContextPolicyRegistry', () => {
  it('selects by explicit name or priority and disposes registrations idempotently', () => {
    const registry = new ContextPolicyRegistry()
    registry.contributePolicy({ name: 'low', policy: policy('low'), priority: 1 })
    const high = registry.contributePolicy({
      name: 'high',
      policy: policy('high'),
      priority: 10,
      when: () => true,
    })
    expect(registry.select(ctx).name).toBe('high')
    expect(registry.select(ctx, 'low').name).toBe('low')
    high.dispose()
    high.dispose()
    expect(registry.select(ctx).name).toBe('low')
  })
})
