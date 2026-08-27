import {
  InMemoryProviderRegistry,
  type ProviderClient,
  type ProviderError,
} from '@volund/provider-kit'
import { describe, expect, it, vi } from 'vitest'

import {
  CostAwareRouter,
  FallbackRouter,
  parseRoleRouterConfig,
  RoleRouter,
  SingleProviderRouter,
} from './index'

const client = {
  name: 'fake',
  capabilities: {},
  dispose: async () => {},
  stream: async function* () {},
} as unknown as ProviderClient
const ctx = { session: { id: 's', cumulativeCostUSD: 0 }, turnId: 't', attemptCount: 0 }
describe('SingleProviderRouter', () => {
  it('honors an explicit model', async () => {
    expect(
      (await new SingleProviderRouter(client, 'default').pick(ctx, { explicitModel: 'chosen' }))
        .model,
    ).toBe('chosen')
  })
  it('resolves only explicitly named plugin providers through the registry', async () => {
    const registry = new InMemoryProviderRegistry()
    const plugin = { ...client, name: 'plugin-vllm' }
    registry.register(
      plugin,
      { kind: 'plugin', plugin: 'volund-plugin-provider-vllm' },
      {
        capabilities: plugin.capabilities,
        displayName: 'vLLM',
      },
    )
    const decision = await new SingleProviderRouter(client, 'default', undefined, registry).pick(
      ctx,
      { explicitModel: 'plugin-vllm/llama-3' },
    )
    expect(decision).toMatchObject({
      provider: plugin,
      model: 'llama-3',
      reason: 'explicit-provider',
    })
    await expect(
      new SingleProviderRouter(client, 'default', undefined, registry).pick(ctx, {
        explicitModel: 'missing/model',
      }),
    ).rejects.toThrow('provider_not_registered')
  })
  it('retries retryable errors and gives up otherwise', async () => {
    const sleep = vi.fn(async () => {})
    const router = new SingleProviderRouter(client, 'model', sleep)
    const retryable = Object.assign(new Error('rate'), {
      provider: 'fake',
      category: 'rate_limit',
      retryable: true,
      retryAfterMs: 7,
    }) as ProviderError
    expect(await router.onError(retryable, ctx)).toMatchObject({ reason: 'retry' })
    expect(sleep).toHaveBeenCalledWith(7)
    expect(await router.onError({ ...retryable, retryable: false }, ctx)).toBe('give-up')
    expect(await router.onError(retryable, { ...ctx, attemptCount: 3 })).toBe('give-up')
  })
})

const otherClient = { ...client, name: 'other' } as ProviderClient
const providerError = (
  provider: string,
  category: ProviderError['category'],
  retryable = true,
  retryAfterMs?: number,
) =>
  Object.assign(new Error(`${provider}:${category}`), {
    provider,
    category,
    retryable,
    retryAfterMs,
  }) as ProviderError

