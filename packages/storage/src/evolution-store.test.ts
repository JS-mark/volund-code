import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CONTEXT_TUNABLE_DEFAULTS,
  EVOLUTION_DEFAULTS,
  type EvolutionRecord,
} from '@apollo-code/core'
import { describe, expect, it } from 'vitest'

import { EvolutionStore, type EvolutionStoreDiagnostic, TuningMemoryStore } from './evolution-store'

const legacyContextRecord = (overrides: Record<string, unknown> = {}) => ({
  namespace: 'context',
  param: 'target_ratio',
  before: 0.6,
  after: 0.55,
  at: '2026-01-01T00:00:00.000Z',
  reason: 'bounded adjustment',
  signal: { rate: 1 },
  action: 'adjusted',
  ...overrides,
})

const contextRecord = (overrides: Partial<EvolutionRecord> = {}): EvolutionRecord => ({
  schemaVersion: 1,
  namespace: 'context',
  param: 'target_ratio',
  before: 0.6,
  after: 0.55,
  at: '2026-01-01T00:00:00.000Z',
  reason: 'bounded adjustment',
  signal: { rate: 1 },
  action: 'adjusted',
  ...overrides,
})

const lines = (values: readonly unknown[]) =>
  `${values.map((value) => JSON.stringify(value)).join('\n')}\n`

