import { createHash, randomUUID } from 'node:crypto'
import { open, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  MemoryError,
  type MemoryListOptions,
  type MemoryMutationHookContext,
  type MemoryMutationHooks,
  type MemoryMutationOptions,
  type MemoryPage,
  type MemoryRecord,
  type MemoryRecordScope,
  type MemoryRepository,
  type MemoryService,
  type NewMemoryRecord,
  noMemoryMutationHooks,
} from './memory-runtime'

export const MEMORY_INDEX_SCHEMA_VERSION = 1 as const

export interface MemoryIndexCandidate {
  readonly id: string
  readonly score: number
  readonly sourceUpdatedAt: string
}

export interface MemoryIndex {
  search(query: string): Promise<readonly MemoryIndexCandidate[]>
  upsert(record: MemoryRecord): Promise<void>
  remove(id: string): Promise<void>
}

export type MemoryIndexHealthStatus = 'healthy' | 'missing' | 'dirty' | 'stale' | 'corrupt'

export interface MemoryIndexHealth {
  readonly status: MemoryIndexHealthStatus
  readonly healthy: boolean
  readonly detail: string
  readonly generation?: string
  readonly indexedRecords: number
  readonly sourceRecords?: number
}

export interface MemoryReindexOptions {
  readonly batchSize?: number
  readonly check?: boolean
  readonly force?: boolean
}

export interface MemoryReindexReport {
  readonly action: 'checked' | 'skipped' | 'rebuilt'
  readonly before: MemoryIndexHealth
  readonly after: MemoryIndexHealth
  readonly durationMs: number
  readonly processedRecords: number
}

export interface MemoryIndexMaintenance {
  health(records?: readonly MemoryRecord[]): Promise<MemoryIndexHealth>
  markDirty(reason: string): Promise<void>
  clearDirty(): Promise<void>
  reindex(
    records: readonly MemoryRecord[],
    options?: MemoryReindexOptions,
  ): Promise<MemoryReindexReport>
}

export interface MemoryRecallOptions {
  readonly limit?: number
  readonly tags?: readonly string[]
}

export interface MemoryRecallHit {
  readonly record: MemoryRecord
  readonly score: number
}

export interface MemoryRecallService {
  recall(
    scope: MemoryRecordScope,
    query: string,
    options?: MemoryRecallOptions,
  ): Promise<readonly MemoryRecallHit[]>
}

export interface MemoryDoctorIssue {
  readonly path: string
  readonly reason: string
}

export interface MemoryDoctorReport {
  readonly healthy: boolean
  readonly facts: {
    readonly healthy: boolean
    readonly records: number
    readonly detail: string
  }
  readonly index: MemoryIndexHealth
  /** Files the repository skipped at load time (invalid frontmatter, …). */
  readonly issues?: readonly MemoryDoctorIssue[]
}

export interface MemoryMaintenanceService {
  doctor(): Promise<MemoryDoctorReport>
  reindex(options?: MemoryReindexOptions): Promise<MemoryReindexReport>
}

interface MemoryIndexDocument {
  readonly id: string
  readonly sourceDigest: string
  readonly sourceUpdatedAt: string
  readonly terms: Readonly<Record<string, number>>
}

interface MemoryIndexSnapshotV1 {
  readonly schemaVersion: typeof MEMORY_INDEX_SCHEMA_VERSION
  readonly generation: string
  readonly builtAt: string
  readonly sourceFingerprint: string
  readonly documents: readonly MemoryIndexDocument[]
}

export interface LocalKeywordMemoryIndexOptions {
  /** Test-only interruption hook invoked after each completed batch. */
  readonly afterBatch?: (processedRecords: number) => void | Promise<void>
  readonly now?: () => Date
}

type SnapshotRead =
  | { readonly ok: true; readonly snapshot: MemoryIndexSnapshotV1 }
  | { readonly ok: false; readonly missing: boolean; readonly error: unknown }

export class LocalKeywordMemoryIndex implements MemoryIndex, MemoryIndexMaintenance {
  readonly #backupPath: string
  readonly #dirtyPath: string
  readonly #lockPath: string
  readonly #now: () => Date
  #writeQueue = Promise.resolve()

