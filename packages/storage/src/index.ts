import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import {
  copyFile,
  lstat,
  open,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'

import type { CoreEvent, EventBus, PromptComposer } from '@apollo-code/core'
import type { PermissionDecision, PermissionRequest } from '@apollo-code/permission'
import { sanitize, type JsonValue } from '@apollo-code/shared'

import type { MemoryRecordAttachment } from './memory-runtime'
export * from './evolution-store'
export * from './memory-store'
export * from './memory-index'
export * from './memory-runtime'
export * from './memory-transfer'
export * from './memory-prompt-provider'
export interface StoredEvent {
  v: 1
  id: string
  type: string
  sessionId: string
  /** envelope 字段（附录 D.1）：turn 边界 + subagent 冒泡 tag（D.3）随事件一起落盘。 */
  turnId?: string
  parentTurnId?: string
  parentDepth?: number
  at: string
  payload: JsonValue
}
export class SessionStore {
  readonly #seen = new Set<string>()
  constructor(readonly path: string) {}
  attach(bus: EventBus): () => void {
    return bus.subscribe((event) => this.appendCore(event))
  }
  async appendCore(event: CoreEvent): Promise<void> {
    if (event.type === 'stream.delta' || this.#seen.has(event.id)) return
    this.#seen.add(event.id)
    await this.append({
      v: 1,
      id: event.id,
      type: event.type,
      sessionId: event.sessionId,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(event.parentTurnId ? { parentTurnId: event.parentTurnId } : {}),
      ...(event.parentDepth === undefined ? {} : { parentDepth: event.parentDepth }),
      at: new Date().toISOString(),
      payload: event.payload,
    })
  }
  async append(event: StoredEvent): Promise<void> {
    if (containsInlineBinary(event.payload))
      throw new Error('Binary attachments cannot be written to session JSONL')
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const file = await open(this.path, 'a', 0o600)
    try {
      await file.write(`${JSON.stringify(event)}\n`)
      await file.sync()
    } finally {
      await file.close()
    }
  }
  async load(): Promise<StoredEvent[]> {
    const out: StoredEvent[] = []
    try {
      const rl = createInterface({ input: createReadStream(this.path), crlfDelay: Infinity })
      for await (const line of rl) {
        if (!line) continue
        const event = JSON.parse(line) as StoredEvent
        if (event.v > 1) throw new Error('Session is from a newer Apollo version')
        out.push(event)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return out
  }
  async resume(tailTurns = 20): Promise<StoredEvent[]> {
    const all = await this.load(),
      starts = all.map((e, i) => (e.type === 'turn.started' ? i : -1)).filter((i) => i >= 0),
      from = starts.at(-tailTurns) ?? 0
    return all.slice(from)
  }
}
function containsInlineBinary(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (value instanceof Uint8Array) return true
  return Object.values(value).some(containsInlineBinary)
}
export interface PromptLoaderOptions {
  cwd: string
  apolloHome?: string
  permissions: {
    request(request: PermissionRequest): Promise<PermissionDecision>
  }
  maxDepth?: number
  maxIncludes?: number
}
export class PromptLoader {
  #count = 0
  constructor(readonly options: PromptLoaderOptions) {}
  async load(path: string): Promise<string> {
    this.#count = 0
    return this.expand(path, 0, new Set())
  }
  async registerProject(composer: PromptComposer): Promise<Array<{ dispose(): void }>> {
    const out = []
    let current = await realpath(this.options.cwd),
      home = await realpath(homedir())
    for (let level = 0; level < 8; level++) {
      const agent = resolve(current, 'AGENT.md'),
        claude = resolve(current, 'CLAUDE.md')
      let path: string | undefined
      try {
        await open(agent, 'r').then((f) => f.close())
        path = agent
      } catch {
        try {
          await open(claude, 'r').then((f) => f.close())
          path = claude
        } catch {}
      }
      if (path) {
        out.push(
          composer.register({
            id: `project:${path}`,
            source: `project:${path}`,
            priority: Math.max(500, 600 - level * 10),
            text: await this.load(path),
          }),
        )
      }
      if (current === home || dirname(current) === current) break
      current = dirname(current)
    }
    const user = resolve(this.options.apolloHome ?? resolve(homedir(), '.apollo'), 'PROMPT.md')
    try {
      out.push(
        composer.register({
          id: 'user',
          source: 'user',
          priority: 400,
          text: await this.load(user),
        }),
      )
    } catch {}
    return out
  }
  private async expand(path: string, depth: number, seen: Set<string>): Promise<string> {
    if (depth > (this.options.maxDepth ?? 8)) return `<!-- include: ${path} — DENIED (depth) -->`
    if (this.#count++ >= (this.options.maxIncludes ?? 64))
      return `<!-- include: ${path} — DENIED (limit) -->`
    if (extname(path).toLowerCase() !== '.md') return `<!-- include: ${path} — DENIED (non-md) -->`
    if (sensitive(path)) return `<!-- include: ${path} — DENIED (sensitive) -->`
    const target = isAbsolute(path) ? path : resolve(this.options.cwd, path)
    let canonical: string
    try {
      canonical = await realpath(target)
    } catch {
      return `<!-- include: ${path} — ERROR (not found) -->`
    }
    const roots = [
      await realpath(this.options.cwd),
      await mkdir(this.options.apolloHome ?? resolve(homedir(), '.apollo'), {
        recursive: true,
      }).then(() => realpath(this.options.apolloHome ?? resolve(homedir(), '.apollo'))),
    ]
    if (
      !roots.some((root) => {
        const rel = relative(root, canonical)
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
      })
    )
      return `<!-- include: ${path} — DENIED (outside roots) -->`
    if (seen.has(canonical)) return `<!-- include: ${path} — DENIED (cycle) -->`
    const decision = await this.options.permissions.request({
      toolName: 'Read',
      spec: { fs: { read: [canonical] } },
      input: { path: canonical },
      session: { id: 'prompt-loader', cwd: roots[0]! },
      attempt: 1,
    })
    if (decision.kind.startsWith('deny')) return `<!-- include: ${path} — DENIED (permission) -->`
    const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
    let text: string
    try {
      const stat = await file.stat()
      if (!stat.isFile()) throw new Error('not a file')
      text = await file.readFile('utf8')
    } finally {
      await file.close()
    }
    const next = new Set(seen).add(canonical)
    let fenced = false
    const lines = text.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.startsWith('```')) fenced = !fenced
      if (fenced) continue
      const match = /^@include ([^#\s]+)(?:\s+#.*)?$/.exec(lines[i]!)
      if (match) {
        const child = match[1]!.startsWith('~/')
          ? resolve(homedir(), match[1]!.slice(2))
          : resolve(dirname(canonical), match[1]!)
        const body = await this.expand(child, depth + 1, next)
        lines[i] =
          `<!-- include: ${match[1]} depth=${depth + 1} -->\n${body}\n<!-- /include ${match[1]} -->`
      }
    }
    return lines.join('\n')
  }
}
function sensitive(path: string): boolean {
  const portablePath = path.replaceAll('\\', '/')
  return (
    /(?:^|\/)(?:\.env[^/]*|credentials[^/]*|auth[^/]*|id_[^/]+|[^/]*\.(?:pem|key))$/i.test(
      portablePath,
    ) || portablePath.includes('/.ssh/')
  )
}
export async function sourceHash(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}
export function sanitizeSession<T>(value: T): T {
  return sanitize(value)
}

const imageSignatures: Array<{ mime: string; bytes: number[]; extension: string }> = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47], extension: 'png' },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff], extension: 'jpg' },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38], extension: 'gif' },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], extension: 'webp' },
]
export interface StagedAttachment {
  handle: string
  mime: string
  size: number
  digest: string
}
export class AttachmentStore {
  constructor(
    readonly root: string,
    readonly maxBytes = 20 * 1024 * 1024,
    readonly allowedPathRoots: readonly string[] = [],
  ) {}
  async stage(bytes: Uint8Array, mime: string): Promise<StagedAttachment> {
    if (bytes.byteLength === 0) throw new TypeError('Attachment is empty')
    if (bytes.byteLength > this.maxBytes) throw new RangeError('Attachment exceeds size limit')
    const signature = imageSignatures.find((item) => item.mime === mime)
    if (!signature) throw new TypeError(`Unsupported attachment MIME: ${mime}`)
    if (!signature.bytes.every((byte, index) => bytes[index] === byte))
      throw new TypeError(`Attachment bytes do not match MIME: ${mime}`)
    if (mime === 'image/webp' && String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP')
      throw new TypeError('Attachment bytes do not match MIME: image/webp')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const handle = `${digest}.${signature.extension}`
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const path = resolve(this.root, handle)
    try {
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    return { handle, mime, size: bytes.byteLength, digest }
  }
  reference(
    id: string,
    staged: StagedAttachment,
    createdAt = new Date().toISOString(),
  ): MemoryRecordAttachment {
    return {
      schemaVersion: 1,
      id,
      ...staged,
      state: 'active',
      createdAt,
      invalidatedAt: null,
      deletedAt: null,
    }
  }
  async delete(handle: string): Promise<void> {
    if (!/^[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/.test(handle))
      throw new TypeError('Invalid attachment handle')
    await rm(resolve(this.root, handle), { force: true })
  }
  async read(source: import('@apollo-code/provider-kit').AttachmentRef): Promise<Uint8Array> {
    if (source.kind === 'inline') return source.bytes
    if (source.kind === 'path') {
      const target = await realpath(source.absPath)
      const allowed = await Promise.all(
        this.allowedPathRoots.map(async (root) => {
          const rel = relative(await realpath(root), target)
          return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
        }),
      )
      if (!allowed.some(Boolean) || sensitive(target))
        throw new TypeError('Attachment path is outside allowed roots')
      return new Uint8Array(await readFile(target))
    }
    if (!/^[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/.test(source.handle))
      throw new TypeError('Invalid attachment handle')
    return new Uint8Array(await readFile(resolve(this.root, source.handle)))
  }
}

export interface BackupRecord {
  path: string
  existed: boolean
  beforeHash?: string
  afterHash: string
  backupPath?: string
  createdAt: string
  /**
   * Identifies the tool execution (commit batch) this record belongs to.
   * r13-G4: `/undo` restores exactly one batch per invocation (spec 08-session-config.md §8.6.2).
   */
  stepId?: string
  /** Set when a `/undo` single-step restore consumed this record; consumed steps are skipped. */
  consumedAt?: string
}

interface BackupManifest {
  v: 1
  sessionId: string
  records: BackupRecord[]
}

export interface UndoStepWarning {
  path: string
  kind: 'backup_missing' | 'target_modified'
}

export interface UndoStepResult {
  undone: boolean
  reason?: 'no_backup'
  paths: string[]
  warnings: UndoStepWarning[]
  stepCreatedAt?: string
}

export interface RestoreResult {
  restored: string[]
  conflicts: string[]
  missing: boolean
  dryRun: boolean
}

export interface BackupStoreOptions {
  retentionMs?: number
  maxBytes?: number
  now?: () => number
}

export class BackupStore {
  readonly retentionMs: number
  readonly maxBytes: number
  readonly now: () => number
  constructor(
    readonly root: string,
    options: BackupStoreOptions = {},
  ) {
    this.retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000
    this.maxBytes = options.maxBytes ?? 500 * 1024 * 1024
    this.now = options.now ?? Date.now
  }
  async prepare(sessionId: string, inputPaths: string[]) {
    validateSessionId(sessionId)
    const paths = [...new Set(inputPaths)]
    const captures = await Promise.all(
      paths.map(async (path) => {
        try {
          const info = await lstat(path)
          if (!info.isFile()) throw new Error(`Backup target is not a regular file: ${path}`)
          const beforeHash = await sourceHash(path)
          const backupPath = resolve(this.root, sessionId, 'objects', beforeHash)
          await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 })
          try {
            await copyFile(path, backupPath, constants.COPYFILE_EXCL)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          }
          return { path, existed: true as const, beforeHash, backupPath }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return { path, existed: false as const }
          throw error
        }
      }),
    )
    let settled = false
    return {
      commit: async () => {
        if (settled) return
        const createdAt = new Date(this.now()).toISOString()
        const stepId = randomUUID()
        const records: BackupRecord[] = await Promise.all(
          captures.map(async (capture) => ({
            ...capture,
            afterHash: await sourceHash(capture.path),
            createdAt,
            stepId,
          })),
        )
        await this.appendRecords(sessionId, records)
        settled = true
        await this.gc()
      },
      rollback: async () => {
        if (settled) return
        for (const capture of [...captures].reverse()) {
          if (capture.existed) await copyFile(capture.backupPath, capture.path)
          else await rm(capture.path, { force: true })
        }
        settled = true
      },
    }
  }
  async restore(sessionId: string, options: { dryRun?: boolean } = {}): Promise<RestoreResult> {
    validateSessionId(sessionId)
    const manifest = await this.readManifest(sessionId)
    if (!manifest)
      return { restored: [], conflicts: [], missing: true, dryRun: Boolean(options.dryRun) }
    const latest = new Map<string, BackupRecord>()
    const original = new Map<string, BackupRecord>()
    for (const record of manifest.records) {
      if (!latest.has(record.path)) latest.set(record.path, record)
      original.set(record.path, record)
    }
    const releases: Array<() => Promise<void>> = []
    try {
      for (const path of [...latest.keys()].toSorted())
        releases.push(await acquireFileLock(`${path}.apollolock`, `restore ${sessionId}`))
      const conflicts: string[] = []
      for (const record of latest.values()) {
        const initial = original.get(record.path)!
        try {
          const currentHash = await sourceHash(record.path)
          if (currentHash !== record.afterHash && currentHash !== initial.beforeHash)
            conflicts.push(record.path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || initial.existed)
            conflicts.push(record.path)
        }
      }
      if (conflicts.length)
        return { restored: [], conflicts, missing: false, dryRun: Boolean(options.dryRun) }
      const restored = [...latest.keys()]
      if (!options.dryRun) {
        const rollbackDir = resolve(this.root, sessionId, `.restore-${randomUUID()}`)
        const current: Array<{ path: string; copy?: string; existed: boolean }> = []
        try {
          await mkdir(rollbackDir, { recursive: true, mode: 0o700 })
          for (const [index, record] of [...latest.values()].entries()) {
            try {
              const copy = resolve(rollbackDir, String(index))
              await copyFile(record.path, copy)
              current.push({ path: record.path, copy, existed: true })
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
              current.push({ path: record.path, existed: false })
            }
          }
          for (const record of [...original.values()].toReversed()) {
            if (record.existed && record.backupPath) {
              assertWithin(resolve(this.root, sessionId), record.backupPath)
              await mkdir(dirname(record.path), { recursive: true })
              await copyFile(record.backupPath, record.path)
            } else await rm(record.path, { force: true })
          }
        } catch (error) {
          for (const snapshot of current.toReversed()) {
            if (snapshot.existed && snapshot.copy) await copyFile(snapshot.copy, snapshot.path)
            else await rm(snapshot.path, { force: true })
          }
          throw error
        } finally {
          await rm(rollbackDir, { recursive: true, force: true })
        }
      }
      return { restored, conflicts: [], missing: false, dryRun: Boolean(options.dryRun) }
    } finally {
      for (const release of releases.toReversed()) await release()
    }
  }
  /**
   * r13-G4 (spec 08-session-config.md §8.6.2): `/undo` selection rules.
   * The undo target is the most recent not-yet-consumed backup batch — one
   * side-effecting tool execution — selected by backup entry order (manifest is
   * newest-first) rather than by "last tool run", so read-only tools that
   * produce no entries are skipped naturally. Bash has no backup semantics and
   * is therefore out of scope. Warnings (backup object missing, target
   * externally modified after the backup) never block the restore; the caller
   * surfaces them in the UI because the restore may overwrite manual changes.
   */
  async undoStep(sessionId: string): Promise<UndoStepResult> {
    validateSessionId(sessionId)
    const manifest = await this.readManifest(sessionId)
    if (!manifest || manifest.records.length === 0)
      return { undone: false, reason: 'no_backup', paths: [], warnings: [] }
    const step = undoStepsOf(manifest.records).find((records) =>
      records.every((record) => !record.consumedAt),
    )
    if (!step) return { undone: false, reason: 'no_backup', paths: [], warnings: [] }
    const paths = [...new Set(step.map((record) => record.path))].toSorted()
    const warnings: UndoStepWarning[] = []
    const releases: Array<() => Promise<void>> = []
    try {
      for (const path of paths)
        releases.push(await acquireFileLock(`${path}.apollolock`, `undo ${sessionId}`))
      for (const record of step) {
        if (record.existed && record.backupPath) {
          assertWithin(resolve(this.root, sessionId), record.backupPath)
          let backupPresent = true
          try {
            await stat(record.backupPath)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            backupPresent = false
            warnings.push({ path: record.path, kind: 'backup_missing' })
          }
          try {
            const currentHash = await sourceHash(record.path)
            if (currentHash !== record.afterHash && currentHash !== record.beforeHash)
              warnings.push({ path: record.path, kind: 'target_modified' })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            // Target vanished since the backup: restoring recreates it, nothing to warn about.
          }
          if (backupPresent) {
            await mkdir(dirname(record.path), { recursive: true })
            await copyFile(record.backupPath, record.path)
          }
        } else {
          await rm(record.path, { force: true })
        }
      }
      await this.markConsumed(sessionId, step)
      const stepCreatedAt = step[0]?.createdAt
      return {
        undone: true,
        paths,
        warnings,
        ...(stepCreatedAt ? { stepCreatedAt } : {}),
      }
    } finally {
      for (const release of releases.toReversed()) await release()
    }
  }
  private async markConsumed(sessionId: string, step: readonly BackupRecord[]): Promise<void> {
    const consumedAt = new Date(this.now()).toISOString()
    const identity = new Set(step.map(undoRecordKey))
    const path = this.manifestPath(sessionId)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const release = await acquireFileLock(`${path}.lock`, `manifest ${sessionId}`)
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      const current = await this.readManifest(sessionId)
      if (!current) return
      for (const record of current.records)
        if (!record.consumedAt && identity.has(undoRecordKey(record)))
          record.consumedAt = consumedAt
      await writeFile(temporary, `${JSON.stringify({ ...current, records: current.records })}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
      await release()
    }
  }
  async gc(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const lockPath = resolve(this.root, '.gc.lock')
    let lock
    try {
      lock = await open(lockPath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
      throw error
    }
    try {
      const manifestsRoot = this.root
      let entries
      try {
        entries = await readdir(manifestsRoot, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      const manifests = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            const path = resolve(manifestsRoot, entry.name)
            let info
            try {
              info = await stat(resolve(path, 'manifest.json'))
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
              info = await stat(path)
            }
            return { path, mtimeMs: info.mtimeMs, size: await directorySize(path) }
          }),
      )
      const oldestFirst = manifests.toSorted((a, b) => a.mtimeMs - b.mtimeMs)
      let total = oldestFirst.reduce((sum, entry) => sum + entry.size, 0)
      for (const entry of oldestFirst) {
        if (this.now() - entry.mtimeMs <= this.retentionMs && total <= this.maxBytes) continue
        await rm(entry.path, { force: true, recursive: true })
        total -= entry.size
      }
    } finally {
      await lock.close()
      await rm(lockPath, { force: true })
    }
  }
  private manifestPath(sessionId: string): string {
    return resolve(this.root, sessionId, 'manifest.json')
  }
  private async readManifest(sessionId: string): Promise<BackupManifest | undefined> {
    try {
      const parsed = JSON.parse(
        await readFile(this.manifestPath(sessionId), 'utf8'),
      ) as BackupManifest
      if (parsed.v !== 1 || parsed.sessionId !== sessionId || !Array.isArray(parsed.records))
        throw new Error('Backup manifest is corrupt')
      for (const record of parsed.records) {
        if (
          !record ||
          typeof record.path !== 'string' ||
          typeof record.existed !== 'boolean' ||
          typeof record.afterHash !== 'string' ||
          (record.existed &&
            (typeof record.beforeHash !== 'string' || typeof record.backupPath !== 'string'))
        )
          throw new Error('Backup manifest is corrupt')
      }
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      if (error instanceof SyntaxError)
        throw new Error('Backup manifest is corrupt', { cause: error })
      throw error
    }
  }
  private async appendRecords(sessionId: string, records: BackupRecord[]): Promise<void> {
    const path = this.manifestPath(sessionId)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const release = await acquireFileLock(`${path}.lock`, `manifest ${sessionId}`)
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      const current = (await this.readManifest(sessionId)) ?? { v: 1, sessionId, records: [] }
      await writeFile(
        temporary,
        `${JSON.stringify({ ...current, records: [...records, ...current.records] })}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      )
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
      await release()
    }
  }
}

function validateSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) throw new Error('Invalid session id')
}

