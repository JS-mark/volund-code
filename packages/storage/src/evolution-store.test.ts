import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { CONTEXT_TUNABLE_DEFAULTS, EVOLUTION_DEFAULTS, type EvolutionRecord } from '@volund/core'
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

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

const journalPathOf = (root: string) => join(root, '.evolution-txn.json')
const lockPathOf = (root: string) => join(root, '.evolution-lock.json')

/**
 * Rewinds a completed real append into a crafted crash state: removes the
 * appended line from the chosen files and writes the journal that a process
 * dying in `state` would have left behind.
 */
async function rewindAppend(
  root: string,
  options: { dropNamespace: boolean; dropAudit: boolean; state: string },
): Promise<{ recordLine: string }> {
  const namespacePath = join(root, 'context.jsonl')
  const auditPath = join(root, 'audit.jsonl')
  const namespaceContent = await readFile(namespacePath, 'utf8')
  const newline = namespaceContent.lastIndexOf('\n', namespaceContent.length - 2)
  const recordLine = namespaceContent.slice(newline + 1)
  const namespaceBefore = namespaceContent.slice(0, newline + 1)
  const auditContent = await readFile(auditPath, 'utf8')
  const auditBefore = auditContent.slice(0, auditContent.length - recordLine.length)
  const record = JSON.parse(recordLine) as { recordId: string; sequence: number }
  const journal = {
    auditPrefixDigest: sha256(Buffer.from(auditBefore, 'utf8')),
    auditSizeBefore: Buffer.byteLength(auditBefore, 'utf8'),
    namespace: 'context',
    namespaceFile: 'context.jsonl',
    namespacePrefixDigest: sha256(Buffer.from(namespaceBefore, 'utf8')),
    namespaceSizeBefore: Buffer.byteLength(namespaceBefore, 'utf8'),
    recordId: record.recordId,
    recordLine,
    schemaVersion: 1,
    sequence: record.sequence,
    state: options.state,
  }
  if (options.dropNamespace) await truncate(namespacePath, journal.namespaceSizeBefore)
  if (options.dropAudit) await truncate(auditPath, journal.auditSizeBefore)
  await writeFile(journalPathOf(root), `${JSON.stringify(journal)}\n`, 'utf8')
  return { recordLine }
}