  constructor(
    readonly path: string,
    readonly options: LocalKeywordMemoryIndexOptions = {},
  ) {
    this.#backupPath = `${path}.bak`
    this.#dirtyPath = `${path}.dirty`
    this.#lockPath = `${path}.lock`
    this.#now = options.now ?? (() => new Date())
  }

  async search(query: string): Promise<readonly MemoryIndexCandidate[]> {
    const queryTerms = tokenize(query)
    if (!queryTerms.length)
      throw new MemoryError('memory_validation', 'Memory search query has no keywords')
    const snapshot = await this.#loadSearchSnapshot()
    const uniqueTerms = [...new Set(queryTerms)]
    return snapshot.documents
      .map((document) => {
        let score = 0
        let matched = 0
        for (const term of uniqueTerms) {
          const frequency = document.terms[term] ?? 0
          if (frequency > 0) {
            matched++
            score += 1 + Math.log2(frequency)
          }
        }
        return {
          id: document.id,
          score: score + matched / uniqueTerms.length,
          sourceUpdatedAt: document.sourceUpdatedAt,
        }
      })
      .filter((candidate) => candidate.score > 0)
      .toSorted((left, right) => right.score - left.score || left.id.localeCompare(right.id))
  }

  async upsert(record: MemoryRecord): Promise<void> {
    if (record.deletedAt) return this.remove(record.id)
    await this.#write(async () => {
      const release = await this.#acquireLock(false)
      try {
        const snapshot = await this.#requirePrimarySnapshot()
        const documents = snapshot.documents.filter((document) => document.id !== record.id)
        documents.push(toDocument(record))
        await this.#saveSnapshot({
          ...snapshot,
          generation: randomUUID(),
          builtAt: this.#now().toISOString(),
          sourceFingerprint: fingerprintDocuments(documents),
          documents: documents.toSorted((left, right) => left.id.localeCompare(right.id)),
        })
      } finally {
        await release()
      }
    })
  }

  async remove(id: string): Promise<void> {
    await this.#write(async () => {
      const release = await this.#acquireLock(false)
      try {
        const snapshot = await this.#requirePrimarySnapshot()
        const documents = snapshot.documents.filter((document) => document.id !== id)
        if (documents.length === snapshot.documents.length) return
        await this.#saveSnapshot({
          ...snapshot,
          generation: randomUUID(),
          builtAt: this.#now().toISOString(),
          sourceFingerprint: fingerprintDocuments(documents),
          documents,
        })
      } finally {
        await release()
      }
    })
  }

  async health(records?: readonly MemoryRecord[]): Promise<MemoryIndexHealth> {
    const dirty = await fileExists(this.#dirtyPath)
    const primary = await this.#readSnapshot(this.path)
    if (!primary.ok) {
      return {
        status: primary.missing ? (dirty ? 'dirty' : 'missing') : 'corrupt',
        healthy: false,
        detail: primary.missing
          ? dirty
            ? 'index is missing and recovery is required'
            : 'index has not been built'
          : `index snapshot is corrupt: ${errorMessage(primary.error)}`,
        indexedRecords: 0,
        ...(records ? { sourceRecords: activeRecords(records).length } : {}),
      }
    }
    const source = records ? activeRecords(records) : undefined
    if (dirty) {
      return {
        status: 'dirty',
        healthy: false,
        detail: 'an interrupted or failed incremental update requires reindexing',
        generation: primary.snapshot.generation,
        indexedRecords: primary.snapshot.documents.length,
        ...(source ? { sourceRecords: source.length } : {}),
      }
    }
    if (
      source &&
      (source.length !== primary.snapshot.documents.length ||
        fingerprintRecords(source) !== primary.snapshot.sourceFingerprint)
    ) {
      return {
        status: 'stale',
        healthy: false,
        detail: 'index generation does not match the fact store',
        generation: primary.snapshot.generation,
        indexedRecords: primary.snapshot.documents.length,
        sourceRecords: source.length,
      }
    }
    return {
      status: 'healthy',
      healthy: true,
      detail: 'index snapshot matches the fact store',
      generation: primary.snapshot.generation,
      indexedRecords: primary.snapshot.documents.length,
      ...(source ? { sourceRecords: source.length } : {}),
    }
  }

  async markDirty(reason: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const file = await open(this.#dirtyPath, 'w', 0o600)
    try {
      await file.writeFile(
        JSON.stringify({ reason, pid: process.pid, at: this.#now().toISOString() }),
      )
      await file.sync()
    } finally {
      await file.close()
    }
  }

  async clearDirty(): Promise<void> {
    await rm(this.#dirtyPath, { force: true })
  }

  async reindex(
    records: readonly MemoryRecord[],
    options: MemoryReindexOptions = {},
  ): Promise<MemoryReindexReport> {
    return this.#write(() => this.#reindex(records, options))
  }

  async #reindex(
    records: readonly MemoryRecord[],
    options: MemoryReindexOptions,
  ): Promise<MemoryReindexReport> {
    const startedAt = Date.now()
    const batchSize = options.batchSize ?? 250
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000)
      throw new MemoryError(
        'memory_validation',
        'Memory reindex batch size must be between 1 and 10000',
      )
    const before = await this.health(records)
    if (options.check) {
      return {
        action: 'checked',
        before,
        after: before,
        durationMs: Date.now() - startedAt,
        processedRecords: 0,
      }
    }
    if (before.healthy && !options.force) {
      return {
        action: 'skipped',
        before,
        after: before,
        durationMs: Date.now() - startedAt,
        processedRecords: 0,
      }
    }
    const release = await this.#acquireLock(options.force === true)
    try {
      const current = await this.health(records)
      if (current.healthy && !options.force) {
        return {
          action: 'skipped',
          before,
          after: current,
          durationMs: Date.now() - startedAt,
          processedRecords: 0,
        }
      }
      const source = activeRecords(records)
      const documents: MemoryIndexDocument[] = []
      for (let offset = 0; offset < source.length; offset += batchSize) {
        const batch = source.slice(offset, offset + batchSize)
        documents.push(...batch.map(toDocument))
        await this.options.afterBatch?.(Math.min(offset + batch.length, source.length))
      }
      await this.#saveSnapshot({
        schemaVersion: MEMORY_INDEX_SCHEMA_VERSION,
        generation: randomUUID(),
        builtAt: this.#now().toISOString(),
        sourceFingerprint: fingerprintRecords(source),
        documents: documents.toSorted((left, right) => left.id.localeCompare(right.id)),
      })
      await this.clearDirty()
      const after = await this.health(records)
      return {
        action: 'rebuilt',
        before,
        after,
        durationMs: Date.now() - startedAt,
        processedRecords: source.length,
      }
    } finally {
      await release()
    }
  }

  async #write<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.#writeQueue.then(operation)
    this.#writeQueue = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }

  async #requirePrimarySnapshot(): Promise<MemoryIndexSnapshotV1> {
    const primary = await this.#readSnapshot(this.path)
    if (primary.ok) return primary.snapshot
    throw new MemoryError(
      primary.missing ? 'memory_index_unavailable' : 'memory_index_corrupt',
      primary.missing ? 'Memory index has not been built' : 'Memory index is corrupt',
      { cause: primary.error },
    )
  }

  async #loadSearchSnapshot(): Promise<MemoryIndexSnapshotV1> {
    const primary = await this.#readSnapshot(this.path)
    if (primary.ok) return primary.snapshot
    const backup = await this.#readSnapshot(this.#backupPath)
    if (backup.ok) return backup.snapshot
    throw new MemoryError(
      primary.missing && backup.missing ? 'memory_index_unavailable' : 'memory_index_corrupt',
      'No readable memory index generation is available',
      { cause: primary.error ?? backup.error },
    )
  }

  async #readSnapshot(path: string): Promise<SnapshotRead> {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as unknown
      return { ok: true, snapshot: parseSnapshot(value) }
    } catch (error) {
      return { ok: false, missing: (error as NodeJS.ErrnoException).code === 'ENOENT', error }
    }
  }

  async #saveSnapshot(snapshot: MemoryIndexSnapshotV1): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(snapshot))
      await file.sync()
    } catch (error) {
      await file.close().catch(() => undefined)
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
    await file.close()
    try {
      await rm(this.#backupPath, { force: true })
      await rename(this.path, this.#backupPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      await rename(temporary, this.path)
      if (process.platform !== 'win32') {
        const directory = await open(dirname(this.path), 'r')
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      }
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      await rename(this.#backupPath, this.path).catch(() => undefined)
      throw new MemoryError('memory_io', 'Unable to persist memory index', { cause: error })
    }
  }

  async #acquireLock(force: boolean): Promise<() => Promise<void>> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const file = await open(this.#lockPath, 'wx', 0o600)
        await file.writeFile(JSON.stringify({ pid: process.pid, at: this.#now().toISOString() }))
        await file.close()
        return async () => rm(this.#lockPath, { force: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (!force || (await lockOwnerAlive(this.#lockPath)))
          throw new MemoryError('memory_index_busy', 'Memory reindex is already running')
        await rm(this.#lockPath, { force: true })
      }
    }
    throw new MemoryError('memory_index_busy', 'Unable to acquire the memory reindex lock')
  }
}

/** Serializes fact mutations with dirty-marker-first index updates. */
export class IndexingMemoryService implements MemoryService {
  #startPromise: Promise<void> | undefined
  #mutation = Promise.resolve()

  constructor(
    readonly facts: MemoryService,
    readonly source: MemoryRepository,
    readonly index: MemoryIndex & MemoryIndexMaintenance,
    readonly hooks: MemoryMutationHooks = noMemoryMutationHooks,
  ) {}

  async start(): Promise<void> {
    if (!this.#startPromise) {
      this.#startPromise = (async () => {
        await this.facts.start()
        await this.index.reindex(await this.source.load())
      })().catch((error) => {
        this.#startPromise = undefined
        throw error
      })
    }
    return this.#startPromise
  }

  async validateWrite(
    input: NewMemoryRecord,
    operation: 'create' | 'update' = 'create',
  ): Promise<void> {
    const candidate = { ...input, id: input.id ?? randomUUID() }
    if (this.facts.validateWrite) await this.facts.validateWrite(candidate, operation)
    await this.hooks.preWrite({
      schemaVersion: 1,
      operation,
      phase: 'validation',
      scope: candidate.scope,
      id: candidate.id,
      content: candidate.content,
    })
  }

  async create(input: NewMemoryRecord): Promise<MemoryRecord> {
    const candidate = { ...input, id: input.id ?? randomUUID() }
    if (this.facts.validateWrite) await this.facts.validateWrite(candidate, 'create')
    return this.#commit(
      {
        schemaVersion: 1,
        operation: 'create',
        phase: 'commit',
        scope: candidate.scope,
        id: candidate.id,
        content: candidate.content,
      },
      () => this.facts.create(candidate),
    )
  }

  async get(scope: MemoryRecordScope, id: string): Promise<MemoryRecord | undefined> {
    await this.facts.start()
    return this.facts.get(scope, id)
  }

  async list(
    scope: MemoryRecordScope,
    options?: Omit<MemoryListOptions, 'cursor'>,
  ): Promise<MemoryRecord[]> {
    await this.facts.start()
    return this.facts.list(scope, options)
  }

  async listPage(scope: MemoryRecordScope, options?: MemoryListOptions): Promise<MemoryPage> {
    await this.facts.start()
    return this.facts.listPage(scope, options)
  }

  async update(
    scope: MemoryRecordScope,
    id: string,
    patch: Partial<
      Pick<MemoryRecord, 'content' | 'tags' | 'pinned' | 'provenance' | 'attachments'>
    >,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord> {
    const current = await this.#current(scope, id)
    const candidate: NewMemoryRecord = {
      id,
      scope,
      content: patch.content ?? current.content,
      provenance: patch.provenance ?? current.provenance,
      tags: patch.tags ?? current.tags,
      pinned: patch.pinned ?? current.pinned,
      attachments: patch.attachments ?? current.attachments,
    }
    if (this.facts.validateWrite) await this.facts.validateWrite(candidate, 'update')
    return this.#commit(
      {
        schemaVersion: 1,
        operation: 'update',
        phase: 'commit',
        scope,
        id,
        ...(patch.content === undefined ? {} : { content: patch.content }),
      },
      () => this.facts.update(scope, id, patch, options),
    )
  }

  async move(
    scope: MemoryRecordScope,
    id: string,
    to: MemoryRecordScope,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord> {
    const current = await this.#current(scope, id)
    if (this.facts.validateWrite)
      await this.facts.validateWrite({ ...current, scope: to }, 'update')
    return this.#commit({ schemaVersion: 1, operation: 'update', phase: 'commit', scope, id }, () =>
      this.facts.move(scope, id, to, options),
    )
  }

  async gcSessions(
    cutoff: string,
    options?: { dryRun?: boolean },
  ): Promise<{ purged: readonly { id: string; sessionId: string }[] }> {
    // Stale index entries self-heal: recall re-checks each hit against the
    // fact store, so no forced reindex is needed for the purged ids.
    return this.facts.gcSessions(cutoff, options)
  }

  async delete(
    scope: MemoryRecordScope,
    id: string,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord> {
    const current = await this.#current(scope, id, true)
    if (current.deletedAt) return current
    return this.#commit(
      { schemaVersion: 1, operation: 'delete', phase: 'commit', scope, id },
      () => this.facts.delete(scope, id, options),
      true,
    )
  }

  async pin(
    scope: MemoryRecordScope,
    id: string,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord> {
    const current = await this.#current(scope, id)
    if (this.facts.validateWrite)
      await this.facts.validateWrite({ ...current, pinned: true }, 'update')
    return this.#commit(
      {
        schemaVersion: 1,
        operation: 'pin',
        phase: 'commit',
        scope,
        id,
        content: current.content,
      },
      () => this.facts.pin(scope, id, options),
    )
  }

  async unpin(
    scope: MemoryRecordScope,
    id: string,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord> {
    await this.#current(scope, id)
    return this.#commit({ schemaVersion: 1, operation: 'unpin', phase: 'commit', scope, id }, () =>
      this.facts.unpin(scope, id, options),
    )
  }

  async invalidateAttachment(
    scope: MemoryRecordScope,
    id: string,
    attachmentId: string,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord> {
    await this.#current(scope, id)
    return this.#commit(
      {
        schemaVersion: 1,
        operation: 'invalidateAttachment',
        phase: 'commit',
        scope,
        id,
      },
      () => this.facts.invalidateAttachment(scope, id, attachmentId, options),
    )
  }

  async deleteAttachment(
    scope: MemoryRecordScope,
    id: string,
    attachmentId: string,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord> {
    await this.#current(scope, id)
    return this.#commit(
      {
        schemaVersion: 1,
        operation: 'deleteAttachment',
        phase: 'commit',
        scope,
        id,
      },
      () => this.facts.deleteAttachment(scope, id, attachmentId, options),
    )
  }

  onDidChange(listener: () => void): { dispose(): void } {
    return this.facts.onDidChange?.(listener) ?? { dispose() {} }
  }

  async flush(): Promise<void> {
    await this.#mutation
    await this.facts.flush()
  }

  async #current(
    scope: MemoryRecordScope,
    id: string,
    includeDeleted = false,
  ): Promise<MemoryRecord> {
    const current = await this.facts.get(scope, id)
    if (!current || (!includeDeleted && current.deletedAt))
      throw new MemoryError('memory_not_found', `Memory ${id} was not found`)
    return current
  }

  async #commit(
    context: MemoryMutationHookContext,
    mutation: () => Promise<MemoryRecord>,
    emitDeleted = false,
  ): Promise<MemoryRecord> {
    // Policy runs outside the mutation queue so a hook attempting a nested write can
    // fail immediately instead of deadlocking behind the write it is evaluating.
    await this.hooks.preWrite(context)
    const record = await this.#mutate(context.operation, mutation)
    try {
      await this.hooks.postWrite(context, record)
    } catch {
      // A committed durable write cannot be rolled back because an observer failed.
    }
    if (emitDeleted) {
      try {
        await this.hooks.deleted(context, record)
      } catch {
        // Deletion observers have the same best-effort, post-commit semantics.
      }
    }
    return record
  }

  async #mutate(operation: string, mutation: () => Promise<MemoryRecord>): Promise<MemoryRecord> {
    const queued = this.#mutation.then(async () => {
      await this.start()
      await this.index.markDirty(operation)
      let record: MemoryRecord
      try {
        record = await mutation()
      } catch (error) {
        await this.index.clearDirty()
        throw error
      }
      if (record.deletedAt) await this.index.remove(record.id)
      else await this.index.upsert(record)
      await this.index.clearDirty()
      return record
    })
    this.#mutation = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }
}

