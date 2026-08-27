import { randomUUID } from 'node:crypto'
import { open, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { detectSecret } from '@volund/shared'

export const MEMORY_RECORD_SCHEMA_VERSION = 1 as const
const SNAPSHOT_SCHEMA_VERSION = 1 as const

export type MemoryRecordScope =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'project'; readonly workspaceId: string; readonly projectId: string }
  | {
      readonly kind: 'session'
      readonly workspaceId: string
      readonly projectId: string
      readonly sessionId: string
    }

export interface MemoryProvenance {
  readonly source: 'user' | 'agent' | 'evolution' | 'import'
  readonly actorId?: string
  readonly sourceId?: string
  /** Original, untrusted provenance retained by import without granting its authority. */
  readonly importedFrom?: Readonly<{
    source: MemoryProvenance['source']
    actorId?: string
    sourceId?: string
  }>
}

export type MemoryAttachmentState = 'active' | 'invalidated' | 'deleted'

export interface MemoryRecordAttachment {
  readonly schemaVersion: 1
  readonly id: string
  readonly handle: string
  readonly mime: string
  readonly size: number
  readonly digest: string
  readonly state: MemoryAttachmentState
  readonly createdAt: string
  readonly invalidatedAt: string | null
  readonly deletedAt: string | null
}

export interface MemoryRecord {
  readonly schemaVersion: typeof MEMORY_RECORD_SCHEMA_VERSION
  readonly id: string
  readonly scope: MemoryRecordScope
  readonly content: string
  readonly provenance: MemoryProvenance
  /** Data-only references. Attachment bytes are never embedded in a memory snapshot or export. */
  readonly attachments: readonly MemoryRecordAttachment[]
  readonly tags: readonly string[]
  readonly pinned: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly deletedAt: string | null
}

export type NewMemoryRecord = Pick<MemoryRecord, 'scope' | 'content' | 'provenance'> & {
  readonly id?: string
  readonly tags?: readonly string[]
  readonly pinned?: boolean
  readonly attachments?: readonly MemoryRecordAttachment[]
}

export interface MemoryListOptions {
  readonly includeDeleted?: boolean
  readonly limit?: number
  readonly cursor?: string
  readonly pinned?: boolean
  readonly tags?: readonly string[]
  readonly sources?: readonly MemoryProvenance['source'][]
}

export interface MemoryPage {
  readonly items: MemoryRecord[]
  readonly nextCursor?: string
}

export interface MemoryMutationOptions {
  /** Optimistic concurrency token returned as `updatedAt` by every read. */
  readonly expectedUpdatedAt?: string
}

export interface MemoryPreWriteContext {
  readonly operation: 'create' | 'update'
  readonly scope: MemoryRecordScope
  readonly id: string
  readonly content: string
}

export type MemoryPreWrite = (context: MemoryPreWriteContext) => void | Promise<void>

export type MemoryMutationOperation =
  | 'create'
  | 'update'
  | 'delete'
  | 'pin'
  | 'unpin'
  | 'invalidateAttachment'
  | 'deleteAttachment'

/** Metadata passed across the production plugin-policy boundary. */
export interface MemoryMutationHookContext {
  readonly schemaVersion: 1
  readonly operation: MemoryMutationOperation
  readonly phase: 'validation' | 'commit'
  readonly scope: MemoryRecordScope
  readonly id: string
  /** Present only for candidate content after the built-in secret guard accepts it. */
  readonly content?: string
}

export interface MemoryMutationHooks {
  preWrite(context: MemoryMutationHookContext): void | Promise<void>
  postWrite(context: MemoryMutationHookContext, record: MemoryRecord): void | Promise<void>
  deleted(context: MemoryMutationHookContext, record: MemoryRecord): void | Promise<void>
}

export const noMemoryMutationHooks: MemoryMutationHooks = Object.freeze({
  preWrite() {},
  postWrite() {},
  deleted() {},
})

export type MemoryErrorCode =
  | 'memory_conflict'
  | 'memory_corrupt'
  | 'memory_hook_failed'
  | 'memory_hook_reentrant'
  | 'memory_hook_veto'
  | 'memory_index_busy'
  | 'memory_index_corrupt'
  | 'memory_index_unavailable'
  | 'memory_io'
  | 'memory_not_found'
  | 'memory_scope_denied'
  | 'memory_validation'