describe('evolution persistence', () => {
  it('writes sanitized V2 records and recovers around invalid lines without losing prior state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund-tuning-'))
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
    expect(auditText).toContain('"schemaVersion":2')
    expect(diagnostics).toContainEqual({
      code: 'evolution_record_invalid',
      namespace: 'context',
      param: 'target_ratio',
    })
    expect(
      await access(journalPathOf(root)).then(
        () => true,
        () => false,
      ),
    ).toBe(false)

    const rolledBack = await store.rollback('context')
    expect(rolledBack).toEqual([
      expect.objectContaining({
        param: 'keep_recent',
        after: 20,
        action: 'rolled_back',
      }),
    ])
  })

  it('accepts strict legacy-v0 as compatibility state without rewriting the source file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund-tuning-legacy-'))
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
    const root = await mkdtemp(join(tmpdir(), 'volund-tuning-schema-'))
    const diagnostics: EvolutionStoreDiagnostic[] = []
    const store = new EvolutionStore(root, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    await writeFile(
      join(root, 'context.jsonl'),
      lines([
        legacyContextRecord({ at: '2026-01-01T00:00:00.000Z' }),
        contextRecord({ at: '2026-01-02T00:00:00.000Z' }),
        { ...contextRecord({ at: '2026-01-03T00:00:00.000Z' }), recordId: 'nothex' },
        {
          ...contextRecord({ at: '2026-01-03T00:00:00.000Z' }),
          recordId: 'a'.repeat(32),
          sequence: 1.5,
        },
      ]),
    )
    expect(await store.current('context')).toEqual({
      ...CONTEXT_TUNABLE_DEFAULTS,
      target_ratio: 0.55,
    })

    await writeFile(
      join(root, 'context.jsonl'),
      `${JSON.stringify({ schemaVersion: 3, namespace: 'context' })}\n`,
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
    const root = await mkdtemp(join(tmpdir(), 'volund-tuning-strict-'))
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
        contextRecord({ at: '2026-02-30T00:00:00.000Z', after: 0.45 }),
        contextRecord({ at: '2026-01-01T24:00:00.000Z', after: 0.45 }),
      ]),
    )
    await writeFile(join(root, 'context.jsonl'), oversized, { flag: 'a' })

    expect(await store.current('context')).toEqual({
      ...CONTEXT_TUNABLE_DEFAULTS,
      target_ratio: 0.5,
    })
    expect(diagnostics.filter(({ code }) => code === 'evolution_record_invalid').length).toBe(8)
    expect(diagnostics).toContainEqual({
      code: 'evolution_record_line_too_large',
      namespace: 'context',
    })
    expect(JSON.stringify(diagnostics)).not.toContain('future_param')
    expect(JSON.stringify(diagnostics)).not.toContain('not-a-time')
  })

  it('rejects context continuity breaks and namespace-local clock regression', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund-tuning-chain-'))
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
    const root = await mkdtemp(join(tmpdir(), 'volund-tuning-cross-'))
    const diagnostics: EvolutionStoreDiagnostic[] = []
    const store = new EvolutionStore(root, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    await writeFile(
      join(root, 'context.jsonl'),
      lines([
        contextRecord({ param: 'target_ratio', before: 0.6, after: 0.75 }),
        contextRecord({
          param: 'compaction_threshold',
          before: 0.85,
          after: 0.8,
        }),
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
    const root = await mkdtemp(join(tmpdir(), 'volund-tuning-rollback-order-'))
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

  it('normalizes strict legacy append input to V2 identity and rejects unsafe append objects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund-tuning-append-'))
    const store = new EvolutionStore(root)
    await store.append(legacyContextRecord() as unknown as EvolutionRecord)
    const [written] = (await readFile(join(root, 'context.jsonl'), 'utf8')).trim().split('\n')
    const parsed = JSON.parse(written!) as Record<string, unknown>
    expect(parsed.schemaVersion).toBe(2)
    expect(parsed.recordId).toMatch(/^[0-9a-f]{32}$/)
    expect(parsed.sequence).toBe(1)
    expect(
      await access(lockPathOf(root)).then(
        () => true,
        () => false,
      ),
    ).toBe(false)

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

  it('rejects a caller-supplied identity and reassigns it under the lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund-tuning-identity-'))
    const store = new EvolutionStore(root)
    const forged = {
      ...contextRecord(),
      schemaVersion: 2,
      recordId: 'f'.repeat(32),
      sequence: 42,
    } as unknown as EvolutionRecord
    await store.append(forged)
    const [line] = (await readFile(join(root, 'context.jsonl'), 'utf8')).trim().split('\n')
    const parsed = JSON.parse(line!) as Record<string, unknown>
    expect(parsed.recordId).not.toBe('f'.repeat(32))
    expect(parsed.sequence).toBe(1)
  })

  it('drops sequence regressions in a namespace file while keeping monotonic history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund-tuning-sequence-'))
    const diagnostics: EvolutionStoreDiagnostic[] = []
    const store = new EvolutionStore(root, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    const v2 = (sequence: number, at: string) => ({
      ...contextRecord({ at, namespace: 'retry', param: 'max_retries', before: 2, after: 3 }),
      schemaVersion: 2,
      recordId: sequence.toString(16).padStart(32, '0'),
      sequence,
    })
    await writeFile(
      join(root, 'retry.jsonl'),
      lines([
        {
          schemaVersion: 1,
          namespace: 'retry',
          param: 'max_retries',
          before: 2,
          after: 3,
          at: '2026-01-01T00:00:00.000Z',
          reason: 'ok',
          signal: {},
          action: 'adjusted',
        },
        v2(1, '2026-01-02T00:00:00.000Z'),
        v2(2, '2026-01-03T00:00:00.000Z'),
        v2(2, '2026-01-04T00:00:00.000Z'),
        v2(3, '2026-01-05T00:00:00.000Z'),
      ]),
    )
    await store.append({
      schemaVersion: 1,
      namespace: 'retry',
      param: 'max_retries',
      before: 3,
      after: 4,
      at: '2026-01-06T00:00:00.000Z',
      reason: 'next',
      signal: {},
      action: 'adjusted',
    })
    const fileText = await readFile(join(root, 'retry.jsonl'), 'utf8')
    const sequences = fileText
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { sequence?: number }).sequence)
    // The duplicate stays on disk (the store never rewrites history); the
    // regression is dropped from the accepted view, so the next identity
    // continues from the accepted maximum.
    expect(sequences).toEqual([undefined, 1, 2, 2, 3, 4])
    expect(diagnostics).toContainEqual({
      code: 'evolution_record_sequence_regression',
      namespace: 'retry',
    })
    await store.append({
      schemaVersion: 1,
      namespace: 'retry',
      param: 'max_retries',
      before: 4,
      after: 5,
      at: '2026-01-07T00:00:00.000Z',
      reason: 'next-accepted',
      signal: {},
      action: 'adjusted',
    })
    const finalSequences = (await readFile(join(root, 'retry.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { sequence?: number }).sequence)
    expect(finalSequences).toEqual([undefined, 1, 2, 2, 3, 4, 5])
  })

  it('validates append values and namespace authority before resolving any storage path', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'volund-tuning-path-boundary-'))
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
    const root = await mkdtemp(join(tmpdir(), 'volund-tuning-non-context-'))
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
    const parent = await mkdtemp(join(tmpdir(), 'volund-tuning-runtime-namespace-'))
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
    const parent = await mkdtemp(join(tmpdir(), 'volund-tuning-invalid-date-'))
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

  it('serializes concurrent V2 appends without losing or interleaving records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund-tuning-concurrent-'))
    const store = new EvolutionStore(root)
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        store.append({
          schemaVersion: 1,
          namespace: 'retry',
          param: 'max_retries',
          before: index,
          after: index + 1,
          at: '2026-01-01T00:00:00.000Z',
          reason: 'ok',
          signal: {},
          action: 'adjusted',
        }),
      ),
    )
    expect(await store.audit('retry')).toHaveLength(25)
    expect(await store.current('retry')).toEqual(EVOLUTION_DEFAULTS.retry)
    const namespaceLines = (await readFile(join(root, 'retry.jsonl'), 'utf8')).trim().split('\n')
    expect(namespaceLines).toHaveLength(25)
    const parsed = namespaceLines.map(
      (line) => JSON.parse(line) as { recordId: string; sequence: number },
    )
    expect(new Set(parsed.map((record) => record.recordId)).size).toBe(25)
    expect(parsed.map((record) => record.sequence)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    )
  }, 15_000)

  it('writes tuning-scoped evolution memory with sanitization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund-memory-'))
    const store = new TuningMemoryStore(root)
    const memory = await store.write({ id: 'one', title: 'preference', body: 'Bearer secret' })
    expect(memory).toMatchObject({ scope: 'tuning', source: 'evolution' })
    expect((await store.read('one')).body).toContain('[REDACTED]')
  })

  it('rejects tuning memory ids that would escape the memory root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'volund-memory-path-'))
    const root = join(parent, 'memory')
    const store = new TuningMemoryStore(root)
    for (const id of ['../escape', 'a/b', '.hidden', 'x'.repeat(65), '']) {
      await expect(store.write({ id, title: 't', body: 'b' })).rejects.toThrow(
        'invalid tuning memory id',
      )
      await expect(store.read(id)).rejects.toThrow('invalid tuning memory id')
    }
    await expect(access(root)).rejects.toThrow()
  })
})