/**
 * Splits the newest-first manifest records into undo steps (one side-effecting
 * tool execution each). New records share a `stepId` from a single commit;
 * legacy records without one fall back to their commit `createdAt`.
 */
function undoStepsOf(records: readonly BackupRecord[]): BackupRecord[][] {
  const steps: BackupRecord[][] = []
  let current: BackupRecord[] = []
  let key: string | undefined
  for (const record of records) {
    const recordKey = record.stepId ?? record.createdAt
    if (!current.length || recordKey === key) current.push(record)
    else {
      steps.push(current)
      current = [record]
    }
    key = recordKey
  }
  if (current.length) steps.push(current)
  return steps
}

function undoRecordKey(record: BackupRecord): string {
  return `${record.path}\0${record.createdAt}\0${record.stepId ?? ''}\0${record.beforeHash ?? ''}`
}

function assertWithin(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path))
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Backup manifest path escapes store')
}

async function directorySize(path: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name)
    total += entry.isDirectory() ? await directorySize(child) : (await stat(child)).size
  }
  return total
}

async function acquireFileLock(lockPath: string, owner: string): Promise<() => Promise<void>> {
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(`${process.pid} ${owner}\n`)
      return async () => {
        await handle.close()
        await rm(lockPath, { force: true })
      }
    } catch (error) {
      lastError = error
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (attempt === 3) throw new Error(`File lock unavailable: ${lockPath}`, { cause: error })
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
    }
  }
  throw new Error(`File lock unavailable: ${lockPath}`, { cause: lastError })
}