describe('evolution persistence', () => {
  it('writes sanitized V1 records and recovers around invalid lines without losing prior state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-tuning-'))
    const diagnostics: EvolutionStoreDiagnostic[] = []
    const store = new EvolutionStore(root, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    await store.append(contextRecord({ reason: 'Bearer secret', signal: { token_count: 42 } }))
    await writeFile(
      join(root, 'context.jsonl'),
      `${JSON.stringify(legacyContextRecord({ after: -1 }))}\n{corrupt}\n`,
      { flag: 'a' },
    )
    await store.append(
      contextRecord({
        param: 'keep_recent',
        before: 20,
        after: 22,
        at: '2026-01-02T00:00:00.000Z',
        signal: {},
      }),
    )

    expect(await store.current('context')).toEqual({
      ...CONTEXT_TUNABLE_DEFAULTS,
      target_ratio: 0.55,
      keep_recent: 22,
    })
    const auditText = await readFile(join(root, 'audit.jsonl'), 'utf8')
    expect(auditText).not.toContain('Bearer secret')
    expect(auditText).toContain('"token_count":42')
    expect(auditText).toContain('"schemaVersion":1')
    expect(diagnostics).toContainEqual({
      code: 'evolution_record_invalid',
      namespace: 'context',
      param: 'target_ratio',
    })

    const rolledBack = await store.rollback('context')
    expect(rolledBack).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        param: 'keep_recent',
        after: 20,
        action: 'rolled_back',
      }),
    ])
  })

  it('accepts strict legacy-v0 as compatibility state without rewriting the source file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-tuning-legacy-'))
    const legacy = legacyContextRecord({ after: 0.5, reason: 'Bearer legacy-secret' })
    await writeFile(join(root, 'context.jsonl'), lines([legacy]))
    await writeFile(join(root, 'audit.jsonl'), lines([legacy]))
    const store = new EvolutionStore(root)

    expect(await store.current('context')).toEqual({
      ...CONTEXT_TUNABLE_DEFAULTS,
      target_ratio: 0.5,
    })
    const audit = await store.audit('context')
    expect(audit).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        provenance: 'legacy-v0',
        namespace: 'context',
        param: 'target_ratio',
        after: 0.5,
      }),
    ])
    expect(JSON.stringify(audit)).not.toContain('legacy-secret')
    expect(await readFile(join(root, 'context.jsonl'), 'utf8')).not.toContain('schemaVersion')
  })

  it('does not downgrade future, null, or string schema versions to legacy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-tuning-schema-'))
    const diagnostics: EvolutionStoreDiagnostic[] = []
    const store = new EvolutionStore(root, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    await writeFile(
      join(root, 'context.jsonl'),
      lines([
        legacyContextRecord({ after: 0.5 }),
        { ...legacyContextRecord({ after: 0.45 }), schemaVersion: null },
        { ...legacyContextRecord({ after: 0.45 }), schemaVersion: '1' },
      ]),
    )
    expect(await store.current('context')).toEqual({
      ...CONTEXT_TUNABLE_DEFAULTS,
      target_ratio: 0.5,
    })

    await writeFile(
      join(root, 'context.jsonl'),
      `${JSON.stringify({ schemaVersion: 2, namespace: 'context' })}\n`,
      { flag: 'a' },
    )
    expect(await store.current('context')).toEqual(CONTEXT_TUNABLE_DEFAULTS)
    await expect(store.rollback('context')).resolves.toEqual([])
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'evolution_record_invalid', namespace: 'context' }),
        { code: 'evolution_record_future_schema', namespace: 'context' },
      ]),
    )
  })

  it('strictly rejects unknown fields, params, namespace mismatch, bad time/signal, and oversized lines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-tuning-strict-'))
    const diagnostics: EvolutionStoreDiagnostic[] = []
    const store = new EvolutionStore(root, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    const oversized = `{"${'x'.repeat(17 * 1024)}":1}\n`
    await writeFile(
      join(root, 'context.jsonl'),
      lines([
        contextRecord({ after: 0.5 }),
        { ...contextRecord({ after: 0.45 }), extra: true },
        contextRecord({ param: 'future_param', after: 0.45 }),
        contextRecord({ namespace: 'retry', param: 'max_retries', before: 2, after: 3 }),
        contextRecord({ at: 'not-a-time', after: 0.45 }),
        contextRecord({ signal: { rate: null as unknown as number }, after: 0.45 }),
        contextRecord({ before: 0.5, after: 0.5, action: 'adjusted' }),
      ]),
    )
    await writeFile(join(root, 'context.jsonl'), oversized, { flag: 'a' })

    expect(await store.current('context')).toEqual({
      ...CONTEXT_TUNABLE_DEFAULTS,
      target_ratio: 0.5,
    })
    expect(diagnostics.filter(({ code }) => code === 'evolution_record_invalid').length).toBe(6)
    expect(diagnostics).toContainEqual({
      code: 'evolution_record_line_too_large',
      namespace: 'context',
    })
    expect(JSON.stringify(diagnostics)).not.toContain('future_param')
    expect(JSON.stringify(diagnostics)).not.toContain('not-a-time')
  })

  it('rejects context continuity breaks and namespace-local clock regression', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-tuning-chain-'))
    const diagnostics: EvolutionStoreDiagnostic[] = []
    const store = new EvolutionStore(root, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    await writeFile(
      join(root, 'context.jsonl'),
      lines([
        contextRecord({ after: 0.5, at: '2026-01-02T00:00:00.000Z' }),
        contextRecord({ before: 0.6, after: 0.45, at: '2026-01-03T00:00:00.000Z' }),
        contextRecord({ before: 0.5, after: 0.45, at: '2026-01-01T00:00:00.000Z' }),
      ]),
    )

    expect(await store.current('context')).toEqual({
      ...CONTEXT_TUNABLE_DEFAULTS,
      target_ratio: 0.5,
    })
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        {
          code: 'evolution_record_continuity',
          namespace: 'context',
          param: 'target_ratio',
        },
        {
          code: 'evolution_record_time_regression',
          namespace: 'context',
          param: 'target_ratio',
        },
      ]),
    )
  })

  it('skips a cross-field-invalid item while retaining the preceding valid snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-tuning-cross-'))
    const diagnostics: EvolutionStoreDiagnostic[] = []
    const store = new EvolutionStore(root, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    await writeFile(
      join(root, 'context.jsonl'),
      lines([
        contextRecord({ param: 'target_ratio', before: 0.6, after: 0.75 }),
        contextRecord({ param: 'compaction_threshold', before: 0.85, after: 0.8 }),
      ]),
    )

    expect(await store.current('context')).toEqual({
      ...CONTEXT_TUNABLE_DEFAULTS,
      target_ratio: 0.75,
    })
    expect(diagnostics).toContainEqual({
      code: 'evolution_record_cross_constraint',
      namespace: 'context',
      param: 'compaction_threshold',
    })
  })

  it('orders multi-parameter rollback so every intermediate context snapshot remains safe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-tuning-rollback-order-'))
    await writeFile(
      join(root, 'context.jsonl'),
      lines([
        contextRecord({ before: 0.6, after: 0.45, at: '2026-01-01T00:00:00.000Z' }),
        contextRecord({
          param: 'compaction_threshold',
          before: 0.85,
          after: 0.65,
          at: '2026-01-02T00:00:00.000Z',
        }),
        contextRecord({
          param: 'compaction_threshold',
          before: 0.65,
          after: 0.95,
          at: '2026-01-03T00:00:00.000Z',
        }),
        contextRecord({ before: 0.45, after: 0.75, at: '2026-01-04T00:00:00.000Z' }),
      ]),
    )
    const store = new EvolutionStore(root)

    await expect(store.rollback('context', new Date('2026-01-02T00:00:00.000Z'))).resolves.toEqual([
      expect.objectContaining({ param: 'target_ratio', before: 0.75, after: 0.45 }),
      expect.objectContaining({ param: 'compaction_threshold', before: 0.95, after: 0.65 }),
    ])
    await expect(store.current('context')).resolves.toEqual({
      ...CONTEXT_TUNABLE_DEFAULTS,
      compaction_threshold: 0.65,
      target_ratio: 0.45,
    })
  })

  it('normalizes strict legacy append input to V1 and rejects unsafe append objects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-tuning-append-'))
    const store = new EvolutionStore(root)
    await store.append(legacyContextRecord() as unknown as EvolutionRecord)
    expect(await readFile(join(root, 'context.jsonl'), 'utf8')).toContain('"schemaVersion":1')

    await expect(
      store.append({ ...contextRecord(), unknown: true } as EvolutionRecord),
    ).rejects.toThrow('invalid evolution record')
    const accessor = contextRecord()
    Object.defineProperty(accessor, 'reason', { enumerable: true, get: () => 'unsafe getter' })
    await expect(store.append(accessor)).rejects.toThrow('invalid evolution record')
    await expect(store.append(new Proxy(contextRecord(), {}))).rejects.toThrow(
      'invalid evolution record',
    )
    await store.append(contextRecord({ before: 0.55, after: 0.75 }))
    await expect(
      store.append(
        contextRecord({
          param: 'compaction_threshold',
          before: 0.85,
          after: 0.8,
        }),
      ),
    ).rejects.toThrow('violates context bounds')
    await expect(
      store.append(contextRecord({ param: 'keep_recent', before: 21, after: 22 })),
    ).rejects.toThrow('continuity mismatch')
    await expect(
      store.append(
        contextRecord({
          param: 'keep_recent',
          before: 20,
          after: 22,
          at: '2025-01-01T00:00:00.000Z',
        }),
      ),
    ).rejects.toThrow('time regression')
    expect((await readFile(join(root, 'context.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2)
  })

  it('validates append values and namespace authority before resolving any storage path', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'apollo-tuning-path-boundary-'))
    const root = join(parent, 'not-created')
    const store = new EvolutionStore(root)
    const tooManySignals = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`signal_${index}`, index]),
    )
    const invalid = [
      contextRecord({ namespace: '../escaped' as 'context' }),
      contextRecord({ after: Number.POSITIVE_INFINITY }),
      contextRecord({ param: 'keep_recent', before: 20, after: 20.5 }),
      contextRecord({ reason: 'x'.repeat(1025) }),
      contextRecord({ signal: tooManySignals }),
    ]

    for (const record of invalid)
      await expect(store.append(record)).rejects.toThrow('invalid evolution record')
    await expect(access(root)).rejects.toThrow()
    await expect(access(join(parent, 'escaped.jsonl'))).rejects.toThrow()
  })

  it('keeps non-context current and rollback deny-only while retaining validated audit history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-tuning-non-context-'))
    const diagnostics: EvolutionStoreDiagnostic[] = []
    const store = new EvolutionStore(root, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    await store.append({
      schemaVersion: 1,
      namespace: 'retry',
      param: 'max_retries',
      before: 2,
      after: 3,
      at: '2026-01-01T00:00:00.000Z',
      reason: 'history only',
      signal: {},
      action: 'adjusted',
    })

    expect(await store.audit('retry')).toHaveLength(1)
    expect(await store.current('retry')).toEqual(EVOLUTION_DEFAULTS.retry)
    expect(await store.rollback('retry')).toEqual([])
    expect(diagnostics).toEqual([
      { code: 'evolution_namespace_apply_unsupported', namespace: 'retry' },
      { code: 'evolution_namespace_apply_unsupported', namespace: 'retry' },
    ])
  })

  it('does not echo an invalid runtime namespace into diagnostics or resolve a file path', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'apollo-tuning-runtime-namespace-'))
    const root = join(parent, 'not-created')
    const diagnostics: EvolutionStoreDiagnostic[] = []
    const store = new EvolutionStore(root, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    const invalidNamespace = '../secret' as unknown as 'context'

    await expect(store.current(invalidNamespace)).resolves.toEqual({})
    await expect(store.rollback(invalidNamespace)).resolves.toEqual([])
    await expect(access(root)).rejects.toThrow()
    expect(diagnostics).toEqual([
      { code: 'evolution_namespace_apply_unsupported' },
      { code: 'evolution_namespace_apply_unsupported' },
    ])
    expect(JSON.stringify(diagnostics)).not.toContain('secret')
  })

  it('rejects invalid maintenance timestamps before reading or writing history', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'apollo-tuning-invalid-date-'))
    const root = join(parent, 'not-created')
    const store = new EvolutionStore(root)
    const invalid = new Date('invalid')

    await expect(store.audit(undefined, invalid)).rejects.toThrow(
      'invalid evolution audit timestamp',
    )
    await expect(store.rollback('context', invalid)).rejects.toThrow(
      'invalid evolution rollback timestamp',
    )
    await expect(access(root)).rejects.toThrow()
  })

  it('writes tuning-scoped evolution memory with sanitization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-memory-'))
    const store = new TuningMemoryStore(root)
    const memory = await store.write({ id: 'one', title: 'preference', body: 'Bearer secret' })
    expect(memory).toMatchObject({ scope: 'tuning', source: 'evolution' })
    expect((await store.read('one')).body).toContain('[REDACTED]')
  })

  it('serializes concurrent V1 appends without losing or interleaving records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-tuning-concurrent-'))
    const store = new EvolutionStore(root)
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        store.append({
          schemaVersion: 1,
          namespace: 'retry',
          param: 'max_retries',
          before: index,
          after: index + 1,
          at: new Date(index).toISOString(),
          reason: 'concurrent',
          signal: {},
          action: 'adjusted',
        }),
      ),
    )
    expect(await store.audit('retry')).toHaveLength(25)
    expect(await store.current('retry')).toEqual(EVOLUTION_DEFAULTS.retry)
    const namespaceLines = (await readFile(join(root, 'retry.jsonl'), 'utf8')).trim().split('\n')
    expect(namespaceLines).toHaveLength(25)
    for (const line of namespaceLines) expect(JSON.parse(line)).toMatchObject({ schemaVersion: 1 })
  }, 15_000)
})
