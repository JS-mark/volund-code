import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { acquireMemoryFileLock } from './memory-file-lock'
import {
  MEMORY_RECORD_SCHEMA_VERSION,
  LocalMemoryRepository,
  validateMemoryRecordAttachment,
  type MemoryRecord,
  type MemoryRecordAttachment,
  type MemoryRecordScope,
  type MemoryRepository,
  type MemoryRepositoryCommit,
  type MemoryProvenance,
} from './memory-runtime'

/**
 * Markdown persistence for memory records (ADR-0012, restoring spec §6.12.1/6.12.2):
 * one human-editable `.md` file per record — YAML frontmatter for metadata, the
 * markdown body is the record content verbatim. The service/repository contract,
 * ACL model, and built-in guards from ADR-0010 are unchanged; only the bytes on
 * disk move from a single JSON snapshot to per-record files:
 *
 * - workspace scope → `<root>/*.md`
 * - project scope   → the current project's `<cwd>/.volund/memory/*.md`, other
 *   projects under `<root>/projects/<projectId>/*.md`
 * - session scope   → `<root>/sessions/*.md`
 *
 * Hand-authored files are first-class: `load()` picks up every valid `.md` in the
 * managed directories, and `save()` only ever writes or removes files it has seen
 * through `load()`/`save()` before, so user-created notes are never swept away.
 */

export interface MarkdownMemoryLayoutOptions {
  /** Directory holding workspace records plus the `projects/` and `sessions/` subtrees. */
  readonly root: string
  /**
   * Project identity of the process' current working directory. Records for this
   * project persist next to the code they describe; every other project goes to
   * the fallback area under `root`.
   */
  readonly currentProjectId?: string
  /** Directory for the current project's records, e.g. `<cwd>/.volund/memory`. */
  readonly currentProjectDir?: string
}

export class MarkdownMemoryLayout {
  readonly #root: string
  readonly #currentProjectId: string | undefined
  readonly #currentProjectDir: string | undefined

  constructor(options: MarkdownMemoryLayoutOptions) {
    this.#root = options.root
    this.#currentProjectId = options.currentProjectId
    this.#currentProjectDir = options.currentProjectDir
  }

