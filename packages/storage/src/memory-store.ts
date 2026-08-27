import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const MEMORY_SCHEMA_VERSION = 'volund.memory.v1'

export type MemoryScope =
  | { kind: 'global'; ownerId: string }
  | { kind: 'project'; ownerId: string; projectId: string }
  | { kind: 'team'; teamId: string }

export interface MemoryAttachmentReference {
  readonly schemaVersion: 1
  readonly handle: string
  readonly mime: string
  readonly size: number
  readonly digest: string
}

export interface ScopedMemoryRecord {
  readonly schemaVersion: typeof MEMORY_SCHEMA_VERSION
  readonly id: string
  readonly scope: MemoryScope
  readonly text: string
  readonly attachments: readonly MemoryAttachmentReference[]
  readonly createdAt: number
}

export interface MemoryPrincipal {
  readonly userId: string
  readonly projectId?: string
  readonly teamIds?: readonly string[]
  /** Team sharing remains disabled until an explicit product authorization enables it. */
  readonly teamSharedAuthorized?: boolean
}

export interface MemoryInput {
  readonly id: string
  readonly scope: MemoryScope
  readonly text: string
  readonly attachments?: readonly MemoryAttachmentReference[]
  readonly createdAt?: number
}

const HANDLE = /^([a-f0-9]{64})\.(?:png|jpg|gif|webp)$/

export function validateMemoryAttachmentReference(
  value: unknown,
): value is MemoryAttachmentReference {
  if (!value || typeof value !== 'object') return false
  const ref = value as MemoryAttachmentReference
  const match = HANDLE.exec(ref.handle)
  return (
    ref.schemaVersion === 1 &&
    Boolean(match) &&
    ref.digest === match?.[1] &&
    /^image\/(?:png|jpeg|gif|webp)$/.test(ref.mime) &&
    Number.isSafeInteger(ref.size) &&
    ref.size > 0
  )
}

export function canAccessMemory(scope: MemoryScope, principal: MemoryPrincipal): boolean {
  if (scope.kind === 'global') return scope.ownerId === principal.userId
  if (scope.kind === 'project')
    return scope.ownerId === principal.userId && scope.projectId === principal.projectId
  return (
    principal.teamSharedAuthorized === true && Boolean(principal.teamIds?.includes(scope.teamId))
  )
}

function validateScope(scope: MemoryScope): void {
  if (scope.kind === 'team') {
    if (!scope.teamId) throw new TypeError('Memory team scope requires teamId')
  } else if (!scope.ownerId || (scope.kind === 'project' && !scope.projectId)) {
    throw new TypeError('Memory scope is incomplete')
  }
}

function validateId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw new TypeError('Invalid memory id')
}

/** Local-only persistence. ACL filtering happens before any semantic ranking. */
export class ScopedMemoryStore {
  constructor(
    readonly root: string,
    readonly now: () => number = Date.now,
  ) {}

  async write(input: MemoryInput, principal: MemoryPrincipal): Promise<ScopedMemoryRecord> {
    validateId(input.id)
    validateScope(input.scope)
    if (!canAccessMemory(input.scope, principal)) throw new Error('memory_scope_denied')
    if (!input.text.trim()) throw new TypeError('Memory text is empty')
    const attachments = input.attachments ?? []
    if (!attachments.every(validateMemoryAttachmentReference))
      throw new TypeError('Invalid memory attachment reference')
    const record: ScopedMemoryRecord = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      id: input.id,
      scope: input.scope,
      text: input.text,
      attachments,
      createdAt: input.createdAt ?? this.now(),
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await writeFile(resolve(this.root, `${input.id}.json`), JSON.stringify(record, null, 2), {
      mode: 0o600,
      flag: 'wx',
    })
    return record
  }

  async list(principal: MemoryPrincipal): Promise<ScopedMemoryRecord[]> {
    let names: string[]
    try {
      names = await readdir(this.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records = await Promise.all(
      names
        .filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.json$/.test(name))
        .map(
          async (name) =>
            JSON.parse(await readFile(resolve(this.root, name), 'utf8')) as ScopedMemoryRecord,
        ),
    )
    return records.filter(
      (record) =>
        record.schemaVersion === MEMORY_SCHEMA_VERSION && canAccessMemory(record.scope, principal),
    )
  }

  async recall(
    principal: MemoryPrincipal,
    scores: Readonly<Record<string, number>>,
    limit = 10,
  ): Promise<ScopedMemoryRecord[]> {
    return (await this.list(principal))
      .filter((record) => Number.isFinite(scores[record.id]))
      .sort(
        (a, b) =>
          (scores[b.id] ?? -Infinity) - (scores[a.id] ?? -Infinity) || a.id.localeCompare(b.id),
      )
      .slice(0, Math.max(0, limit))
  }
}
