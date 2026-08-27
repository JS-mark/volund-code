import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  MEMORY_RECORD_SCHEMA_VERSION,
  MemoryError,
  type MemoryProvenance,
  type MemoryRecord,
  type MemoryRecordAttachment,
  type MemoryRecordScope,
  type MemoryService,
  validateMemoryRecordAttachment,
} from './memory-runtime'

export const MEMORY_EXPORT_SCHEMA_VERSION = 'volund.memory.export.v1' as const
const MEMORY_IMPORT_JOURNAL_VERSION = 1 as const
export const MAX_MEMORY_ARCHIVE_BYTES = 16 * 1024 * 1024
const MAX_ARCHIVE_RECORDS = 10_000

export interface MemoryExportDocument {
  readonly schemaVersion: typeof MEMORY_EXPORT_SCHEMA_VERSION
  readonly exportedAt: string
  readonly records: readonly MemoryRecord[]
}

export type MemoryImportStrategy = 'skip' | 'overwrite' | 'rename'

export interface MemoryImportConflict {
  readonly id: string
  readonly action: 'skipped' | 'overwritten' | 'renamed'
  readonly importedId?: string
}

export interface MemoryImportReport {
  readonly schemaVersion: 1
  readonly dryRun: boolean
  readonly strategy: MemoryImportStrategy
  readonly total: number
  readonly applied: number
  readonly conflicts: readonly MemoryImportConflict[]
  readonly rolledBack: boolean
  readonly recoveredInterruptedImport: boolean
}

interface PlannedImport {
  readonly source: MemoryRecord
  readonly id: string
  readonly action: 'create' | 'skip' | 'overwrite'
  readonly before: MemoryRecord | null
  readonly conflict: MemoryRecord | null
}

interface MemoryImportJournal {
  readonly schemaVersion: typeof MEMORY_IMPORT_JOURNAL_VERSION
  readonly targetScope: MemoryRecordScope
  readonly operations: readonly Pick<PlannedImport, 'id' | 'before'>[]
}

export interface MemoryTransferOptions {
  readonly journalPath?: string
  readonly now?: () => Date
  readonly beforeApply?: (index: number, operation: Readonly<PlannedImport>) => void | Promise<void>
  readonly audit?: (event: Readonly<Record<string, unknown>>) => void | Promise<void>
}

/** Local-only, versioned Memory import/export with journaled rollback. */
export class MemoryTransferService {
  readonly #now: () => Date

