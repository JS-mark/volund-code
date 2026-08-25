import { randomUUID } from 'node:crypto'
import {
  open,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import type { PermissionManager, PermissionSpec } from '@apollo-code/permission'
import type { ContentPart } from '@apollo-code/provider-kit'
import type { DispatchParent, SubagentBudget, SubagentDispatcher } from '@apollo-code/subagent'
import type { Tool, ToolContext, ToolResult } from '@apollo-code/tool-kit'

import { WebSearchTool, type WebSearchProvider } from './web-search'
export * from './web-search'
import { WebFetchTool, type WebFetchOptions } from './web-fetch'
export { canonicalWebOrigin, isForbiddenAddress, WebFetchTool } from './web-fetch'
export type { WebFetchInput, WebFetchOptions } from './web-fetch'
export * from './bash-shell'
import { minimalEnv, quoteShellArgument, resolvePwshPath, selectShell } from './bash-shell'

const objectSchema = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'object', additionalProperties: false, properties, required }) as never
const stringProp = { type: 'string', minLength: 1 }
const result = (text: string, meta: NonNullable<ToolResult['meta']>): ToolResult => ({
  content: [{ type: 'text', text }],
  meta,
})
const failure = (error: unknown, started = Date.now()): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
  meta: { durationMs: Date.now() - started },
})
function pathInCwd(cwd: string, input: string): string {
  const path = resolve(cwd, input)
  const rel = relative(resolve(cwd), path)
  if (rel.startsWith('..')) throw new Error('Path escapes working directory')
  return path
}

export interface FileMutationTransaction {
  commit(): Promise<void>
  rollback(): Promise<void>
}

export interface FileBackupPort {
  prepare(sessionId: string, paths: string[]): Promise<FileMutationTransaction>
}

export interface BuiltinToolsOptions {
  backups?: FileBackupPort
  task?: { dispatcher: SubagentDispatcher; parent: (signal: AbortSignal) => DispatchParent }
  webSearch?: { provider?: WebSearchProvider }
  webFetch?: WebFetchOptions
  /** REM-57 (r13-I11): shell selection + env inheritance knobs ([tools] config). */
  bash?: BashToolOptions
}

async function safeMutationPath(cwd: string, input: string): Promise<string> {
  const path = pathInCwd(cwd, input)
  const root = await realpath(cwd)
  const parent = await realpath(resolve(path, '..'))
  const rel = relative(root, parent)
  if (rel.startsWith('..')) throw new Error('Path escapes working directory through a symlink')
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Refusing to mutate a symbolic link')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return path
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true })
  const temporary = resolve(path, '..', `.${randomUUID()}.apollo-tmp`)
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

interface FileSnapshot {
  mtimeMs: number
  size: number
}
async function snapshotOf(path: string): Promise<FileSnapshot> {
  const info = await stat(path)
  return { mtimeMs: info.mtimeMs, size: info.size }
}
function sameSnapshot(a: FileSnapshot, b: FileSnapshot): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}
const notFoundError = (path: string) =>
  `old_string not found in ${path} (file may have changed; re-Read)`
const ambiguousMatchError = (path: string, count: number) =>
  `old_string matches ${count} locations in ${path}; provide a longer context to disambiguate`
const noOpEditError = (path: string) =>
  `new_string equals old_string in ${path}; refusing no-op edit`
const changedSinceReadError = (path: string) =>
  `file ${path} changed since read (mtime or size mismatch); re-Read and retry`
const changedAfterWriteError = (path: string) =>
  `file ${path} changed after write (concurrent modification); edit rolled back, re-Read`

/**
 * Multiset line diff between two file contents: a line occurring m times before
 * and n times after contributes max(0, n-m) additions / max(0, m-n) removals.
 * O(n), deterministic, and never inflates full-file rewrites the way naive
 * old/new line counts would; pure line reordering counts as no change.
 */
export function diffLineCounts(
  before: string,
  after: string,
): { linesAdded: number; linesRemoved: number } {
  if (before === after) return { linesAdded: 0, linesRemoved: 0 }
  const counts = new Map<string, number>()
  for (const line of before.split('\n')) counts.set(line, (counts.get(line) ?? 0) - 1)
  for (const line of after.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1)
  let linesAdded = 0
  let linesRemoved = 0
  for (const delta of counts.values())
    if (delta > 0) linesAdded += delta
    else linesRemoved -= delta
  return { linesAdded, linesRemoved }
}