describe('evolution journal recovery', () => {
  const seedAppend = async (root: string) => {
    const store = new EvolutionStore(root)
    await store.append(contextRecord({ reason: 'first' }))
    await store.append(contextRecord({ before: 0.55, after: 0.65, at: '2026-01-02T00:00:00.000Z' }))
  }

  it('treats a PREPARED journal with no writes as an aborted transaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund-tuning-journal-prepared-'))
    await seedAppend(root)
    const { recordLine } = await rewindAppend(root, {
      dropNamespace: true,
      dropAudit: true,
      state: 'PREPARED',
    })
    const diagnostics: EvolutionStoreDiagnostic[] = []
    const store = new EvolutionStore(root, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    expect(await store.current('context')).toEqual({
      ...CONTEXT_TUNABLE_DEFAULTS,
      target_ratio: 0.55,
    })
    expect(await store.audit('context')).toHaveLength(1)
    expect(await readFile(join(root, 'context.jsonl'), 'utf8')).not.toContain(recordLine)
    expect(diagnostics).toContainEqual({
      code: 'evolution_journal_recovery_aborted',
      namespace: 'context',
    })
    expect(
      await access(journalPathOf(root)).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  })

  it('aborts a torn namespace write back to the journalled pre-size', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund-tuning-journal-torn-'))
    await seedAppend(root)
    const { recordLine } = await rewindAppend(root, {
      dropNamespace: true,
      dropAudit: true,
      state: 'PREPARED',
    })
    await writeFile(join(root, 'context.jsonl'), Buffer.from(recordLine, 'utf8').subarray(0, 30), {
      flag: 'a',
    })
    const store = new EvolutionStore(root)
    expect(await store.current('context')).toEqual({
      ...CONTEXT_TUNABLE_DEFAULTS,
      target_ratio: 0.55,
    })
    expect((await readFile(join(root, 'context.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1)
    expect(
      await access(journalPathOf(root)).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  })

  it('aborts a NAMESPACE_DURABLE transaction that never reached audit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund-tuning-journal-nsdurable-'))
    await seedAppend(root)
    await rewindAppend(root, { dropNamespace: false, dropAudit: true, state: 'NAMESPACE_DURABLE' })
    const store = new EvolutionStore(root)
    expect(await store.current('context')).toEqual({
      ...CONTEXT_TUNABLE_DEFAULTS,
      target_ratio: 0.55,
    })
    expect(await store.audit('context')).toHaveLength(1)
    expect((await readFile(join(root, 'context.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('completes a BOTH_DURABLE transaction after proving both files carry the exact record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund-tuning-journal-both-'))
    await seedAppend(root)
    const { recordLine } = await rewindAppend(root, {
      dropNamespace: false,
      dropAudit: false,
      state: 'BOTH_DURABLE',
    })
    const diagnostics: EvolutionStoreDiagnostic[] = []
    const store = new EvolutionStore(root, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    expect(await store.current('context')).toEqual({
      ...CONTEXT_TUNABLE_DEFAULTS,
      target_ratio: 0.65,
    })
    const audit = await store.audit('context')
    expect(audit).toHaveLength(2)
    expect(audit.at(-1)).toMatchObject({
      provenance: 'v2',
      after: 0.65,
      recordId: (JSON.parse(recordLine) as { recordId: string }).recordId,
    })
    expect(diagnostics).toContainEqual({
      code: 'evolution_journal_recovery_completed',
      namespace: 'context',
    })
  })

  it('fails closed into RECOVERY_REQUIRED when bytes cannot be proven', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund-tuning-journal-foreign-'))
    await seedAppend(root)
    await rewindAppend(root, { dropNamespace: true, dropAudit: true, state: 'PREPARED' })
    await writeFile(join(root, 'context.jsonl'), '{"foreign":true}\n', { flag: 'a' })
    const diagnostics: EvolutionStoreDiagnostic[] = []
    const store = new EvolutionStore(root, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    expect(await store.current('context')).toEqual({
      ...CONTEXT_TUNABLE_DEFAULTS,
      target_ratio: 0.55,
    })
    await expect(
      store.append(contextRecord({ before: 0.65, after: 0.7, at: '2026-01-03T00:00:00.000Z' })),
    ).rejects.toThrow(/evolution recovery required/)
    expect(diagnostics).toContainEqual({ code: 'evolution_journal_recovery_required' })
    expect(await store.health()).toMatchObject({ journal: 'recovery-required', valid: false })
    expect(JSON.parse(await readFile(journalPathOf(root), 'utf8'))).toMatchObject({
      state: 'RECOVERY_REQUIRED',
    })
    // Manual intervention: removing the journal unblocks appends.
    await rm(journalPathOf(root))
    const fresh = new EvolutionStore(root)
    expect((await fresh.health()).journal).toBe('clean')
    await fresh.append(contextRecord({ before: 0.55, after: 0.7, at: '2026-01-03T00:00:00.000Z' }))
    expect(await fresh.current('context')).toEqual({
      ...CONTEXT_TUNABLE_DEFAULTS,
      target_ratio: 0.7,
    })
  })

  it('fails closed when the journal itself is unreadable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund-tuning-journal-corrupt-'))
    await seedAppend(root)
    await writeFile(journalPathOf(root), '{not-json', 'utf8')
    const store = new EvolutionStore(root)
    expect((await store.health()).journal).toBe('recovery-required')
    await expect(
      store.append(contextRecord({ before: 0.65, after: 0.7, at: '2026-01-03T00:00:00.000Z' })),
    ).rejects.toThrow(/evolution recovery required/)
    await rm(journalPathOf(root))
    expect((await new EvolutionStore(root).health()).journal).toBe('clean')
  })

  it('reports a clean journal on health when no transaction is in flight', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund-tuning-journal-clean-'))
    const store = new EvolutionStore(root)
    expect(await store.health()).toEqual({
      journal: 'clean',
      valid: true,
      detail: expect.stringContaining('clean'),
    })
    await store.append(contextRecord())
    expect(await store.health()).toMatchObject({ journal: 'clean', valid: true })
  })
})

describe('evolution cross-process coordination', () => {
  const storeSource = fileURLToPath(new URL('./evolution-store.ts', import.meta.url))
  const childScript = `
import { EvolutionStore } from ${JSON.stringify(pathToFileURL(storeSource).href)}
// With --eval, positional args start at process.argv[1].
const root = process.argv[1]
const namespace = process.argv[2]
const store = new EvolutionStore(root)
for (let index = 0; index < 5; index++) {
  await store.append({
    schemaVersion: 1,
    namespace,
    param: namespace === 'retry' ? 'max_retries' : 'cooldown_ms',
    before: index,
    after: index + 1,
    at: '2026-01-01T00:00:00.000Z',
    reason: 'child append',
    signal: {},
    action: 'adjusted',
  })
}
`
  const runChild = (script: string, root: string, ...args: string[]) =>
    new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [
          '--experimental-strip-types',
          '--no-warnings=ExperimentalWarning',
          '--eval',
          script,
          root,
          ...args,
        ],
        { timeout: 30_000 },
        (error, _stdout, stderr) => {
          if (error) reject(new Error(`${error.message}\n${stderr}`))
          else resolve()
        },
      )
    })

  it('serializes two concurrent writer processes with dense unique sequences', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund-tuning-two-process-'))
    await Promise.all([runChild(childScript, root, 'retry'), runChild(childScript, root, 'router')])
    for (const [namespace, param] of [
      ['retry', 'max_retries'],
      ['router', 'cooldown_ms'],
    ] as const) {
      const fileLines = (await readFile(join(root, `${namespace}.jsonl`), 'utf8'))
        .trim()
        .split('\n')
      expect(fileLines).toHaveLength(5)
      const parsed = fileLines.map(
        (line) => JSON.parse(line) as { recordId: string; sequence: number; param: string },
      )
      expect(parsed.every((record) => record.param === param)).toBe(true)
      expect(parsed.map((record) => record.sequence)).toEqual([1, 2, 3, 4, 5])
    }
    const auditLines = (await readFile(join(root, 'audit.jsonl'), 'utf8')).trim().split('\n')
    expect(auditLines).toHaveLength(10)
    for (const line of auditLines) expect(() => JSON.parse(line)).not.toThrow()
    expect(new Set(auditLines).size).toBe(10)
  }, 45_000)

  it('steals a stale lock whose holder process is dead and keeps appends working', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund-tuning-stale-lock-'))
    const holder = execFile(
      process.execPath,
      [
        '--eval',
        [
          "import { writeFile } from 'node:fs/promises'",
          `await writeFile(${JSON.stringify(lockPathOf(root))}, JSON.stringify({ schemaVersion: 1, pid: process.pid, acquiredAt: new Date().toISOString() }) + '\\n')`,
          "console.log('locked')",
          'setInterval(() => {}, 1000)',
        ].join('\n'),
      ],
      { timeout: 30_000 },
      () => {},
    )
    await new Promise<void>((resolve) => {
      holder.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('locked')) resolve()
      })
    })
    holder.kill('SIGKILL')
    const diagnostics: EvolutionStoreDiagnostic[] = []
    const store = new EvolutionStore(root, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    await store.append(contextRecord())
    expect(diagnostics).toContainEqual({ code: 'evolution_lock_stolen' })
    expect(await store.current('context')).toEqual({
      ...CONTEXT_TUNABLE_DEFAULTS,
      target_ratio: 0.55,
    })
  }, 30_000)
})
