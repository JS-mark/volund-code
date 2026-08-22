import { describe, expect, it, vi } from 'vitest'

import {
  CONTEXT_TUNABLE_BOUNDS,
  CONTEXT_TUNABLE_DEFAULTS,
  CONTEXT_TUNABLE_PARAMS,
  EVOLUTION_DEFAULTS,
  EvolutionEngine,
  type EvolutionRecord,
} from './evolution-engine'

const persistence = () => {
  const records: EvolutionRecord[] = []
  return {
    records,
    async current(namespace = 'context') {
      return Object.fromEntries(
        records
          .filter((record) => record.namespace === namespace)
          .map((record) => [record.param, record.after]),
      )
    },
    async append(record: EvolutionRecord) {
      records.push(record)
    },
    async audit() {
      return records.map((record) => ({ ...record, provenance: 'v1' as const }))
    },
  }
}
describe('EvolutionEngine', () => {
  it('whitelists context tuning and permanently excludes security boundaries', () => {
    expect(Object.keys(CONTEXT_TUNABLE_DEFAULTS)).toEqual([
      'compaction_threshold',
      'target_ratio',
      'keep_recent',
      'summary_keep_recent',
    ])
    expect(Object.keys(CONTEXT_TUNABLE_DEFAULTS)).not.toEqual(
      expect.arrayContaining(['sandbox', 'permission', 'untrusted', 'hook_priority']),
    )
    expect(CONTEXT_TUNABLE_BOUNDS).toEqual({
      compaction_threshold: { min: 0.65, max: 0.95, integer: false },
      target_ratio: { min: 0.45, max: 0.75, integer: false },
      keep_recent: { min: 15, max: 25, integer: true },
      summary_keep_recent: { min: 15, max: 25, integer: true },
    })
    expect(CONTEXT_TUNABLE_PARAMS).toEqual(Object.keys(CONTEXT_TUNABLE_BOUNDS))
    expect(Object.isFrozen(CONTEXT_TUNABLE_PARAMS)).toBe(true)
    expect(Object.isFrozen(CONTEXT_TUNABLE_BOUNDS)).toBe(true)
    for (const bound of Object.values(CONTEXT_TUNABLE_BOUNDS))
      expect(Object.isFrozen(bound)).toBe(true)
  })
  it('waits for a 20-event window and limits the adjustment step', async () => {
    const store = persistence(),
      engine = new EvolutionEngine(store, { enabled: true })
    for (let index = 0; index < 19; index++)
      expect(await engine.observe({ post_compact_repeat_rate: 1 })).toBeUndefined()
    expect((await engine.observe({ post_compact_repeat_rate: 1 }))?.after).toBe(0.9)
    expect((await engine.propose('compaction_threshold', 100, 'large suggestion', {}))?.after).toBe(
      0.95,
    )
  })
  it('rolls back worsening changes and stops after three', async () => {
    const store = persistence(),
      engine = new EvolutionEngine(store, { enabled: true })
    await engine.propose('target_ratio', 0.55, 'test', {})
    for (let index = 0; index < 3; index++)
      await engine.validate('target_ratio', true, { error_rate: 1 })
    expect(store.records.filter((record) => record.action === 'rolled_back')).toHaveLength(3)
    expect(store.records.at(-1)?.action).toBe('stopped')
    expect(await engine.propose('target_ratio', 0.5, 'ignored', {})).toBeUndefined()
  })
  it('defaults to disabled and returns defaults without reading persistence', async () => {
    const store = persistence()
    const current = vi.spyOn(store, 'current')
    const audit = vi.spyOn(store, 'audit')
    const append = vi.spyOn(store, 'append')
    store.records.push({
      schemaVersion: 1,
      namespace: 'context',
      param: 'target_ratio',
      before: 0.6,
      after: 0.5,
      at: '',
      reason: '',
      signal: {},
      action: 'adjusted',
    })
    const engine = new EvolutionEngine(store)
    expect((await engine.values()).target_ratio).toBe(0.6)
    await expect(engine.observe({ post_compact_repeat_rate: 1 })).resolves.toBeUndefined()
    await expect(
      engine.propose('target_ratio', 0.5, 'must remain disabled', {}),
    ).resolves.toBeUndefined()
    await expect(engine.validate('target_ratio', true, { error_rate: 1 })).resolves.toBeUndefined()
    expect(current).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
  })
  it('consumes audit history carrying T1b record identity without treating it as authority', async () => {
    const store = persistence()
    store.records.push({
      schemaVersion: 1,
      namespace: 'context',
      param: 'target_ratio',
      before: 0.6,
      after: 0.55,
      at: '2026-01-01T00:00:00.000Z',
      reason: 'test',
      signal: {},
      action: 'stopped',
      recordId: 'a'.repeat(32),
      sequence: 7,
    })
    const engine = new EvolutionEngine(store, { enabled: true })
    await expect(
      engine.propose('target_ratio', 0.5, 'must stay frozen', {}),
    ).resolves.toBeUndefined()
    expect(store.records).toHaveLength(1)
  })
  it.each(['true', 1, {}, undefined])(
    'does not treat non-boolean enabled value %j as authority',
    async (enabled) => {
      const store = persistence()
      const current = vi.spyOn(store, 'current')
      const engine = new EvolutionEngine(store, {
        enabled: enabled as unknown as boolean,
      })

      expect(engine.isEnabled('context')).toBe(false)
      expect(await engine.values()).toEqual(CONTEXT_TUNABLE_DEFAULTS)
      expect(current).not.toHaveBeenCalled()
    },
  )
  it('projects a valid partial context snapshot atomically over trusted defaults', async () => {
    const current = vi.fn(async () => ({ target_ratio: 0.5, keep_recent: 25 }))
    const engine = new EvolutionEngine(
      { current, append: vi.fn(async () => undefined) },
      { enabled: true },
    )

    await expect(engine.values()).resolves.toEqual({
      ...CONTEXT_TUNABLE_DEFAULTS,
      target_ratio: 0.5,
      keep_recent: 25,
    })
    expect(current).toHaveBeenCalledWith('context')
  })
  it.each([
    ['unknown key', { target_ratio: 0.5, future_projection: 1 }],
    ['infinite value', { target_ratio: Number.POSITIVE_INFINITY }],
    ['negative value', { target_ratio: -1 }],
    ['string value', { target_ratio: '0.5' }],
    ['fractional integer', { keep_recent: 20.5 }],
    ['cross-field violation', { compaction_threshold: 0.8, target_ratio: 0.75 }],
  ])('rejects the whole untrusted context snapshot for %s', async (_case, snapshot) => {
    const engine = new EvolutionEngine(
      { current: async () => snapshot, append: vi.fn(async () => undefined) },
      { enabled: true },
    )
    await expect(engine.values()).resolves.toEqual(CONTEXT_TUNABLE_DEFAULTS)
  })
  it('rejects accessor and Proxy persistence projections without invoking accessors', async () => {
    let getterCalled = false
    const accessor = {}
    Object.defineProperty(accessor, 'target_ratio', {
      enumerable: true,
      get() {
        getterCalled = true
        return 0.5
      },
    })
    const proxy = new Proxy(
      { target_ratio: 0.5 },
      {
        ownKeys() {
          throw new Error('must not inspect proxy traps')
        },
      },
    )
    for (const snapshot of [accessor, proxy]) {
      const engine = new EvolutionEngine(
        { current: async () => snapshot, append: vi.fn(async () => undefined) },
        { enabled: true },
      )
      await expect(engine.values()).resolves.toEqual(CONTEXT_TUNABLE_DEFAULTS)
    }
    expect(getterCalled).toBe(false)
  })
  it('does not read persisted values for namespaces without frozen bounds', async () => {
    const current = vi.fn(async () => ({ max_retries: 5 }))
    const engine = new EvolutionEngine(
      { current, append: vi.fn(async () => undefined) },
      { enabled: true },
    )
    await expect(engine.values('retry')).resolves.toEqual(EVOLUTION_DEFAULTS.retry)
    expect(current).not.toHaveBeenCalled()
  })
  it('preserves persistence I/O rejection instead of converting it to defaults', async () => {
    const failure = new Error('persistence unavailable')
    const engine = new EvolutionEngine(
      { current: async () => Promise.reject(failure), append: vi.fn(async () => undefined) },
      { enabled: true },
    )
    await expect(engine.values()).rejects.toBe(failure)
  })
  it('supports router, retry, and tool timeout windows with namespace switches', async () => {
    const store = persistence()
    const engine = new EvolutionEngine(store, {
      enabled: true,
      sampleWindow: 2,
      namespaces: ['retry', 'tool-timeout'],
    })
    expect(await engine.observe('router', { fallback_success_rate: 1 })).toBeUndefined()
    await engine.observe('retry', { retry_success_rate: 1 })
    expect(await engine.observe('retry', { retry_success_rate: 1 })).toMatchObject({
      namespace: 'retry',
      param: 'max_retries',
      before: 2,
      after: 2.2,
    })
    await engine.observe('tool-timeout', { timeout_rate: 1, user_retry_rate: 1 })
    expect(
      await engine.observe('tool-timeout', { timeout_rate: 1, user_retry_rate: 1 }),
    ).toMatchObject({
      namespace: 'tool-timeout',
      param: 'default_timeout_ms',
      after: 66_000,
    })
  })
  it('rejects unknown and security parameters and caps tool timeouts', async () => {
    const engine = new EvolutionEngine(persistence(), { enabled: true })
    for (const param of ['sandbox', 'permission', 'untrusted', 'hook_priority'])
      expect(await engine.propose('router', param, 1, 'unsafe', {})).toBeUndefined()
    expect(
      await engine.propose('tool-timeout', 'default_timeout_ms', 999_999, 'large', {}),
    ).toMatchObject({ after: 66_000 })
    expect(EVOLUTION_DEFAULTS['tool-timeout'].default_timeout_ms).toBeLessThanOrEqual(300_000)
  })
  it('requires configured confirmation within the frozen envelope and freezes after rejection', async () => {
    const store = persistence()
    const engine = new EvolutionEngine(store, {
      enabled: true,
      confirmationDeviation: 0.01,
      confirm: async () => false,
    })
    expect(await engine.propose('target_ratio', 0.55, 'cumulative', {})).toMatchObject({
      action: 'confirmation_rejected',
      after: 0.6,
    })
    expect(await engine.propose('target_ratio', 0.5, 'frozen', {})).toBeUndefined()
  })
})