async function mutateFiles(
  sessionId: string,
  updates: Array<{ path: string; content: string; expect?: FileSnapshot }>,
  backups?: FileBackupPort,
): Promise<void> {
  const releases: Array<() => Promise<void>> = []
  const paths = [...new Set(updates.map((update) => update.path))].toSorted()
  let transaction: FileMutationTransaction | undefined
  try {
    for (const path of paths) releases.push(await acquireMutationLock(path, sessionId))
    transaction = backups
      ? await backups.prepare(sessionId, paths)
      : await prepareEphemeralTransaction(paths)
    for (const update of updates)
      if (update.expect && !sameSnapshot(update.expect, await snapshotOf(update.path)))
        throw new Error(changedSinceReadError(update.path))
    for (const update of updates) await atomicWrite(update.path, update.content)
    for (const update of updates)
      if ((await snapshotOf(update.path)).size !== Buffer.byteLength(update.content))
        throw new Error(changedAfterWriteError(update.path))
    await transaction?.commit()
  } catch (error) {
    await transaction?.rollback().catch(() => undefined)
    throw error
  } finally {
    for (const release of releases.toReversed()) await release()
  }
}

async function prepareEphemeralTransaction(paths: string[]): Promise<FileMutationTransaction> {
  const snapshots = await Promise.all(
    paths.map(async (path) => {
      try {
        return { path, content: await readFile(path), existed: true as const }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return { path, existed: false as const }
        throw error
      }
    }),
  )
  let settled = false
  return {
    async commit() {
      settled = true
    },
    async rollback() {
      if (settled) return
      for (const snapshot of snapshots.toReversed()) {
        if (snapshot.existed) await writeFile(snapshot.path, snapshot.content)
        else await rm(snapshot.path, { force: true })
      }
      settled = true
    },
  }
}

async function lockConflictMessage(lockPath: string): Promise<string> {
  const holder = await readFile(lockPath, 'utf8').catch(() => '')
  const pid = /^\s*(\d+)/.exec(holder)?.[1]
  return `file locked by another apollo session${pid ? ` (pid ${pid})` : ''}, retry later`
}