export class DefaultMemoryRecallService implements MemoryRecallService {
  constructor(
    readonly memory: MemoryService,
    readonly index: MemoryIndex,
  ) {}

  async recall(
    scope: MemoryRecordScope,
    query: string,
    options: MemoryRecallOptions = {},
  ): Promise<readonly MemoryRecallHit[]> {
    await this.memory.start()
    const limit = options.limit ?? 10
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new MemoryError('memory_validation', 'Memory recall limit must be between 1 and 500')
    const tags = [...new Set((options.tags ?? []).map((tag) => tag.trim()).filter(Boolean))]
    const hits: MemoryRecallHit[] = []
    for (const candidate of await this.index.search(query)) {
      const record = await this.memory.get(scope, candidate.id)
      if (
        !record ||
        record.deletedAt ||
        record.updatedAt !== candidate.sourceUpdatedAt ||
        !tags.every((tag) => record.tags.includes(tag))
      )
        continue
      hits.push({ record, score: candidate.score })
      if (hits.length >= limit) break
    }
    return hits
  }
}

export class DefaultMemoryMaintenanceService implements MemoryMaintenanceService {
  constructor(
    readonly source: MemoryRepository,
    readonly index: MemoryIndexMaintenance,
  ) {}

  async doctor(): Promise<MemoryDoctorReport> {
    try {
      const records = await this.source.load()
      const index = await this.index.health(records)
      const issues = this.source.diagnostics?.()
      return {
        healthy: index.healthy,
        facts: { healthy: true, records: records.length, detail: 'fact snapshot is readable' },
        index,
        ...(issues && issues.length > 0 ? { issues: [...issues] } : {}),
      }
    } catch (error) {
      return {
        healthy: false,
        facts: { healthy: false, records: 0, detail: errorMessage(error) },
        index: await this.index.health(),
      }
    }
  }