  directoryFor(scope: MemoryRecordScope): string {
    if (scope.kind === 'workspace') return this.#root
    if (scope.kind === 'session') return join(this.#root, 'sessions')
    if (
      this.#currentProjectId !== undefined &&
      scope.projectId === this.#currentProjectId &&
      this.#currentProjectDir !== undefined
    )
      return this.#currentProjectDir
    return join(this.#root, 'projects', scope.projectId)
  }

  /** Directory holding session-scope records; excluded from MEMORY.md indexing (high churn, low value). */
  get sessionsDirectory(): string {
    return join(this.#root, 'sessions')
  }

  /** Every directory that may hold record files, including existing project subdirs. */
  async directories(): Promise<readonly string[]> {
    const directories = new Set<string>([this.#root, join(this.#root, 'sessions')])
    if (this.#currentProjectDir !== undefined) directories.add(this.#currentProjectDir)
    const projectsDir = join(this.#root, 'projects')
    let entries: Dirent[]
    try {
      entries = await readdir(projectsDir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      entries = []
    }
    for (const entry of entries)
      if (entry.isDirectory()) directories.add(join(projectsDir, entry.name))
    return [...directories]
  }
}

export interface MarkdownMemoryRepositoryOptions {
  readonly layout: MarkdownMemoryLayout
  readonly lockPath: string
  /**
   * JSON snapshot (ADR-0010 era) migrated into markdown on first open and then
   * renamed to `<path>.imported` as the archive of the pre-migration state.
   */
  readonly legacySnapshotPath?: string
  lockTimeoutMs?: number
  lockRetryMs?: number
}

interface ManagedFile {
  readonly path: string
  readonly record: MemoryRecord
}

const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const provenanceSources = new Set(['user', 'agent', 'evolution', 'import'])

export class MarkdownMemoryRepository implements MemoryRepository {
  readonly #options: MarkdownMemoryRepositoryOptions
  #managed = new Map<string, ManagedFile>()
  #legacyChecked = false

  constructor(options: MarkdownMemoryRepositoryOptions) {
    this.#options = options
  }

  async load(): Promise<readonly MemoryRecord[]> {
    const release = await this.#acquireLock()
    try {
      await this.#migrateLegacyIfNeeded()
      return await this.#loadUnlocked()
    } finally {
      await release()
    }
  }

  async save(records: readonly MemoryRecord[]): Promise<void> {
    const release = await this.#acquireLock()
    try {
      await this.#migrateLegacyIfNeeded()
      await this.#syncToDisk(records)
    } finally {
      await release()
    }
  }

  async transaction<T>(
    operation: (records: readonly MemoryRecord[]) => Promise<MemoryRepositoryCommit<T>>,
  ): Promise<MemoryRepositoryCommit<T>> {
    const release = await this.#acquireLock()
    try {
      await this.#migrateLegacyIfNeeded()
      const commit = await operation(await this.#loadUnlocked())
      await this.#syncToDisk(commit.records)
      return commit
    } finally {
      await release()
    }
  }

  async flush(): Promise<void> {
    // Every record write fsyncs its file; nothing is buffered across calls.
  }

  #acquireLock(): Promise<() => Promise<void>> {
    return acquireMemoryFileLock(this.#options.lockPath, {
      ...(this.#options.lockTimeoutMs === undefined
        ? {}
        : { lockTimeoutMs: this.#options.lockTimeoutMs }),
      ...(this.#options.lockRetryMs === undefined
        ? {}
        : { lockRetryMs: this.#options.lockRetryMs }),
    })
  }

  /**
   * One-time import of the ADR-0010 JSON snapshot. Idempotent and crash-safe:
   * record files are written first (same id → same filename → identical bytes on
   * retry), and the snapshot is only renamed to `.imported` after every write
   * succeeded. A snapshot that is unreadable together with its `.bak` fails loud
   * instead of silently hiding records.
   */
  async #migrateLegacyIfNeeded(): Promise<void> {
    if (this.#legacyChecked || this.#options.legacySnapshotPath === undefined) return
    this.#legacyChecked = true
    const legacyPath = this.#options.legacySnapshotPath
    try {
      await stat(legacyPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const records = await new LocalMemoryRepository(legacyPath).load()
    if (records.length > 0) await this.#syncToDisk(records)
    await rename(legacyPath, `${legacyPath}.imported`)
    await rm(`${legacyPath}.bak`, { force: true })
  }

  async #loadUnlocked(): Promise<readonly MemoryRecord[]> {
    const byId = new Map<string, { record: MemoryRecord; path: string; mtimeMs: number }>()
    for (const directory of await this.#options.layout.directories()) {
      let entries: Dirent[]
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.')) continue
        if (entry.name === INDEX_FILENAME) continue
        const path = join(directory, entry.name)
        const parsed = await this.#readMemoryFile(path)
        if (!parsed) continue
        const existing = byId.get(parsed.record.id)
        if (
          existing === undefined ||
          parsed.mtimeMs > existing.mtimeMs ||
          (parsed.mtimeMs === existing.mtimeMs && path > existing.path)
        )
          byId.set(parsed.record.id, parsed)
      }
    }
    this.#managed = new Map(
      [...byId].map(([id, parsed]) => [id, { path: parsed.path, record: parsed.record }]),
    )
    return [...byId.values()].map((parsed) => parsed.record)
  }

  async #readMemoryFile(
    path: string,
  ): Promise<{ record: MemoryRecord; path: string; mtimeMs: number } | null> {
    let raw: string
    let mtimeMs: number
    try {
      raw = await readFile(path, 'utf8')
      mtimeMs = (await stat(path)).mtimeMs
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const record = parseMemoryFile(raw, mtimeMs)
    return record ? { record, path, mtimeMs } : null
  }

  /**
   * Diffs the desired record set against the managed files: writes new and
   * changed records (keeping an established filename stable across updates),
   * removes files whose records disappeared. Files never seen through load()
   * or a previous save are left untouched.
   */
  async #syncToDisk(records: readonly MemoryRecord[]): Promise<void> {
    const nextIds = new Set(records.map((record) => record.id))
    const touchedDirectories = new Set<string>()
    for (const record of records) {
      const managed = this.#managed.get(record.id)
      if (managed && sameRecord(managed.record, record)) continue
      const path =
        managed?.path ??
        join(this.#options.layout.directoryFor(record.scope), canonicalFilename(record))
      await writeFileAtomic(path, serializeRecord(record))
      touchedDirectories.add(dirname(path))
      this.#managed.set(record.id, { path, record })
    }
    for (const [id, managed] of [...this.#managed]) {
      if (nextIds.has(id)) continue
      await rm(managed.path, { force: true })
      touchedDirectories.add(dirname(managed.path))
      this.#managed.delete(id)
    }
    for (const directory of touchedDirectories) {
      if (isSessionDirectory(this.#options.layout, directory)) continue
      await writeFileAtomic(
        join(directory, INDEX_FILENAME),
        memoryIndexDocument(this.#managed, directory),
      )
    }
    if (process.platform !== 'win32') {
      for (const directory of touchedDirectories) await syncDirectory(directory)
    }
  }
}

/** Machine-generated per-directory index of the record files (human-scannable, always rewritten). */
export const INDEX_FILENAME = 'MEMORY.md'

const INDEX_HEADER =
  '<!-- Auto-generated by volund memory. Do not edit — rewritten on every memory write. -->\n'

function isSessionDirectory(layout: MarkdownMemoryLayout, directory: string): boolean {
  return directory === layout.sessionsDirectory
}

function memoryIndexDocument(managed: ReadonlyMap<string, ManagedFile>, directory: string): string {
  const lines: string[] = []
  for (const { path, record } of [...managed.values()].toSorted(
    (left, right) =>
      left.record.createdAt.localeCompare(right.record.createdAt) ||
      left.record.id.localeCompare(right.record.id),
  )) {
    if (dirname(path) !== directory) continue
    const summary = markdownSafe(record.content.split('\n', 1)[0]?.trim().slice(0, 120) ?? '')
    lines.push(
      `- [${basename(path, '.md')}](${basename(path)}) — ${summary}${record.pinned ? ' `pinned`' : ''}${record.deletedAt ? ' `deleted`' : ''}`,
    )
  }
  return `${INDEX_HEADER}\n${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`
}

/** Keeps a first-line summary from breaking the index line's link syntax. */
function markdownSafe(value: string): string {
  return value.replaceAll('[', '(').replaceAll(']', ')').replaceAll('`', "'")
}

// `#managed` is reassigned wholesale on load so that save() diffs against
// exactly what the last load observed, never against stale paths.

function sameRecord(left: MemoryRecord, right: MemoryRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function frontmatterFor(record: MemoryRecord): Record<string, unknown> {
  const provenance = record.provenance
  return {
    schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
    id: record.id,
    scope: record.scope.kind,
    workspaceId: record.scope.workspaceId,
    ...(record.scope.kind === 'workspace' ? {} : { projectId: record.scope.projectId }),
    ...(record.scope.kind === 'session' ? { sessionId: record.scope.sessionId } : {}),
    tags: [...record.tags],
    pinned: record.pinned,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deletedAt: record.deletedAt,
    source: provenance.source,
    ...(provenance.actorId === undefined ? {} : { actorId: provenance.actorId }),
    ...(provenance.sourceId === undefined ? {} : { sourceId: provenance.sourceId }),
    ...(provenance.importedFrom === undefined
      ? {}
      : {
          importedFrom: {
            source: provenance.importedFrom.source,
            ...(provenance.importedFrom.actorId === undefined
              ? {}
              : { actorId: provenance.importedFrom.actorId }),
            ...(provenance.importedFrom.sourceId === undefined
              ? {}
              : { sourceId: provenance.importedFrom.sourceId }),
          },
        }),
    ...(record.attachments.length > 0 ? { attachments: record.attachments } : {}),
  }
}

function serializeRecord(record: MemoryRecord): string {
  const frontmatter = stringifyYaml(frontmatterFor(record), { lineWidth: 0 })
  return `---\n${frontmatter}---\n${record.content}`
}

/**
 * Parses and validates one record file. Returns null for anything that is not a
 * well-formed memory record — such files stay on disk untouched and are reported
 * by `volund memory doctor`-adjacent tooling rather than silently rewritten.
 * The markdown body after the closing fence is the record content byte-for-byte.
 */
export function parseMemoryFile(raw: string, mtimeMs: number): MemoryRecord | null {
  const openMatch = /^---\r?\n/.exec(raw)
  if (!openMatch) return null
  const rest = raw.slice(openMatch[0].length)
  const closeMatch = /\n---\r?\n/.exec(rest)
  if (!closeMatch) return null
  let frontmatter: unknown
  try {
    frontmatter = parseYaml(rest.slice(0, closeMatch.index))
  } catch {
    return null
  }
  const record = recordFromFrontmatter(
    frontmatter,
    rest.slice(closeMatch.index + closeMatch[0].length),
    mtimeMs,
  )
  return record
}

function recordFromFrontmatter(
  value: unknown,
  content: string,
  mtimeMs: number,
): MemoryRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const frontmatter = value as Record<string, unknown>
  if (frontmatter.schemaVersion !== MEMORY_RECORD_SCHEMA_VERSION) return null
  if (typeof frontmatter.id !== 'string' || !identifierPattern.test(frontmatter.id)) return null
  const scope = parseScope(frontmatter)
  if (!scope) return null

  const fallbackTime = new Date(mtimeMs).toISOString()
  const createdAt = parseTimestamp(frontmatter.createdAt) ?? fallbackTime
  const updatedAt = parseTimestamp(frontmatter.updatedAt) ?? createdAt
  const deletedAt =
    frontmatter.deletedAt === undefined || frontmatter.deletedAt === null
      ? null
      : parseTimestamp(frontmatter.deletedAt)
  if (frontmatter.deletedAt !== undefined && frontmatter.deletedAt !== null && deletedAt === null)
    return null
  const pinned = frontmatter.pinned === undefined ? false : expectBoolean(frontmatter.pinned)
  if (pinned === null) return null
  const tags = frontmatter.tags === undefined ? [] : expectStringArray(frontmatter.tags)
  if (!tags) return null
  const source =
    frontmatter.source === undefined ? 'user' : expectProvenanceSource(frontmatter.source)
  if (!source) return null
  const importedFrom = parseImportedFrom(frontmatter.importedFrom)
  if (importedFrom === null) return null
  let attachments: MemoryRecordAttachment[] = []
  if (frontmatter.attachments !== undefined) {
    if (!Array.isArray(frontmatter.attachments)) return null
    if (!frontmatter.attachments.every(validateMemoryRecordAttachment)) return null
    attachments = structuredClone(frontmatter.attachments as MemoryRecordAttachment[])
  }

  const provenance: MemoryProvenance = {
    source,
    ...(typeof frontmatter.actorId === 'string' ? { actorId: frontmatter.actorId } : {}),
    ...(typeof frontmatter.sourceId === 'string' ? { sourceId: frontmatter.sourceId } : {}),
    ...(importedFrom === undefined ? {} : { importedFrom }),
  }
  return {
    schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
    id: frontmatter.id,
    scope,
    content,
    provenance,
    attachments,
    tags,
    pinned,
    createdAt,
    updatedAt,
    deletedAt,
  }
}

function parseScope(frontmatter: Record<string, unknown>): MemoryRecordScope | null {
  const workspaceId = frontmatter.workspaceId
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) return null
  const kind = frontmatter.scope
  if (kind === 'workspace') return { kind, workspaceId }
  const projectId = frontmatter.projectId
  if (typeof projectId !== 'string' || projectId.length === 0) return null
  if (kind === 'project') return { kind, workspaceId, projectId }
  const sessionId = frontmatter.sessionId
  if (kind === 'session' && typeof sessionId === 'string' && sessionId.length > 0)
    return { kind, workspaceId, projectId, sessionId }
  return null
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null
  return value
}

function expectBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function expectStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === 'string')) return null
  return [...(value as string[])]
}

function expectProvenanceSource(value: unknown): MemoryProvenance['source'] | null {
  return typeof value === 'string' && provenanceSources.has(value)
    ? (value as MemoryProvenance['source'])
    : null
}

function parseImportedFrom(value: unknown): MemoryProvenance['importedFrom'] | null | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') return null
  const imported = value as Record<string, unknown>
  const source = expectProvenanceSource(imported.source)
  if (!source) return null
  return {
    source,
    ...(typeof imported.actorId === 'string' ? { actorId: imported.actorId } : {}),
    ...(typeof imported.sourceId === 'string' ? { sourceId: imported.sourceId } : {}),
  }
}

/** `YYYY-MM-DD-<slug>-<id-prefix>.md` per spec §6.12.2; the name is cosmetic — the frontmatter id is authoritative. */
function canonicalFilename(record: MemoryRecord): string {
  return `${record.createdAt.slice(0, 10)}-${slugFor(record.content)}-${shortId(record.id)}.md`
}

function slugFor(content: string): string {
  const firstLine = content.split('\n', 1)[0] ?? ''
  const slug = firstLine
    .replace(/^#+\s*/, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 8)
    .join('-')
    .slice(0, 40)
  return slug || 'memo'
}

function shortId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 12)
  return cleaned || 'record'
}

async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(data)
    await file.sync()
  } catch (error) {
    await file.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  await file.close()
  await rename(temporary, path)
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    // The record file itself is already synced; a directory fsync refusal
    // (unsupported platform state) must not fail an otherwise durable write.
    if (!((error as NodeJS.ErrnoException).code === 'EPERM')) throw error
  }
}