async function acquireMutationLock(path: string, sessionId: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.apollolock`
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(`${process.pid} ${sessionId}\n`)
      return async () => {
        await handle.close()
        await rm(lockPath, { force: true })
      }
    } catch (error) {
      lastError = error
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (attempt === 3) throw new Error(await lockConflictMessage(lockPath), { cause: lastError })
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000))
    }
  }
  throw new Error(await lockConflictMessage(lockPath), { cause: lastError })
}

export class ReadTool implements Tool<{ path: string; offset?: number; limit?: number }> {
  readonly name = 'Read'
  readonly description = 'Read a UTF-8 file'
  readonly readonly = true
  readonly parallelSafe = true
  readonly inputSchema = objectSchema(
    {
      path: stringProp,
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1 },
    },
    ['path'],
  )
  permissionSpec(input: { path: string }): PermissionSpec {
    return { fs: { read: [input.path] } }
  }
  async invoke(
    input: { path: string; offset?: number; limit?: number },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const started = Date.now()
    try {
      const text = await readFile(pathInCwd(ctx.session.cwd, input.path), 'utf8')
      const lines = text
        .split('\n')
        .slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 2000))
      return result(lines.join('\n'), {
        durationMs: Date.now() - started,
        bytesRead: Buffer.byteLength(text),
      })
    } catch (e) {
      return failure(e, started)
    }
  }
}
export class WriteTool implements Tool<{ path: string; content: string }> {
  constructor(readonly backups?: FileBackupPort) {}
  readonly name = 'Write'
  readonly description = 'Create or overwrite a file'
  readonly inputSchema = objectSchema({ path: stringProp, content: { type: 'string' } }, [
    'path',
    'content',
  ])
  readonly sandboxRequired = true
  permissionSpec(i: { path: string }): PermissionSpec {
    return { fs: { write: [i.path] } }
  }
  async invoke(i: { path: string; content: string }, c: ToolContext) {
    const s = Date.now()
    try {
      const p = await safeMutationPath(c.session.cwd, i.path)
      let before = ''
      try {
        before = await readFile(p, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await mutateFiles(c.session.id, [{ path: p, content: i.content }], this.backups)
      return result('File written', {
        durationMs: Date.now() - s,
        bytesWritten: Buffer.byteLength(i.content),
        filesTouched: [p],
        ...diffLineCounts(before, i.content),
      })
    } catch (e) {
      return failure(e, s)
    }
  }
}
export interface EditInput {
  path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}
export class EditTool implements Tool<EditInput> {
  constructor(readonly backups?: FileBackupPort) {}
  readonly name = 'Edit'
  readonly description = 'Replace one exact string in a file'
  readonly inputSchema = objectSchema(
    {
      path: stringProp,
      old_string: stringProp,
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    ['path', 'old_string', 'new_string'],
  )
  readonly sandboxRequired = true
  permissionSpec(i: { path: string }): PermissionSpec {
    return { fs: { read: [i.path], write: [i.path] } }
  }
  async invoke(i: EditInput, c: ToolContext) {
    const s = Date.now()
    try {
      if (i.new_string === i.old_string) throw new Error(noOpEditError(i.path))
      const p = await safeMutationPath(c.session.cwd, i.path),
        before = await snapshotOf(p),
        old = await readFile(p, 'utf8')
      if (!sameSnapshot(before, await snapshotOf(p))) throw new Error(changedSinceReadError(p))
      const count = old.split(i.old_string).length - 1
      if (count === 0) throw new Error(notFoundError(p))
      if (count > 1 && i.replace_all !== true) throw new Error(ambiguousMatchError(p, count))
      const next = i.replace_all
        ? old.split(i.old_string).join(i.new_string)
        : old.replace(i.old_string, i.new_string)
      await mutateFiles(c.session.id, [{ path: p, content: next, expect: before }], this.backups)
      return result('File edited', {
        durationMs: Date.now() - s,
        bytesWritten: Buffer.byteLength(next),
        filesTouched: [p],
        ...diffLineCounts(old, next),
      })
    } catch (e) {
      return failure(e, s)
    }
  }
}

export interface MultiEditInput {
  edits: Array<{ path: string; old_string: string; new_string: string }>
}

export class MultiEditTool implements Tool<MultiEditInput> {
  constructor(readonly backups?: FileBackupPort) {}
  readonly name = 'MultiEdit'
  readonly description = 'Atomically apply exact replacements across multiple files'
  readonly inputSchema = objectSchema(
    {
      edits: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'old_string', 'new_string'],
          properties: { path: stringProp, old_string: stringProp, new_string: { type: 'string' } },
        },
      },
    },
    ['edits'],
  )
  readonly sandboxRequired = true
  readonly parallelSafe = false
  permissionSpec(input: MultiEditInput): PermissionSpec {
    const paths = [...new Set(input.edits.map((edit) => edit.path))]
    return { fs: { read: paths, write: paths } }
  }
  async invoke(input: MultiEditInput, context: ToolContext): Promise<ToolResult> {
    const started = Date.now()
    try {
      const grouped = new Map<string, Array<{ old_string: string; new_string: string }>>()
      for (const edit of input.edits) {
        const path = await safeMutationPath(context.session.cwd, edit.path)
        grouped.set(path, [...(grouped.get(path) ?? []), edit])
      }
      const updates: Array<{ path: string; content: string; expect: FileSnapshot }> = []
      const beforeContents = new Map<string, string>()
      for (const [path, edits] of grouped) {
        const before = await snapshotOf(path)
        let content = await readFile(path, 'utf8')
        if (!sameSnapshot(before, await snapshotOf(path)))
          throw new Error(changedSinceReadError(path))
        beforeContents.set(path, content)
        for (const edit of edits) {
          if (edit.new_string === edit.old_string)
            throw new Error(noOpEditError(relative(context.session.cwd, path)))
          const count = content.split(edit.old_string).length - 1
          if (count === 0) throw new Error(notFoundError(relative(context.session.cwd, path)))
          if (count > 1)
            throw new Error(ambiguousMatchError(relative(context.session.cwd, path), count))
          content = content.replace(edit.old_string, edit.new_string)
        }
        updates.push({ path, content, expect: before })
      }
      await mutateFiles(context.session.id, updates, this.backups)
      let linesAdded = 0
      let linesRemoved = 0
      for (const update of updates) {
        const delta = diffLineCounts(beforeContents.get(update.path) ?? '', update.content)
        linesAdded += delta.linesAdded
        linesRemoved += delta.linesRemoved
      }
      return result(`Edited ${updates.length} file(s)`, {
        durationMs: Date.now() - started,
        bytesWritten: updates.reduce((sum, update) => sum + Buffer.byteLength(update.content), 0),
        filesTouched: updates.map((update) => update.path),
        linesAdded,
        linesRemoved,
      })
    } catch (error) {
      return failure(error, started)
    }
  }
}
export interface BashToolOptions {
  /** `[tools] windows_shell` — overrides PowerShell/cmd detection (win32 only). */
  windowsShell?: string
  /** `[tools] pass_through_env` — env names inherited beyond PATH/HOME/LANG/TZ. */
  passThroughEnv?: string[]
  /** Effective platform; defaults to `process.platform`. Injectable for tests. */
  platform?: string
}
export class BashTool implements Tool<{ command: string }> {
  constructor(readonly options: BashToolOptions = {}) {}
  readonly name = 'Bash'
  readonly description = 'Run a command in the Rust sandbox'
  readonly inputSchema = objectSchema({ command: stringProp }, ['command'])
  readonly sandboxRequired = true
  readonly parallelSafe = false
  permissionSpec(i: { command: string }): PermissionSpec {
    return { bash: { command: i.command }, fs: { read: ['.'], write: ['.'] } }
  }
  async invoke(i: { command: string }, c: ToolContext) {
    const s = Date.now()
    try {
      // REM-57 (spec §4.3.1, r13-I11): the shell is pinned per platform —
      // /bin/bash -c on Unix ($SHELL is never read), PowerShell 7+ else cmd on
      // Windows — and only the minimal env set (PATH/HOME/LANG/TZ +
      // pass_through_env) is inherited into the sandbox process.
      const platform = this.options.platform ?? process.platform
      const override = this.options.windowsShell?.trim()
      const pwshPath = platform === 'win32' && !override ? await resolvePwshPath() : undefined
      const shell = selectShell(platform, {
        ...(override ? { windowsShell: override } : {}),
        ...(pwshPath ? { pwshPath } : {}),
      })
      const env = minimalEnv(process.env, this.options.passThroughEnv)
      const out = await c.native.execute(
        shell.program,
        [...shell.args, quoteShellArgument(i.command, shell.quoting)],
        c.abortSignal,
        env,
      )
      return result(typeof out === 'string' ? out : JSON.stringify(out), {
        durationMs: Date.now() - s,
      })
    } catch (e) {
      return failure(e, s)
    }
  }
}
async function walk(root: string, base = root, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const p = resolve(root, entry.name)
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    if (entry.isDirectory()) await walk(p, base, out)
    else out.push(relative(base, p))
  }
  return out
}
export class GlobTool implements Tool<{ pattern: string; path?: string }> {
  readonly name = 'Glob'
  readonly description = 'Find files using a glob'
  readonly readonly = true
  readonly inputSchema = objectSchema({ pattern: stringProp, path: { type: 'string' } }, [
    'pattern',
  ])
  permissionSpec(i: { path?: string }): PermissionSpec {
    return { fs: { read: [i.path ?? '.'] } }
  }
  async invoke(i: { pattern: string; path?: string }, c: ToolContext) {
    const s = Date.now()
    try {
      const root = pathInCwd(c.session.cwd, i.path ?? '.'),
        escaped = i.pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '.*')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '.'),
        re = new RegExp(`^${escaped}$`),
        files = (await walk(root)).filter((x) => re.test(x))
      return result(files.join('\n'), { durationMs: Date.now() - s })
    } catch (e) {
      return failure(e, s)
    }
  }
}
export class GrepTool implements Tool<{ pattern: string; path?: string }> {
  readonly name = 'Grep'
  readonly description = 'Search text in files'
  readonly readonly = true
  readonly inputSchema = objectSchema({ pattern: stringProp, path: { type: 'string' } }, [
    'pattern',
  ])
  permissionSpec(i: { path?: string }): PermissionSpec {
    return { fs: { read: [i.path ?? '.'] } }
  }
  async invoke(i: { pattern: string; path?: string }, c: ToolContext) {
    const s = Date.now()
    try {
      const root = pathInCwd(c.session.cwd, i.path ?? '.'),
        re = new RegExp(i.pattern),
        matches: string[] = []
      for (const file of await walk(root)) {
        let text: string
        try {
          text = await readFile(resolve(root, file), 'utf8')
        } catch {
          continue
        }
        text.split('\n').forEach((line, n) => {
          if (re.test(line)) matches.push(`${file}:${n + 1}:${line}`)
        })
      }
      return result(matches.join('\n'), { durationMs: Date.now() - s })
    } catch (e) {
      return failure(e, s)
    }
  }
}
export class TodoTool implements Tool<{
  items: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' }>
}> {
  readonly name = 'Todo'
  readonly description = 'Replace the session todo list'
  readonly readonly = true
  readonly inputSchema = objectSchema(
    {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['text', 'status'],
          properties: { text: stringProp, status: { enum: ['pending', 'in_progress', 'done'] } },
        },
      },
    },
    ['items'],
  )
  permissionSpec(): PermissionSpec {
    return {}
  }
  async invoke(i: { items: Array<{ text: string; status: string }> }) {
    return result(JSON.stringify(i.items), { durationMs: 0 })
  }
}

export class TaskTool implements Tool<{
  prompt: string
  agentType?: string
  budget?: SubagentBudget
}> {
  readonly name = 'Task'
  readonly description = 'Run an isolated, depth-limited subagent and return its untrusted result'
  readonly parallelSafe = true
  readonly timeoutMs = 10 * 60_000
  readonly inputSchema = objectSchema(
    {
      prompt: stringProp,
      agentType: { type: 'string' },
      budget: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tokenMax: { type: 'integer', minimum: 1 },
          costUSDMax: { type: 'number', minimum: 0 },
          timeMsMax: { type: 'integer', minimum: 1 },
          toolCallMax: { type: 'integer', minimum: 1 },
        },
      },
    },
    ['prompt'],
  )
  constructor(
    readonly dispatcher: SubagentDispatcher,
    readonly parent: (signal: AbortSignal) => DispatchParent,
  ) {}
  permissionSpec(): PermissionSpec {
    return {}
  }
  async invoke(
    input: { prompt: string; agentType?: string; budget?: SubagentBudget },
    context: ToolContext,
  ) {
    const started = Date.now()
    try {
      const dispatched = await this.dispatcher.dispatch(this.parent(context.abortSignal), input)
      return {
        content: [{ type: 'text' as const, text: dispatched.text }],
        isError: dispatched.status === 'failed' || dispatched.status === 'cancelled',
        meta: { durationMs: Date.now() - started, costImpact: 'high' as const },
      }
    } catch (error) {
      return failure(error, started)
    }
  }
}

export const builtinTools = (options: BuiltinToolsOptions = {}): Tool[] => [
  new ReadTool(),
  new WriteTool(options.backups),
  new EditTool(options.backups),
  new MultiEditTool(options.backups),
  new BashTool(options.bash),
  new GrepTool(),
  new GlobTool(),
  new TodoTool(),
  new WebSearchTool(options.webSearch?.provider),
  new WebFetchTool(options.webFetch),
  ...(options.task ? [new TaskTool(options.task.dispatcher, options.task.parent)] : []),
]
function validate(schema: Record<string, unknown>, input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object'
  for (const key of (schema.required as string[]) ?? [])
    if (!(key in input)) return `missing required property: ${key}`
  if (schema.additionalProperties === false)
    for (const key of Object.keys(input))
      if (!Object.hasOwn(schema.properties as object, key)) return `unknown property: ${key}`
}
/**
 * Outcome of a preToolUse/postToolUse pipeline run (mirrors the plugin-sdk HookResult).
 * `veto` blocks the tool call; `value` carries the (possibly rewritten) payload.
 */
export interface ToolHookOutcome {
  veto?: boolean
  reason?: string
  value?: unknown
}
export type ToolHookEvent = 'preToolUse' | 'postToolUse'
export interface ToolHookDispatchCall {
  signal: AbortSignal
}
export type ToolHookDispatcher = (
  event: ToolHookEvent,
  payload: unknown,
  options: ToolHookDispatchCall,
) => Promise<ToolHookOutcome | undefined>

/** preToolUse payload; hooks may return `{ value: <payload with rewritten input> }`. */
export interface PreToolUseHookPayload {
  schemaVersion: 1
  tool: string
  toolUseId?: string
  turnId?: string
  input: unknown
}
/** postToolUse payload; hooks may return `{ value: <payload with rewritten result> }`. */
export interface PostToolUseHookPayload {
  schemaVersion: 1
  tool: string
  toolUseId?: string
  turnId?: string
  input: unknown
  result: { content: ContentPart[]; isError?: boolean }
}

const blockedByHook = (reason: string | undefined, meta: ToolResult['meta']): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: `blocked by hook: ${reason ?? 'unspecified reason'}` }],
  ...(meta === undefined ? {} : { meta }),
})
const adoptHookInput = (outcome: ToolHookOutcome | undefined, fallback: unknown): unknown => {
  const value = outcome?.value
  if (value && typeof value === 'object' && !Array.isArray(value) && 'input' in value)
    return (value as { input: unknown }).input
  return fallback
}
const adoptHookResult = (
  outcome: ToolHookOutcome | undefined,
): { content: ContentPart[]; isError?: boolean } | undefined => {
  const value = outcome?.value
  if (value && typeof value === 'object' && !Array.isArray(value) && 'result' in value) {
    const result = (value as { result?: unknown }).result
    if (
      result &&
      typeof result === 'object' &&
      Array.isArray((result as { content?: unknown }).content)
    ) {
      const isError = (result as { isError?: boolean }).isError
      return {
        content: (result as { content: ContentPart[] }).content,
        ...(isError === undefined ? {} : { isError }),
      }
    }
  }
  return undefined
}
export class ToolExecutor {
  constructor(
    readonly permissions: PermissionManager,
    readonly context: (signal: AbortSignal) => ToolContext,
    readonly dispatchHook?: ToolHookDispatcher,
  ) {}
  async execute(
    tool: Tool,
    input: unknown,
    signal: AbortSignal,
    toolUseId?: string,
  ): Promise<ToolResult> {
    const started = Date.now()
    const error = validate(tool.inputSchema, input)
    if (error) return failure(new Error(`Invalid input: ${error}`))
    const session = this.context(signal).session
    const hookContext = {
      schemaVersion: 1 as const,
      tool: tool.name,
      ...(toolUseId === undefined ? {} : { toolUseId }),
      ...(session.turnId ? { turnId: session.turnId } : {}),
    }
    // REM-52 (spec §2.5/§2.6): preToolUse pipeline runs before permission; a veto
    // blocks only this tool_use and never disturbs parallel tool calls.
    if (this.dispatchHook) {
      let outcome: ToolHookOutcome | undefined
      try {
        outcome = await this.dispatchHook(
          'preToolUse',
          { ...hookContext, input } satisfies PreToolUseHookPayload,
          { signal },
        )
      } catch (hookError) {
        return failure(hookError, started)
      }
      if (outcome?.veto) return blockedByHook(outcome.reason, { durationMs: Date.now() - started })
      const rewritten = adoptHookInput(outcome, input)
      if (rewritten !== input) {
        const invalid = validate(tool.inputSchema, rewritten)
        if (invalid)
          return failure(new Error(`Invalid input after preToolUse hook: ${invalid}`), started)
        input = rewritten
      }
    }
    let result: ToolResult
    try {
      result = await this.permissions.requestAndExecute(
        {
          toolName: tool.name,
          spec: tool.permissionSpec(input),
          input,
          session: { id: session.id, cwd: session.cwd },
          attempt: 1,
          // 附录 D.2 tool.permission_asked ★toolUseId：权限弹窗事件对齐 tool_use id。
          ...(toolUseId === undefined ? {} : { toolUseId }),
        },
        () => tool.invoke(input, this.context(signal)),
      )
    } catch (e) {
      result = failure(e)
    }
    // postToolUse observes both successful and failed results and may rewrite them.
    if (this.dispatchHook) {
      let outcome: ToolHookOutcome | undefined
      try {
        outcome = await this.dispatchHook(
          'postToolUse',
          {
            ...hookContext,
            input,
            result: {
              content: result.content,
              ...(result.isError === undefined ? {} : { isError: result.isError }),
            },
          } satisfies PostToolUseHookPayload,
          { signal },
        )
      } catch (hookError) {
        return failure(hookError, started)
      }
      if (outcome?.veto)
        return blockedByHook(outcome.reason, result.meta ?? { durationMs: Date.now() - started })
      const rewritten = adoptHookResult(outcome)
      if (rewritten)
        result = {
          content: rewritten.content,
          ...(rewritten.isError === undefined ? {} : { isError: rewritten.isError }),
          ...(result.meta === undefined ? {} : { meta: result.meta }),
        }
    }
    return result
  }
}

export function truncateToolResult(parts: ContentPart[], maxCharacters = 87_500): ContentPart[] {
  return parts.map((part) => {
    if (part.type !== 'text' || part.text.length <= maxCharacters) return part
    const half = Math.floor(maxCharacters / 2),
      removed = part.text.length - maxCharacters
    return {
      ...part,
      text: `${part.text.slice(0, half)}\n[... truncated approximately ${Math.ceil(removed / 3.5)} tokens ...]\n${part.text.slice(-half)}`,
    }
  })
}