export class MemoryError extends Error {
  constructor(
    readonly code: MemoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'MemoryError'
  }
}

export interface MemoryRepository {
  load(): Promise<readonly MemoryRecord[]>
  save(records: readonly MemoryRecord[]): Promise<void>
  flush(): Promise<void>
  /**
   * Applies a read-modify-write operation while holding the repository's
   * cross-process transaction lock. Implementations that omit this method are
   * supported for in-memory and test adapters, but cannot coordinate writers
   * outside the current service instance.
   */
  transaction?<T>(
    operation: (records: readonly MemoryRecord[]) => Promise<MemoryRepositoryCommit<T>>,
  ): Promise<MemoryRepositoryCommit<T>>
}

export interface MemoryRepositoryCommit<T> {
  readonly records: readonly MemoryRecord[]
  readonly result: T
}

export interface MemoryPolicy {
  canAccess(requested: MemoryRecordScope, record: MemoryRecordScope): boolean
}

export interface MemoryService {
  start(): Promise<void>
  validateWrite?(input: NewMemoryRecord, operation?: 'create' | 'update'): Promise<void>
  create(input: NewMemoryRecord): Promise<MemoryRecord>
  get(scope: MemoryRecordScope, id: string): Promise<MemoryRecord | undefined>
  list(
    scope: MemoryRecordScope,
    options?: Omit<MemoryListOptions, 'cursor'>,
  ): Promise<MemoryRecord[]>
  listPage(scope: MemoryRecordScope, options?: MemoryListOptions): Promise<MemoryPage>
  update(
    scope: MemoryRecordScope,
    id: string,
    patch: Partial<
      Pick<MemoryRecord, 'content' | 'tags' | 'pinned' | 'provenance' | 'attachments'>
    >,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord>
  delete(
    scope: MemoryRecordScope,
    id: string,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord>
  pin(scope: MemoryRecordScope, id: string, options?: MemoryMutationOptions): Promise<MemoryRecord>
  unpin(
    scope: MemoryRecordScope,
    id: string,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord>
  invalidateAttachment(
    scope: MemoryRecordScope,
    id: string,
    attachmentId: string,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord>
  deleteAttachment(
    scope: MemoryRecordScope,
    id: string,
    attachmentId: string,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord>
  onDidChange?(listener: () => void): { dispose(): void }
  flush(): Promise<void>
}

export class HierarchicalMemoryPolicy implements MemoryPolicy {
  canAccess(requested: MemoryRecordScope, record: MemoryRecordScope): boolean {
    if (requested.workspaceId !== record.workspaceId || requested.kind !== record.kind) return false
    if (requested.kind === 'workspace' || record.kind === 'workspace') return true
    if (requested.projectId !== record.projectId) return false
    if (requested.kind === 'project' || record.kind === 'project') return true
    return requested.sessionId === record.sessionId
  }
}

function validateScope(scope: MemoryRecordScope): void {
  if (!validIdentifier(scope.workspaceId))
    throw new MemoryError('memory_validation', 'workspaceId is invalid')
  if (scope.kind !== 'workspace' && !validIdentifier(scope.projectId))
    throw new MemoryError('memory_validation', 'projectId is invalid')
  if (scope.kind === 'session' && !validIdentifier(scope.sessionId))
    throw new MemoryError('memory_validation', 'sessionId is invalid')
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_MEMORY_CONTENT_BYTES = 64 * 1024

function validIdentifier(value: string): boolean {
  return identifierPattern.test(value) && value !== '.' && value !== '..'
}

function hasInvalidUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code === 0) return true
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true
      const low = value.charCodeAt(++index)
      if (low < 0xdc00 || low > 0xdfff) return true
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

function builtinPreWrite(context: MemoryPreWriteContext): void {
  if (!validIdentifier(context.id))
    throw new MemoryError('memory_validation', 'Memory id is invalid')
  if (!context.content.trim()) throw new MemoryError('memory_validation', 'Memory content is empty')
  if (hasInvalidUnicode(context.content))
    throw new MemoryError('memory_validation', 'Memory content contains invalid Unicode')
  if (Buffer.byteLength(context.content, 'utf8') > MAX_MEMORY_CONTENT_BYTES)
    throw new MemoryError('memory_validation', 'Memory content exceeds 64 KiB')
  if (detectSecret(context.content))
    throw new MemoryError('memory_validation', 'Memory content appears to contain a secret')
}

export function memoryCursorFor(record: MemoryRecord): string {
  return Buffer.from(JSON.stringify([record.pinned, record.updatedAt, record.id]), 'utf8').toString(
    'base64url',
  )
}

function decodeCursor(cursor: string): Readonly<Pick<MemoryRecord, 'id' | 'pinned' | 'updatedAt'>> {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      typeof value[0] !== 'boolean' ||
      typeof value[1] !== 'string' ||
      typeof value[2] !== 'string'
    )
      throw new TypeError('invalid cursor')
    return { pinned: value[0], updatedAt: value[1], id: value[2] }
  } catch (error) {
    throw new MemoryError('memory_validation', 'Memory cursor is invalid', { cause: error })
  }
}

/** Product-wide list order. CLI and TUI both consume the service in this order. */
export function compareMemoryRecords(
  left: Readonly<Pick<MemoryRecord, 'id' | 'pinned' | 'updatedAt'>>,
  right: Readonly<Pick<MemoryRecord, 'id' | 'pinned' | 'updatedAt'>>,
): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
}

function normalizeTags(tags: readonly string[]): string[] {
  const normalized = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))]
  if (normalized.some((tag) => tag.length > 64))
    throw new MemoryError('memory_validation', 'Memory tags must not exceed 64 characters')
  return normalized.toSorted()
}