  async reindex(options?: MemoryReindexOptions): Promise<MemoryReindexReport> {
    return this.index.reindex(await this.source.load(), options)
  }
}

function activeRecords(records: readonly MemoryRecord[]): MemoryRecord[] {
  return records.filter((record) => !record.deletedAt).toSorted((a, b) => a.id.localeCompare(b.id))
}

function fingerprintRecords(records: readonly MemoryRecord[]): string {
  return fingerprintDocuments(activeRecords(records).map(toDocument))
}

function fingerprintDocuments(documents: readonly MemoryIndexDocument[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        documents
          .map((document) => ({ id: document.id, sourceDigest: document.sourceDigest }))
          .toSorted((left, right) => left.id.localeCompare(right.id)),
      ),
    )
    .digest('hex')
}

function tokenize(value: string): string[] {
  return (
    value
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
}

function toDocument(record: MemoryRecord): MemoryIndexDocument {
  const terms: Record<string, number> = {}
  for (const term of tokenize(`${record.content}\n${record.tags.join('\n')}`))
    terms[term] = (terms[term] ?? 0) + 1
  return {
    id: record.id,
    sourceDigest: createHash('sha256')
      .update(
        JSON.stringify({
          scope: record.scope,
          content: record.content,
          tags: record.tags,
          pinned: record.pinned,
          updatedAt: record.updatedAt,
        }),
      )
      .digest('hex'),
    sourceUpdatedAt: record.updatedAt,
    terms,
  }
}

function parseSnapshot(value: unknown): MemoryIndexSnapshotV1 {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid memory index snapshot')
  const snapshot = value as Partial<MemoryIndexSnapshotV1>
  if (
    snapshot.schemaVersion !== MEMORY_INDEX_SCHEMA_VERSION ||
    typeof snapshot.generation !== 'string' ||
    typeof snapshot.builtAt !== 'string' ||
    typeof snapshot.sourceFingerprint !== 'string' ||
    !Array.isArray(snapshot.documents)
  )
    throw new TypeError('Unsupported memory index schema')
  for (const document of snapshot.documents) {
    if (
      !document ||
      typeof document.id !== 'string' ||
      typeof document.sourceDigest !== 'string' ||
      typeof document.sourceUpdatedAt !== 'string' ||
      !document.terms ||
      typeof document.terms !== 'object' ||
      Object.values(document.terms as Record<string, unknown>).some(
        (frequency) =>
          typeof frequency !== 'number' || !Number.isSafeInteger(frequency) || frequency < 1,
      )
    )
      throw new TypeError('Invalid memory index document')
  }
  return snapshot as MemoryIndexSnapshotV1
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    },
  )
}

async function lockOwnerAlive(path: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown }
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) < 1) return false
    try {
      process.kill(Number(value.pid), 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  } catch {
    return false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