describe('FallbackRouter', () => {
  it('falls back for provider-specific terminal errors but never retries request errors', async () => {
    const sleep = vi.fn(async () => {})
    const router = new FallbackRouter(
      [
        { provider: client, model: 'primary', priority: 100 },
        { provider: otherClient, model: 'secondary', priority: 50 },
      ],
      { sleep },
    )

    expect(
      await router.onError(providerError('fake', 'model_not_found', false), ctx),
    ).toMatchObject({ provider: otherClient, reason: 'fallback' })
    expect(await router.onError(providerError('fake', 'auth', true), ctx)).toBe('give-up')
    expect(await router.onError(providerError('fake', 'invalid_request', true), ctx)).toBe(
      'give-up',
    )
    expect(await router.onError(providerError('fake', 'context_length', true), ctx)).toBe('give-up')
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries transient failures with retry-after, then cools and falls back', async () => {
    let now = 0
    const sleep = vi.fn(async () => {})
    const router = new FallbackRouter(
      [
        { provider: client, model: 'primary', priority: 100 },
        { provider: otherClient, model: 'secondary', priority: 50 },
      ],
      { clock: () => now, sleep, cooldownMs: 10_000, maxRetriesPerProvider: 2 },
    )
    const error = providerError('fake', 'network')

    expect(await router.onError(error, ctx)).toMatchObject({ provider: client, reason: 'retry' })
    expect(await router.onError(error, { ...ctx, attemptCount: 1 })).toMatchObject({
      provider: client,
      reason: 'retry',
    })
    expect(await router.onError(error, { ...ctx, attemptCount: 2 })).toMatchObject({
      provider: otherClient,
      reason: 'fallback',
    })
    expect(sleep).toHaveBeenNthCalledWith(1, 1_000, undefined)
    expect(sleep).toHaveBeenNthCalledWith(2, 4_000, undefined)

    await router.onSuccess(await router.pick(ctx), ctx)
    now = 10_001
    expect((await router.pick(ctx)).provider).toBe(client)
    expect((await router.pick(ctx)).provider).toBe(otherClient)
  })

  it('honors sticky providers, budgets, attempts, and cancellation', async () => {
    const sleep = vi.fn(async () => {})
    const router = new FallbackRouter(
      [
        { provider: client, model: 'primary', priority: 100 },
        { provider: otherClient, model: 'secondary', priority: 50 },
      ],
      { sleep, maxAttempts: 3 },
    )
    const stickyCtx = { ...ctx, session: { ...ctx.session, stickyProvider: 'fake' } }
    expect((await router.pick(stickyCtx)).provider).toBe(client)
    expect(await router.onError(providerError('fake', 'rate_limit'), stickyCtx)).toMatchObject({
      provider: client,
      reason: 'sticky-retry',
    })
    expect(
      await router.onError(providerError('fake', 'network'), { ...ctx, attemptCount: 3 }),
    ).toBe('give-up')
    expect(
      await router.onError(providerError('fake', 'network'), {
        ...ctx,
        budget: { costUSDMax: 1, timeMsMax: 10 },
        elapsedTimeMs: 10,
        session: { ...ctx.session, cumulativeCostUSD: 1 },
      }),
    ).toBe('give-up')
    const controller = new AbortController()
    controller.abort()
    expect(
      await router.onError(providerError('fake', 'network'), { ...ctx, signal: controller.signal }),
    ).toBe('give-up')
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('uses retry-after when rate limited without an available fallback', async () => {
    const sleep = vi.fn(async () => {})
    const router = new FallbackRouter([{ provider: client, model: 'primary', priority: 100 }], {
      sleep,
    })
    expect(
      await router.onError(providerError('fake', 'rate_limit', true, 12_345), ctx),
    ).toMatchObject({ provider: client, reason: 'retry' })
    expect(sleep).toHaveBeenCalledWith(12_345, undefined)
  })
})

describe('CostAwareRouter', () => {
  const expensive = {
    provider: client,
    model: 'quality',
    priority: 100,
    pricing: { inputUSDPerMillionTokens: 10, outputUSDPerMillionTokens: 20 },
  }
  const cheap = {
    provider: otherClient,
    model: 'economy',
    priority: 50,
    pricing: { inputUSDPerMillionTokens: 1, outputUSDPerMillionTokens: 2 },
  }
  const estimatedUsage = { inputTokens: 1_000, outputTokens: 500 }

  it('uses exact budget thresholds and deterministically falls back to an affordable route', async () => {
    const router = new CostAwareRouter([expensive, cheap])
    const exact = await router.pick({
      ...ctx,
      estimatedUsage,
      budget: { costUSDMax: 0.02 },
    })
    expect(exact).toMatchObject({
      provider: client,
      model: 'quality',
      reason: 'cost-aware:fallback-primary',
      metadata: {
        pricingSource: 'static-fixture',
        projectedCostUSD: 0.02,
        remainingBudgetUSD: 0.02,
      },
    })

    const fallback = await router.pick({
      ...ctx,
      estimatedUsage,
      budget: { costUSDMax: 0.019 },
    })
    expect(fallback).toMatchObject({
      provider: otherClient,
      model: 'economy',
      metadata: { projectedCostUSD: 0.002 },
    })
  })

  it('keeps cooldown and sticky-provider behavior inside the budget gate', async () => {
    let now = 0
    const router = new CostAwareRouter([expensive, cheap], {
      clock: () => now,
      cooldownMs: 100,
      defaultEstimatedUsage: estimatedUsage,
    })
    const budgeted = { ...ctx, budget: { costUSDMax: 1 } }
    expect(await router.onError(providerError('fake', 'rate_limit'), budgeted)).toMatchObject({
      provider: otherClient,
      reason: 'cost-aware:fallback',
    })
    expect((await router.pick(budgeted)).provider).toBe(otherClient)
    now = 101
    expect((await router.pick(budgeted)).provider).toBe(client)
    await expect(
      router.pick({
        ...budgeted,
        session: { ...ctx.session, stickyProvider: 'other' },
      }),
    ).resolves.toMatchObject({ provider: otherClient, reason: 'cost-aware:sticky-provider' })
  })

  it('fails closed for missing pricing, estimates, unaffordable routes, and unpriced models', async () => {
    expect(
      () =>
        new CostAwareRouter([
          { provider: client, model: 'missing', priority: 1 } as typeof expensive,
        ]),
    ).toThrow('cost_router_pricing_missing')
    const router = new CostAwareRouter([expensive, cheap])
    await expect(router.pick({ ...ctx, budget: { costUSDMax: 1 } })).rejects.toThrow(
      'cost_router_usage_estimate_missing',
    )
    await expect(
      router.pick({ ...ctx, estimatedUsage, budget: { costUSDMax: 0.001 } }),
    ).rejects.toThrow('cost_router_no_affordable_route')
    await expect(router.pick(ctx, { explicitModel: 'fake/unlisted' })).rejects.toThrow(
      'cost_router_explicit_model_unpriced',
    )
  })
})

describe('RoleRouter', () => {
  const registryWith = (...providers: ProviderClient[]) => {
    const registry = new InMemoryProviderRegistry()
    for (const provider of providers) {
      const source = provider.name.startsWith('plugin-')
        ? ({ kind: 'plugin', plugin: `volund-${provider.name}` } as const)
        : ({ kind: 'core' } as const)
      registry.register(provider, source, {
        capabilities: provider.capabilities,
        displayName: provider.name,
      })
    }
    return registry
  }

  it('predictably selects planner, coder, reviewer, and default routes', async () => {
    const planner = { ...client, name: 'planner-provider' } as ProviderClient
    const coder = { ...client, name: 'coder-provider' } as ProviderClient
    const reviewer = { ...client, name: 'reviewer-provider' } as ProviderClient
    const registry = registryWith(planner, coder, reviewer)
    const router = new RoleRouter(registry, {
      roles: {
        planner: { provider: 'planner-provider', model: 'plan-model' },
        coder: { provider: 'coder-provider', model: 'code-model' },
        reviewer: { provider: 'reviewer-provider', model: 'review-model' },
      },
      default: { provider: 'coder-provider', model: 'chat-model' },
    })

    await expect(
      router.pick({ ...ctx, turnId: 'planner' }, { role: 'planner' }),
    ).resolves.toMatchObject({
      provider: planner,
      model: 'plan-model',
      reason: 'role:planner',
    })
    await expect(
      router.pick({ ...ctx, turnId: 'coder' }, { role: 'coder' }),
    ).resolves.toMatchObject({
      provider: coder,
      model: 'code-model',
      reason: 'role:coder',
    })
    await expect(
      router.pick({ ...ctx, turnId: 'reviewer' }, { role: 'reviewer' }),
    ).resolves.toMatchObject({
      provider: reviewer,
      model: 'review-model',
      reason: 'role:reviewer',
    })
    await expect(router.pick({ ...ctx, turnId: 'chat' }, { role: 'chat' })).resolves.toMatchObject({
      provider: coder,
      model: 'chat-model',
      reason: 'role:default',
    })
  })

  it('gives explicit provider/model and model-only hints precedence', async () => {
    const registry = registryWith(client, otherClient)
    const router = new RoleRouter(registry, {
      roles: { coder: { provider: 'fake', model: 'code' } },
      default: { provider: 'fake', model: 'chat' },
    })
    await expect(
      router.pick(
        { ...ctx, turnId: 'explicit-provider' },
        { role: 'coder', explicitModel: 'other/special' },
      ),
    ).resolves.toMatchObject({
      provider: otherClient,
      model: 'special',
      reason: 'explicit-provider',
    })
    await expect(
      router.pick(
        { ...ctx, turnId: 'explicit-model' },
        { role: 'coder', explicitModel: 'code-fast' },
      ),
    ).resolves.toMatchObject({ provider: client, model: 'code-fast', reason: 'role:coder' })
  })

  it('keeps a sticky provider in-turn and reselects on the next turn', async () => {
    const registry = registryWith(client, otherClient)
    const router = new RoleRouter(registry, {
      roles: {
        planner: { provider: 'fake', model: 'plan' },
        reviewer: { provider: 'other', model: 'review' },
      },
      default: { provider: 'fake', model: 'chat' },
    })
    await router.pick({ ...ctx, turnId: 'turn-a' }, { role: 'planner' })
    await expect(
      router.pick(
        { ...ctx, turnId: 'turn-a', session: { ...ctx.session, stickyProvider: 'fake' } },
        { role: 'reviewer' },
      ),
    ).resolves.toMatchObject({ provider: client, model: 'plan', reason: 'sticky-provider' })
    await expect(
      router.pick({ ...ctx, turnId: 'turn-b' }, { role: 'reviewer' }),
    ).resolves.toMatchObject({ provider: otherClient, model: 'review' })
  })

  it('only admits plugin providers through explicit role configuration or explicit hints', async () => {
    const plugin = { ...client, name: 'plugin-vllm' } as ProviderClient
    const registry = registryWith(client, plugin)
    const coreOnly = new RoleRouter(registry, { default: { provider: 'fake', model: 'chat' } })
    expect((await coreOnly.pick(ctx)).provider).toBe(client)
    await expect(
      coreOnly.pick({ ...ctx, turnId: 'plugin-explicit' }, { explicitModel: 'plugin-vllm/llama' }),
    ).resolves.toMatchObject({ provider: plugin, model: 'llama' })
    const optedIn = new RoleRouter(registry, {
      roles: { coder: { provider: 'plugin-vllm', model: 'llama' } },
      default: { provider: 'fake', model: 'chat' },
    })
    expect(
      (await optedIn.pick({ ...ctx, turnId: 'plugin-role' }, { role: 'coder' })).provider,
    ).toBe(plugin)
    expect(
      () => new RoleRouter(registry, { default: { provider: 'plugin-vllm', model: 'llama' } }),
    ).toThrow('plugin_provider_cannot_be_default_v1')
  })

  it('delegates retry, fallback, cooldown, budgets, and failure propagation', async () => {
    let now = 0
    const sleep = vi.fn(async () => {})
    const registry = registryWith(client, otherClient)
    const router = new RoleRouter(
      registry,
      {
        roles: {
          coder: [
            { provider: 'fake', model: 'primary', priority: 100 },
            { provider: 'other', model: 'secondary', priority: 50 },
          ],
        },
        default: { provider: 'fake', model: 'chat' },
      },
      { clock: () => now, cooldownMs: 100, sleep },
    )
    const turn = { ...ctx, turnId: 'fallback-turn' }
    await router.pick(turn, { role: 'coder' })
    await expect(router.onError(providerError('fake', 'rate_limit'), turn)).resolves.toMatchObject({
      provider: otherClient,
      reason: 'fallback',
    })
    expect((await router.pick({ ...ctx, turnId: 'cooldown' }, { role: 'coder' })).provider).toBe(
      otherClient,
    )
    now = 101
    expect((await router.pick({ ...ctx, turnId: 'half-open' }, { role: 'coder' })).provider).toBe(
      client,
    )
    expect(await router.onError(providerError('fake', 'auth'), turn)).toBe('give-up')
    await expect(
      router.pick(
        {
          ...ctx,
          turnId: 'budget',
          budget: { costUSDMax: 1 },
          session: { ...ctx.session, cumulativeCostUSD: 1 },
        },
        { role: 'coder' },
      ),
    ).rejects.toThrow('router_budget_exhausted')
    expect(
      await router.onError(providerError('fake', 'network'), { ...ctx, turnId: 'unknown' }),
    ).toBe('give-up')
  })

  it('fails closed for missing providers, empty candidates, and duplicate provider chains', () => {
    const registry = registryWith(client)
    expect(() => new RoleRouter(registry, {})).toThrow('role_router_default_missing')
    expect(
      () => new RoleRouter(registry, { default: { provider: 'missing', model: 'x' } }),
    ).toThrow('provider_not_registered: missing')
    expect(
      () =>
        new RoleRouter(registry, {
          roles: {
            coder: [
              { provider: 'fake', model: 'a' },
              { provider: 'fake', model: 'b' },
            ],
          },
          default: { provider: 'fake', model: 'chat' },
        }),
    ).toThrow('fallback_provider_duplicate: fake')
    expect(() =>
      parseRoleRouterConfig({ default: { provider: 'fake', model: 'chat' }, roles: { coder: [] } }),
    ).toThrow('role_router_candidates_empty: coder')
    expect(() => parseRoleRouterConfig({ default: { provider: 'fake', model: '' } })).toThrow(
      'role_router_route_invalid: default',
    )
    expect(() =>
      parseRoleRouterConfig({
        default: { provider: 'fake', model: 'chat' },
        roles: { typo: { provider: 'fake', model: 'x' } },
      }),
    ).toThrow('role_router_role_unknown: typo')
  })

  it('bounds remembered turn routes to prevent unbounded routing state', async () => {
    const registry = registryWith(client)
    const router = new RoleRouter(
      registry,
      { default: { provider: 'fake', model: 'chat' } },
      { maxTrackedTurns: 2, sleep: async () => {} },
    )
    for (const turnId of ['oldest', 'middle', 'newest']) await router.pick({ ...ctx, turnId })
    expect(
      await router.onError(providerError('fake', 'network'), { ...ctx, turnId: 'oldest' }),
    ).toBe('give-up')
    expect(
      await router.onError(providerError('fake', 'network'), { ...ctx, turnId: 'newest' }),
    ).toMatchObject({ provider: client, reason: 'retry' })
  })
})