  constructor(
    readonly memory: MemoryService,
    readonly options: MemoryTransferOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date())
  }

  async export(scopes: readonly MemoryRecordScope[]): Promise<MemoryExportDocument> {
    const records: MemoryRecord[] = []
    const seen = new Set<string>()
    for (const scope of scopes) {
      let cursor: string | undefined
      do {
        const page = await this.memory.listPage(scope, {
          limit: 500,
          ...(cursor ? { cursor } : {}),
        })
        for (const record of page.items) {
          if (!seen.has(record.id)) {
            records.push(structuredClone(record))
            seen.add(record.id)
          }
        }
        cursor = page.nextCursor
      } while (cursor)
    }
    await this.options.audit?.({ operation: 'export', scopes, records: records.length })
    return {
      schemaVersion: MEMORY_EXPORT_SCHEMA_VERSION,
      exportedAt: this.#now().toISOString(),
      records,
    }
  }

  serialize(document: MemoryExportDocument): string {
    return `${JSON.stringify(document, null, 2)}\n`
  }

  parse(serialized: string): MemoryExportDocument {
    if (Buffer.byteLength(serialized, 'utf8') > MAX_MEMORY_ARCHIVE_BYTES)
      throw new MemoryError('memory_validation', 'Memory import exceeds 16 MiB')
    let value: unknown
    try {
      value = JSON.parse(serialized)
    } catch (error) {
      throw new MemoryError('memory_validation', 'Memory import is not valid JSON', {
        cause: error,
      })
    }
    return validateExportDocument(value)
  }

  async import(
    serialized: string,
    targetScope: MemoryRecordScope,
    options: Readonly<{
      strategy?: MemoryImportStrategy
      dryRun?: boolean
      actorId?: string
    }> = {},
  ): Promise<MemoryImportReport> {
    const recoveredInterruptedImport = await this.recoverInterruptedImport()
    const document = this.parse(serialized)
    const strategy = options.strategy ?? 'skip'
    if (!['skip', 'overwrite', 'rename'].includes(strategy))
      throw new MemoryError('memory_validation', `Unsupported memory import strategy: ${strategy}`)
    const plan = await this.#plan(document, targetScope, strategy)
    for (const operation of plan) {
      const provenance = importedProvenance(operation.source.provenance, options.actorId)
      await this.memory.validateWrite?.(
        {
          id: operation.id,
          scope: targetScope,
          content: operation.source.content,
          tags: operation.source.tags,
          pinned: operation.source.pinned,
          provenance,
          attachments: importedAttachments(operation.source.attachments, this.#now()),
        },
        operation.action === 'overwrite' ? 'update' : 'create',
      )
    }
    const conflicts = plan.flatMap((operation): MemoryImportConflict[] => {
      if (!operation.conflict) return []
      if (operation.action === 'skip') return [{ id: operation.source.id, action: 'skipped' }]
      if (operation.action === 'overwrite')
        return [{ id: operation.source.id, action: 'overwritten' }]
      return [{ id: operation.source.id, action: 'renamed', importedId: operation.id }]
    })
    if (options.dryRun) {
      return {
        schemaVersion: 1,
        dryRun: true,
        strategy,
        total: plan.length,
        applied: 0,
        conflicts,
        rolledBack: false,
        recoveredInterruptedImport,
      }
    }

    const actionable = plan.filter(({ action }) => action !== 'skip')
    await this.#writeJournal({
      schemaVersion: MEMORY_IMPORT_JOURNAL_VERSION,
      targetScope,
      operations: actionable.map(({ id, before }) => ({ id, before })),
    })
    let applied = 0
    try {
      for (const [index, operation] of actionable.entries()) {
        await this.options.beforeApply?.(index, operation)
        const provenance = importedProvenance(operation.source.provenance, options.actorId)
        const attachments = importedAttachments(operation.source.attachments, this.#now())
        if (operation.action === 'overwrite') {
          await this.memory.update(targetScope, operation.id, {
            content: operation.source.content,
            tags: operation.source.tags,
            pinned: operation.source.pinned,
            provenance,
            attachments,
          })
        } else {
          await this.memory.create({
            id: operation.id,
            scope: targetScope,
            content: operation.source.content,
            tags: operation.source.tags,
            pinned: operation.source.pinned,
            provenance,
            attachments,
          })
        }
        applied++
        await this.options.audit?.({
          operation: 'import.write',
          id: operation.id,
          action: operation.action,
          source: 'import',
        })
      }
      await this.#clearJournal()
      return {
        schemaVersion: 1,
        dryRun: false,
        strategy,
        total: plan.length,
        applied,
        conflicts,
        rolledBack: false,
        recoveredInterruptedImport,
      }
    } catch (error) {
      await this.#rollback(targetScope, actionable.slice(0, applied))
      await this.#clearJournal()
      throw new MemoryError('memory_io', 'Memory import failed and was rolled back', {
        cause: error,
      })
    }
  }

  async recoverInterruptedImport(): Promise<boolean> {
    if (!this.options.journalPath) return false
    let journal: MemoryImportJournal
    try {
      journal = JSON.parse(await readFile(this.options.journalPath, 'utf8')) as MemoryImportJournal
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw new MemoryError('memory_corrupt', 'Memory import recovery journal is unreadable', {
        cause: error,
      })
    }
    if (
      journal.schemaVersion !== MEMORY_IMPORT_JOURNAL_VERSION ||
      !Array.isArray(journal.operations)
    )
      throw new MemoryError('memory_corrupt', 'Memory import recovery journal is incompatible')
    await this.#rollback(
      journal.targetScope,
      journal.operations.map((operation) => ({
        source: operation.before ?? ({} as MemoryRecord),
        id: operation.id,
        action: operation.before ? 'overwrite' : 'create',
        before: operation.before,
        conflict: operation.before,
      })),
    )
    await this.#clearJournal()
    await this.options.audit?.({
      operation: 'import.recovered',
      records: journal.operations.length,
    })
    return true
  }

  async #plan(
    document: MemoryExportDocument,
    targetScope: MemoryRecordScope,
    strategy: MemoryImportStrategy,
  ): Promise<PlannedImport[]> {
    const reserved = new Set<string>()
    const plan: PlannedImport[] = []
    for (const source of document.records) {
      const existing = await this.memory.get(targetScope, source.id)
      if (!existing || existing.deletedAt) {
        reserved.add(source.id)
        plan.push({ source, id: source.id, action: 'create', before: null, conflict: null })
        continue
      }
      if (strategy === 'skip') {
        plan.push({ source, id: source.id, action: 'skip', before: existing, conflict: existing })
        continue
      }
      if (strategy === 'overwrite') {
        plan.push({
          source,
          id: source.id,
          action: 'overwrite',
          before: existing,
          conflict: existing,
        })
        continue
      }
      let suffix = 1
      let id = `${source.id}-import-${suffix}`
      while (reserved.has(id) || (await this.memory.get(targetScope, id)))
        id = `${source.id}-import-${++suffix}`
      reserved.add(id)
      plan.push({ source, id, action: 'create', before: null, conflict: existing })
    }
    return plan
  }

  async #rollback(scope: MemoryRecordScope, operations: readonly PlannedImport[]): Promise<void> {
    for (const operation of operations.toReversed()) {
      const current = await this.memory.get(scope, operation.id)
      if (!operation.before) {
        if (current && !current.deletedAt) await this.memory.delete(scope, operation.id)
        continue
      }
      if (!current || current.deletedAt) continue
      await this.memory.update(scope, operation.id, {
        content: operation.before.content,
        tags: operation.before.tags,
        pinned: operation.before.pinned,
        provenance: operation.before.provenance,
        attachments: operation.before.attachments,
      })
    }
  }

  async #writeJournal(journal: MemoryImportJournal): Promise<void> {
    if (!this.options.journalPath) return
    await mkdir(dirname(this.options.journalPath), { recursive: true, mode: 0o700 })
    const temporary = `${this.options.journalPath}.${process.pid}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(journal))
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, this.options.journalPath)
  }

  async #clearJournal(): Promise<void> {
    if (this.options.journalPath) await rm(this.options.journalPath, { force: true })
  }
}

function importedProvenance(
  provenance: MemoryProvenance,
  actorId = 'local-import',
): MemoryProvenance {
  return {
    source: 'import',
    actorId,
    ...(provenance.sourceId ? { sourceId: provenance.sourceId } : {}),
    importedFrom: {
      source: provenance.source,
      ...(provenance.actorId ? { actorId: provenance.actorId } : {}),
      ...(provenance.sourceId ? { sourceId: provenance.sourceId } : {}),
    },
  }
}

function importedAttachments(
  attachments: readonly MemoryRecordAttachment[],
  now: Date,
): MemoryRecordAttachment[] {
  const at = now.toISOString()
  return attachments.map((attachment) =>
    attachment.state === 'active'
      ? { ...attachment, state: 'invalidated', invalidatedAt: at }
      : structuredClone(attachment),
  )
}

function validateExportDocument(value: unknown): MemoryExportDocument {
  if (!value || typeof value !== 'object')
    throw new MemoryError('memory_validation', 'Memory import document is invalid')
  const document = value as Partial<MemoryExportDocument>
  if (
    document.schemaVersion !== MEMORY_EXPORT_SCHEMA_VERSION ||
    !document.exportedAt ||
    Number.isNaN(Date.parse(document.exportedAt)) ||
    !Array.isArray(document.records)
  )
    throw new MemoryError('memory_validation', 'Memory import schema is incompatible')
  if (document.records.length > MAX_ARCHIVE_RECORDS)
    throw new MemoryError('memory_validation', 'Memory import contains too many records')
  const ids = new Set<string>()
  for (const record of document.records) {
    if (
      !record ||
      record.schemaVersion !== MEMORY_RECORD_SCHEMA_VERSION ||
      typeof record.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.id) ||
      typeof record.content !== 'string' ||
      !record.scope ||
      typeof record.scope !== 'object' ||
      !record.provenance ||
      !['user', 'agent', 'evolution', 'import'].includes(record.provenance.source) ||
      typeof record.pinned !== 'boolean' ||
      typeof record.createdAt !== 'string' ||
      typeof record.updatedAt !== 'string' ||
      !Array.isArray(record.tags) ||
      !Array.isArray(record.attachments) ||
      !record.attachments.every(validateMemoryRecordAttachment) ||
      ids.has(record.id)
    )
      throw new MemoryError('memory_validation', 'Memory import contains an invalid record')
    ids.add(record.id)
  }
  return structuredClone(document as MemoryExportDocument)
}