const attachmentHandlePattern = /^[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/
const attachmentMimePattern = /^image\/(?:png|jpeg|gif|webp)$/

export function validateMemoryRecordAttachment(value: unknown): value is MemoryRecordAttachment {
  if (!value || typeof value !== 'object') return false
  const attachment = value as MemoryRecordAttachment
  const digest = attachmentHandlePattern.exec(attachment.handle)?.[0]?.slice(0, 64)
  return (
    attachment.schemaVersion === 1 &&
    validIdentifier(attachment.id) &&
    digest === attachment.digest &&
    attachmentMimePattern.test(attachment.mime) &&
    Number.isSafeInteger(attachment.size) &&
    attachment.size > 0 &&
    ['active', 'invalidated', 'deleted'].includes(attachment.state) &&
    !Number.isNaN(Date.parse(attachment.createdAt)) &&
    (attachment.invalidatedAt === null || !Number.isNaN(Date.parse(attachment.invalidatedAt))) &&
    (attachment.deletedAt === null || !Number.isNaN(Date.parse(attachment.deletedAt)))
  )
}

function normalizeAttachments(
  attachments: readonly MemoryRecordAttachment[],
): MemoryRecordAttachment[] {
  if (attachments.length > 64)
    throw new MemoryError('memory_validation', 'Memory cannot reference more than 64 attachments')
  if (!attachments.every(validateMemoryRecordAttachment))
    throw new MemoryError('memory_validation', 'Memory attachment reference is invalid')
  if (new Set(attachments.map(({ id }) => id)).size !== attachments.length)
    throw new MemoryError('memory_validation', 'Memory attachment ids must be unique')
  return structuredClone([...attachments])
}

export class DefaultMemoryService implements MemoryService {
  readonly #records = new Map<string, MemoryRecord>()
  readonly #changeListeners = new Set<() => void>()
  #started = false
  #mutation = Promise.resolve()

  constructor(
    readonly repository: MemoryRepository,
    readonly policy: MemoryPolicy = new HierarchicalMemoryPolicy(),
    readonly now: () => Date = () => new Date(),
    readonly createId: () => string = randomUUID,
    readonly preWrite: MemoryPreWrite = async () => {},
  ) {}

  async start(): Promise<void> {
    if (this.#started) return
    for (const record of await this.repository.load()) this.#records.set(record.id, record)
    this.#started = true
  }

  async validateWrite(
    input: NewMemoryRecord,
    operation: 'create' | 'update' = 'create',
  ): Promise<void> {
    validateScope(input.scope)
    const id = input.id ?? this.createId()
    normalizeTags(input.tags ?? [])
    normalizeAttachments(input.attachments ?? [])
    await this.#runPreWrite({ operation, scope: input.scope, id, content: input.content })
  }

  async create(input: NewMemoryRecord): Promise<MemoryRecord> {
    validateScope(input.scope)
    const result = await this.#write(async () => {
      const id = input.id ?? this.createId()
      const existing = this.#records.get(id)
      if (existing) {
        const tags = normalizeTags(input.tags ?? [])
        const attachments = normalizeAttachments(input.attachments ?? [])
        if (
          !existing.deletedAt &&
          this.policy.canAccess(input.scope, existing.scope) &&
          existing.content === input.content &&
          existing.pinned === (input.pinned ?? false) &&
          JSON.stringify(existing.tags) === JSON.stringify(tags) &&
          JSON.stringify(existing.attachments) === JSON.stringify(attachments) &&
          JSON.stringify(existing.provenance) === JSON.stringify(input.provenance)
        )
          return existing
        if (!existing.deletedAt || !this.policy.canAccess(input.scope, existing.scope))
          throw new MemoryError('memory_conflict', `Memory ${id} exists`)
      }
      await this.#runPreWrite({
        operation: 'create',
        scope: input.scope,
        id,
        content: input.content,
      })
      const now = this.now().toISOString()
      const record: MemoryRecord = {
        schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
        id,
        scope: input.scope,
        content: input.content,
        provenance: input.provenance,
        attachments: normalizeAttachments(input.attachments ?? []),
        tags: normalizeTags(input.tags ?? []),
        pinned: input.pinned ?? false,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }
      this.#records.set(id, record)
      return record
    })
    this.#notifyChange()
    return result
  }

  async get(scope: MemoryRecordScope, id: string): Promise<MemoryRecord | undefined> {
    await this.start()
    const record = this.#records.get(id)
    return record && this.policy.canAccess(scope, record.scope) ? record : undefined
  }

  async list(
    scope: MemoryRecordScope,
    options: Omit<MemoryListOptions, 'cursor'> = {},
  ): Promise<MemoryRecord[]> {
    return (await this.listPage(scope, options)).items
  }

  async listPage(scope: MemoryRecordScope, options: MemoryListOptions = {}): Promise<MemoryPage> {
    await this.start()
    validateScope(scope)
    const limit = options.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new MemoryError('memory_validation', 'Memory page limit must be between 1 and 500')
    const after = options.cursor ? decodeCursor(options.cursor) : undefined
    const tags = normalizeTags(options.tags ?? [])
    const records = [...this.#records.values()]
      .filter(
        (record) =>
          this.policy.canAccess(scope, record.scope) &&
          (options.includeDeleted || !record.deletedAt) &&
          (options.pinned === undefined || record.pinned === options.pinned) &&
          (!options.sources?.length || options.sources.includes(record.provenance.source)) &&
          tags.every((tag) => record.tags.includes(tag)),
      )
      .toSorted(compareMemoryRecords)
      .filter((record) => !after || compareMemoryRecords(record, after) > 0)
    const items = records.slice(0, limit)
    return {
      items,
      ...(records.length > limit && items.length
        ? { nextCursor: memoryCursorFor(items.at(-1)!) }
        : {}),
    }
  }

  async update(
    scope: MemoryRecordScope,
    id: string,
    patch: Partial<
      Pick<MemoryRecord, 'content' | 'tags' | 'pinned' | 'provenance' | 'attachments'>
    >,
    options: MemoryMutationOptions = {},
  ): Promise<MemoryRecord> {
    const result = await this.#write(async () => {
      const current = this.#require(scope, id)
      if (current.deletedAt) throw new MemoryError('memory_not_found', `Memory ${id} is deleted`)
      this.#checkVersion(current, options)
      if (patch.content !== undefined)
        await this.#runPreWrite({ operation: 'update', scope, id, content: patch.content })
      const tags = patch.tags === undefined ? current.tags : normalizeTags(patch.tags)
      const pinned = patch.pinned ?? current.pinned
      const content = patch.content ?? current.content
      const provenance = patch.provenance ?? current.provenance
      const attachments =
        patch.attachments === undefined
          ? current.attachments
          : normalizeAttachments(patch.attachments)
      if (
        content === current.content &&
        pinned === current.pinned &&
        JSON.stringify(tags) === JSON.stringify(current.tags) &&
        JSON.stringify(provenance) === JSON.stringify(current.provenance) &&
        JSON.stringify(attachments) === JSON.stringify(current.attachments)
      )
        return current
      const record: MemoryRecord = {
        ...current,
        content,
        tags,
        pinned,
        provenance,
        attachments,
        updatedAt: nextTimestamp(current.updatedAt, this.now()),
      }
      this.#records.set(id, record)
      return record
    })
    this.#notifyChange()
    return result
  }

  async delete(
    scope: MemoryRecordScope,
    id: string,
    options: MemoryMutationOptions = {},
  ): Promise<MemoryRecord> {
    const result = await this.#write(async () => {
      const current = this.#require(scope, id)
      if (current.deletedAt) return current
      this.#checkVersion(current, options)
      const now = nextTimestamp(current.updatedAt, this.now())
      const record = { ...current, pinned: false, updatedAt: now, deletedAt: now }
      this.#records.set(id, record)
      return record
    })
    this.#notifyChange()
    return result
  }

  async pin(
    scope: MemoryRecordScope,
    id: string,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord> {
    return this.update(scope, id, { pinned: true }, options)
  }

  async unpin(
    scope: MemoryRecordScope,
    id: string,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord> {
    return this.update(scope, id, { pinned: false }, options)
  }

  async invalidateAttachment(
    scope: MemoryRecordScope,
    id: string,
    attachmentId: string,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord> {
    return this.#transitionAttachment(scope, id, attachmentId, 'invalidated', options)
  }

  async deleteAttachment(
    scope: MemoryRecordScope,
    id: string,
    attachmentId: string,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord> {
    return this.#transitionAttachment(scope, id, attachmentId, 'deleted', options)
  }

  async flush(): Promise<void> {
    await this.#mutation
    await this.repository.flush()
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.#changeListeners.add(listener)
    return { dispose: () => this.#changeListeners.delete(listener) }
  }

  #notifyChange(): void {
    for (const listener of this.#changeListeners) {
      try {
        listener()
      } catch {
        // Durable mutations must not fail because an observer could not refresh its cache.
      }
    }
  }

  #require(scope: MemoryRecordScope, id: string): MemoryRecord {
    validateScope(scope)
    const record = this.#records.get(id)
    if (!record || !this.policy.canAccess(scope, record.scope))
      throw new MemoryError('memory_not_found', `Memory ${id} was not found`)
    return record
  }

  #checkVersion(record: MemoryRecord, options: MemoryMutationOptions): void {
    if (options.expectedUpdatedAt && record.updatedAt !== options.expectedUpdatedAt)
      throw new MemoryError('memory_conflict', `Memory ${record.id} changed concurrently`)
  }

  async #transitionAttachment(
    scope: MemoryRecordScope,
    id: string,
    attachmentId: string,
    state: Exclude<MemoryAttachmentState, 'active'>,
    options: MemoryMutationOptions = {},
  ): Promise<MemoryRecord> {
    const current = await this.get(scope, id)
    if (!current || current.deletedAt)
      throw new MemoryError('memory_not_found', `Memory ${id} was not found`)
    this.#checkVersion(current, options)
    const attachment = current.attachments.find((item) => item.id === attachmentId)
    if (!attachment)
      throw new MemoryError('memory_not_found', `Memory attachment ${attachmentId} was not found`)
    if (attachment.state === 'deleted' || attachment.state === state) return current
    const now = this.now().toISOString()
    return this.update(
      scope,
      id,
      {
        attachments: current.attachments.map((item) =>
          item.id === attachmentId
            ? {
                ...item,
                state,
                invalidatedAt: item.invalidatedAt ?? now,
                deletedAt: state === 'deleted' ? now : null,
              }
            : item,
        ),
      },
      options,
    )
  }

  async #runPreWrite(context: MemoryPreWriteContext): Promise<void> {
    // The built-in guard is deliberately unconditional; injected hooks may add restrictions only.
    builtinPreWrite(context)
    try {
      await this.preWrite(context)
    } catch (error) {
      if (error instanceof MemoryError) throw error
      throw new MemoryError('memory_validation', 'memory.preWrite rejected the write', {
        cause: error,
      })
    }
  }

  async #write<T>(mutation: () => Promise<T>): Promise<T> {
    await this.start()
    const operation = this.#mutation.then(async () => {
      const before = new Map(this.#records)
      try {
        if (this.repository.transaction) {
          const committed = await this.repository.transaction(async (records) => {
            this.#replaceRecords(records)
            const result = await mutation()
            return { records: [...this.#records.values()], result }
          })
          this.#replaceRecords(committed.records)
          return committed.result
        }
        const result = await mutation()
        await this.repository.save([...this.#records.values()])
        return result
      } catch (error) {
        if (this.repository.transaction) {
          try {
            this.#replaceRecords(await this.repository.load())
          } catch {
            this.#replaceRecords(before.values())
          }
        } else this.#replaceRecords(before.values())
        if (error instanceof MemoryError) throw error
        throw new MemoryError('memory_io', 'Unable to persist memory', { cause: error })
      }
    })
    this.#mutation = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  #replaceRecords(records: Iterable<MemoryRecord>): void {
    this.#records.clear()
    for (const record of records) this.#records.set(record.id, record)
  }
}

interface MemorySnapshotV1 {
  readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION
  readonly records: readonly MemoryRecord[]
}

export interface LocalMemoryRepositoryOptions {
  beforeRename?: (temporaryPath: string, destinationPath: string) => void | Promise<void>
  /**
   * Maximum time a writer or consistent reader waits for the transaction lock.
   * The budget also bounds retries of transient lock access errors (LL-7), so
   * contention-heavy callers (e.g. tests) can widen it without changing code.
   */
  lockTimeoutMs?: number
  /** Delay between lock attempts. Kept configurable to make contention tests deterministic. */
  lockRetryMs?: number
}

/** Atomic snapshot adapter. A previous .bak is retained until the new snapshot is durable. */
export class LocalMemoryRepository implements MemoryRepository {
  readonly #lockPath: string

  constructor(
    readonly path: string,
    readonly options: LocalMemoryRepositoryOptions = {},
  ) {
    this.#lockPath = `${path}.lock`
  }

  async load(): Promise<readonly MemoryRecord[]> {
    const release = await this.#acquireLock()
    try {
      return await this.#loadUnlocked()
    } finally {
      await release()
    }
  }

  async save(records: readonly MemoryRecord[]): Promise<void> {
    const release = await this.#acquireLock()
    try {
      await this.#saveUnlocked(records)
    } finally {
      await release()
    }
  }

  async transaction<T>(
    operation: (records: readonly MemoryRecord[]) => Promise<MemoryRepositoryCommit<T>>,
  ): Promise<MemoryRepositoryCommit<T>> {
    const release = await this.#acquireLock()
    try {
      const commit = await operation(await this.#loadUnlocked())
      await this.#saveUnlocked(commit.records)
      return commit
    } finally {
      await release()
    }
  }

  async flush(): Promise<void> {
    // save() fsyncs the file and, where supported, its containing directory.
  }

  async #loadUnlocked(): Promise<readonly MemoryRecord[]> {
    const primary = await this.#read(this.path)
    if (primary.ok) return primary.records
    const backup = await this.#read(`${this.path}.bak`)
    if (backup.ok) return backup.records
    if (primary.missing && backup.missing) return []
    throw new MemoryError('memory_corrupt', 'Memory snapshot and recovery backup are unreadable', {
      cause: primary.error ?? backup.error,
    })
  }

  async #saveUnlocked(records: readonly MemoryRecord[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify({ schemaVersion: SNAPSHOT_SCHEMA_VERSION, records }))
      await file.sync()
    } catch (error) {
      await file.close().catch(() => undefined)
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
    await file.close()
    try {
      await rm(`${this.path}.bak`, { force: true })
      await rename(this.path, `${this.path}.bak`).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      await this.options.beforeRename?.(temporary, this.path)
      await rename(temporary, this.path)
      // Windows does not support fsync on directory handles and returns EPERM.
      // The snapshot file itself is still synced before the atomic rename above.
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
      await rename(`${this.path}.bak`, this.path).catch(() => undefined)
      throw error
    }
  }

  async #acquireLock(): Promise<() => Promise<void>> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const token = randomUUID()
    const timeoutMs = this.options.lockTimeoutMs ?? 10_000
    const retryMs = this.options.lockRetryMs ?? 10
    const deadline = Date.now() + timeoutMs

    for (;;) {
      try {
        const file = await open(this.#lockPath, 'wx', 0o600)
        try {
          await file.writeFile(
            JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }),
          )
          await file.sync()
        } catch (error) {
          await file.close().catch(() => undefined)
          await rm(this.#lockPath, { force: true }).catch(() => undefined)
          throw error
        }
        await file.close()
        return async () => {
          try {
            const owner = JSON.parse(await readFile(this.#lockPath, 'utf8')) as {
              token?: unknown
            }
            if (owner.token !== token) return
            await rm(this.#lockPath, { force: true }).catch(
              (removeError: NodeJS.ErrnoException) => {
                // A racing Windows unlink can report a transient error for a
                // lock that is already delete-pending; the file disappears
                // once the competing handle closes, so treat the lock as
                // released instead of failing a committed write.
                if (!isTransientLockErrorCode(removeError.code)) throw removeError
              },
            )
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (!isTransientLockErrorCode(code)) throw error
        if (code === 'EEXIST' && !(await lockOwnerAlive(this.#lockPath))) {
          await rm(this.#lockPath, { force: true }).catch((removeError: NodeJS.ErrnoException) => {
            // Another writer can win the stale-lock recovery race; the next
            // open attempt decides, so only non-transient failures escape.
            if (!isTransientLockErrorCode(removeError.code)) throw removeError
          })
          continue
        }
        if (Date.now() >= deadline)
          throw new MemoryError('memory_io', 'Timed out waiting for the memory transaction lock', {
            cause: error,
          })
        await delay(retryMs)
      }
    }
  }

  async #read(
    path: string,
  ): Promise<
    | { ok: true; records: readonly MemoryRecord[]; missing?: false; error?: undefined }
    | { ok: false; missing: boolean; error: unknown }
  > {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
      return { ok: true, records: migrateSnapshot(raw) }
    } catch (error) {
      return { ok: false, missing: (error as NodeJS.ErrnoException).code === 'ENOENT', error }
    }
  }
}

/**
 * Lock error codes that mean "contended right now", not "broken".
 *
 * On Windows, `open(path, 'wx')` and `unlink` report EPERM/EACCES/EBUSY while
 * a competing process is creating or removing the lock file (delete-pending
 * handles, sharing violations, antivirus scanners). Treating those like EEXIST
 * and retrying inside the lock budget — instead of surfacing them as a fatal
 * `memory_io` — is what keeps concurrent writers from flaking on loaded
 * Windows runners (LL-7).
 */
function isTransientLockErrorCode(code: string | undefined): boolean {
  return code === 'EEXIST' || code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

async function lockOwnerAlive(path: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown }
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) < 1) {
      // A competing process can observe the file between exclusive creation and
      // metadata fsync. Give that live acquisition a short grace period.
      return Date.now() - (await stat(path)).mtimeMs < 1_000
    }
    try {
      process.kill(Number(value.pid), 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    try {
      return Date.now() - (await stat(path)).mtimeMs < 1_000
    } catch {
      return false
    }
  }
}

function nextTimestamp(previous: string, now: Date): string {
  const previousMilliseconds = Date.parse(previous)
  const nextMilliseconds = now.getTime()
  return new Date(Math.max(nextMilliseconds, previousMilliseconds + 1)).toISOString()
}

function migrateSnapshot(value: unknown): readonly MemoryRecord[] {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid memory snapshot')
  const snapshot = value as Partial<MemorySnapshotV1>
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || !Array.isArray(snapshot.records))
    throw new TypeError('Unsupported memory snapshot schema')
  const records = snapshot.records.map((record) => ({
    ...record,
    attachments: Array.isArray(record.attachments) ? record.attachments : [],
  }))
  for (const record of records) {
    if (record.schemaVersion !== MEMORY_RECORD_SCHEMA_VERSION) {
      throw new TypeError(`Unsupported memory record schema: ${String(record.schemaVersion)}`)
    }
    validateScope(record.scope)
    normalizeAttachments(record.attachments)
  }
  return records
}
