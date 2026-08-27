import { readFile, stat } from 'node:fs/promises'

import { productIdentity, sanitize } from '@volund/shared'
import type {
  MemoryProvenance,
  MemoryRecord,
  MemoryRecordScope,
  MemoryService,
} from '@volund/storage'
import {
  compareMemoryRecords,
  MAX_MEMORY_ARCHIVE_BYTES,
  MemoryError,
  memoryCursorFor,
} from '@volund/storage'

import { projectMemoryScope, sessionMemoryScope, workspaceMemoryScope } from '../../memory-scope'
import type { VolundPorts } from '../../ports'
import type { CliIo, CliResult, CommandDefinition, ParsedCliArgs } from '../../shared/cli-types'

export const memoryUsage = `Usage: ${productIdentity.commandName} memory <command> [options]

Commands:
  list                 List memories
  get <id>             Get one memory
  add [content]        Add a memory
  update <id> [content] Update a memory
  delete <id>          Delete a memory (requires confirmation)
  pin <id>             Pin a memory for prompt injection
  unpin <id>           Stop injecting a pinned memory
  search <query>       Search the local memory index
  doctor               Check memory facts and index health
  reindex              Rebuild or check the local memory index
  export               Export a versioned local JSON archive to stdout
  import <path>        Import a local archive (or use --body-stdin)

Options:
  --scope workspace|project|both  Scope to access (search also supports session)
  --session-id <id>               Session id for a session-scoped search
  --tag <tag[,tag...]>            Filter or replace tags
  --source user|agent|evolution|import
  --pinned                         Filter or set pinned state
  --limit <1..500>                 Page size
  --cursor <cursor>                Continue a stable listing
  --content <text>                 Content for add or update
  --body-stdin                     Read content from stdin
  --expected-updated-at <time>     Optimistic concurrency token
  --yes                            Confirm deletion non-interactively
  --batch-size <number>            Records per reindex batch
  --check                          Check whether reindexing is required
  --force                          Force a full reindex
  --strategy skip|overwrite|rename Import conflict strategy (default: skip)
  --dry-run                        Validate import and report conflicts without writes
  --strict                         Fail doctor when memory is unhealthy
  --json                           Emit one versioned JSON document
  --no-color                       Disable color (memory text is always plain)
  --no-tui                         Disable interactive confirmation
`

type ScopeSelection = 'workspace' | 'project' | 'both'
type MemorySource = MemoryProvenance['source']
const sources = new Set<MemorySource>(['user', 'agent', 'evolution', 'import'])
const ansiEscape = String.fromCharCode(27)
const terminalBell = String.fromCharCode(7)
const ansiPattern = new RegExp(
  `${ansiEscape}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${terminalBell}]*(?:${terminalBell}|${ansiEscape}\\\\))`,
  'g',
)

export function createMemoryCommand(io: CliIo): CommandDefinition {
  return {
    name: 'memory',
    async run({ args, cwd, ports }) {
      try {
        const indexResult = await runIndexCommand(args, cwd, ports)
        if (indexResult) return indexResult
        if (!ports.memory)
          return failure(args, 2, 'memory_unavailable', 'memory port is not connected')
        return await runMemory(args, cwd, ports.memory, ports, io)
      } catch (error) {
        return memoryFailure(args, error)
      }
    },
  }
}

async function runIndexCommand(
  args: ParsedCliArgs,
  cwd: string,
  ports: VolundPorts,
): Promise<CliResult | undefined> {
  const action = args._[1]
  if (action === 'search') {
    if (!ports.memoryRecall)
      return indexFailure(
        'memory recall port is not connected',
        Boolean(args.json),
        2,
        'unavailable',
      )
    const query = args._.slice(2).join(' ').trim()
    if (!query)
      return indexFailure('memory search requires a query', Boolean(args.json), 2, 'invalid_usage')
    try {
      const scope = searchScope(args.scope, args.sessionId, cwd)
      const hits = await ports.memoryRecall.recall(scope, query, {
        limit: integerOption(args.limit, 10, 'limit'),
        tags: parseTags(args.tag) ?? [],
      })
      const result = { query, scope, hits }
      return {
        exitCode: 0,
        stdout: args.json
          ? `${JSON.stringify(result)}\n`
          : hits.length
            ? `${hits
                .map(
                  ({ record, score }) =>
                    `${record.id}\t${score.toFixed(3)}\t${oneLine(record.content)}`,
                )
                .join('\n')}\n`
            : 'No matching memories.\n',
        stderr: '',
      }
    } catch (error) {
      return indexFailure(error, Boolean(args.json))
    }
  }
  if (action === 'doctor') {
    if (!ports.memoryMaintenance)
      return indexFailure(
        'memory maintenance port is not connected',
        Boolean(args.json),
        2,
        'unavailable',
      )
    const report = await ports.memoryMaintenance.doctor()
    return {
      exitCode: args.strict && !report.healthy ? 1 : 0,
      stdout: args.json
        ? `${JSON.stringify(report)}\n`
        : `${report.facts.healthy ? '✓' : '✗'} facts: ${report.facts.detail} (${report.facts.records} records)\n${report.index.healthy ? '✓' : '✗'} index: ${report.index.detail} (${report.index.indexedRecords} records)\n`,
      stderr: '',
    }
  }
  if (action === 'reindex') {
    if (!ports.memoryMaintenance)
      return indexFailure(
        'memory maintenance port is not connected',
        Boolean(args.json),
        2,
        'unavailable',
      )
    try {
      const report = await ports.memoryMaintenance.reindex({
        batchSize: integerOption(args.batchSize, 250, 'batch-size'),
        check: Boolean(args.check),
        force: Boolean(args.force),
      })
      return {
        exitCode: args.check && !report.after.healthy ? 1 : 0,
        stdout: args.json
          ? `${JSON.stringify(report)}\n`
          : `${report.action}: ${report.after.status}; processed ${report.processedRecords} records in ${report.durationMs}ms\n`,
        stderr: '',
      }
    } catch (error) {
      return indexFailure(error, Boolean(args.json))
    }
  }
  return undefined
}

function searchScope(scope: unknown, sessionId: unknown, cwd: string): MemoryRecordScope {
  if (scope !== undefined && typeof scope !== 'string')
    throw new TypeError('--scope must be a string')
  const kind = scope ?? 'project'
  if (kind === 'workspace') return workspaceMemoryScope()
  if (kind === 'project') return projectMemoryScope(cwd)
  if (kind === 'session' && typeof sessionId === 'string' && sessionId)
    return sessionMemoryScope(cwd, sessionId)
  throw new TypeError(
    kind === 'session'
      ? '--scope session requires --session-id'
      : '--scope must be workspace, project, or session',
  )
}

function integerOption(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) throw new TypeError(`--${name} must be an integer`)
  return parsed
}

function oneLine(value: string): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized
}

function indexFailure(
  error: unknown,
  json: boolean,
  exitCode = 1,
  fallbackCode = 'memory_error',
): CliResult {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : fallbackCode
  return json
    ? {
        exitCode,
        stdout: `${JSON.stringify({ ok: false, error: { code, message } })}\n`,
        stderr: '',
      }
    : { exitCode, stdout: '', stderr: message }
}

async function runMemory(
  args: ParsedCliArgs,
  cwd: string,
  memory: MemoryService,
  ports: VolundPorts,
  io: CliIo,
): Promise<CliResult> {
  const action = args._[1] ?? 'list'
  const selection = parseScope(
    args.scope,
    action === 'add' || action === 'import' ? 'project' : 'both',
  )
  const scopes = scopesFor(selection, cwd)
  if (action === 'export') {
    if (!ports.memoryTransfer) throw new UsageError('memory transfer port is not connected')
    const document = await ports.memoryTransfer.export(scopes)
    return { exitCode: 0, stdout: ports.memoryTransfer.serialize(document), stderr: '' }
  }
  if (action === 'import') {
    if (!ports.memoryTransfer) throw new UsageError('memory transfer port is not connected')
    if (selection === 'both') throw new UsageError('memory import requires one target scope')
    const path = args._[2]
    if (!path && !args.bodyStdin)
      throw new UsageError('memory import requires a local path or --body-stdin')
    if (path && (await stat(path)).size > MAX_MEMORY_ARCHIVE_BYTES)
      throw new UsageError('memory import exceeds 16 MiB')
    const serialized = path ? await readFile(path, 'utf8') : await io.readStdin()
    const strategy = String(args.strategy ?? 'skip')
    if (!['skip', 'overwrite', 'rename'].includes(strategy))
      throw new UsageError('memory --strategy must be skip, overwrite, or rename')
    const report = await ports.memoryTransfer.import(serialized, scopes[0]!, {
      strategy: strategy as 'skip' | 'overwrite' | 'rename',
      dryRun: Boolean(args.dryRun),
      actorId: 'cli',
    })
    return success(
      args,
      report,
      `${report.dryRun ? 'Would import' : 'Imported'} ${report.applied}/${report.total} memories; ${report.conflicts.length} conflicts.\n`,
    )
  }
  if (action === 'list') {
    const limit = parseLimit(args.limit)
    const tags = parseTags(args.tag)
    const source = parseSource(args.source, false)
    const options = {
      limit,
      ...(args.cursor ? { cursor: String(args.cursor) } : {}),
      ...(args.pinned === undefined ? {} : { pinned: parseBoolean(args.pinned) }),
      ...(tags === undefined ? {} : { tags }),
      ...(source === undefined ? {} : { sources: [source] }),
    }
    const pages = await Promise.all(scopes.map((scope) => memory.listPage(scope, options)))
    const merged = pages.flatMap((page) => page.items).toSorted(compareMemoryRecords)
    const items = merged.slice(0, limit)
    const hasMore = merged.length > limit || pages.some((page) => page.nextCursor)
    const nextCursor = hasMore && items.length ? memoryCursorFor(items.at(-1)!) : undefined
    return success(
      args,
      { schemaVersion: 1, items: items.map(safeRecord), nextCursor: nextCursor ?? null },
      formatList(items, nextCursor),
    )
  }
  if (action === 'get') {
    const id = requireId(args, action)
    const record = await findRecord(memory, scopes, id)
    if (!record) return failure(args, 3, 'memory_not_found', `Memory ${id} was not found`)
    return success(args, { schemaVersion: 1, memory: safeRecord(record) }, formatRecord(record))
  }
  if (action === 'add') {
    if (selection === 'both') throw new UsageError('memory add requires one writable scope')
    const content = await readContent(args, io, 2)
    if (!content?.trim()) throw new UsageError('memory add requires content or --body-stdin')
    const source = parseSource(args.source, true) ?? 'user'
    const tags = parseTags(args.tag)
    const record = await memory.create({
      ...(args.id ? { id: String(args.id) } : {}),
      scope: scopes[0]!,
      content,
      provenance: { source, actorId: 'cli' },
      ...(tags === undefined ? {} : { tags }),
      ...(args.pinned === undefined ? {} : { pinned: parseBoolean(args.pinned) }),
    })
    return success(
      args,
      { schemaVersion: 1, memory: safeRecord(record) },
      `Added memory ${record.id}.\n`,
    )
  }
  if (action === 'update') {
    const id = requireId(args, action)
    const located = await requireLocated(memory, scopes, id)
    const content = await readContent(args, io, 3)
    const tags = parseTags(args.tag)
    const pinned = args.pinned === undefined ? undefined : parseBoolean(args.pinned)
    if (content === undefined && tags === undefined && pinned === undefined)
      throw new UsageError('memory update requires content, --tag, or --pinned')
    const record = await memory.update(
      located.scope,
      id,
      {
        ...(content === undefined ? {} : { content }),
        ...(tags === undefined ? {} : { tags }),
        ...(pinned === undefined ? {} : { pinned }),
      },
      mutationOptions(args),
    )
    return success(
      args,
      { schemaVersion: 1, memory: safeRecord(record) },
      `Updated memory ${id}.\n`,
    )
  }
  if (action === 'delete') {
    const id = requireId(args, action)
    const located = await requireLocated(memory, scopes, id)
    if (!parseBoolean(args.yes ?? false)) {
      const interactive = !args.json && !args.noTui && Boolean(io.isInteractiveTerminal?.())
      if (!interactive)
        return failure(
          args,
          2,
          'confirmation_required',
          'memory delete requires --yes outside an interactive terminal',
        )
      if (!(await io.confirm?.(`Delete memory ${id}?`)))
        return failure(args, 2, 'confirmation_declined', `Memory ${id} was not deleted`)
    }
    const record = await memory.delete(located.scope, id, mutationOptions(args))
    return success(
      args,
      { schemaVersion: 1, memory: safeRecord(record) },
      `Deleted memory ${id}.\n`,
    )
  }
  if (action === 'pin' || action === 'unpin') {
    const id = requireId(args, action)
    const located = await requireLocated(memory, scopes, id)
    const record = await memory[action](located.scope, id, mutationOptions(args))
    return success(
      args,
      { schemaVersion: 1, memory: safeRecord(record) },
      `${action === 'pin' ? 'Pinned' : 'Unpinned'} memory ${id}.\n`,
    )
  }
  throw new UsageError(`Unknown memory command: ${action}`)
}

function parseScope(value: unknown, fallback: ScopeSelection): ScopeSelection {
  if (value === undefined) return fallback
  const scope = String(value)
  if (scope === 'global') return 'workspace'
  if (scope === 'workspace' || scope === 'project' || scope === 'both') return scope
  throw new UsageError('memory --scope must be workspace, project, global, or both')
}

function scopesFor(selection: ScopeSelection, cwd: string): MemoryRecordScope[] {
  const project = projectMemoryScope(cwd)
  const workspace = workspaceMemoryScope()
  return selection === 'project'
    ? [project]
    : selection === 'workspace'
      ? [workspace]
      : [project, workspace]
}

function parseTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  const values = Array.isArray(value) ? value : [value]
  return [
    ...new Set(
      values
        .flatMap((item) => String(item).split(','))
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ]
}

function parseSource(value: unknown, writable: boolean): MemorySource | undefined {
  if (value === undefined) return undefined
  const source = String(value) as MemorySource
  if (!sources.has(source)) throw new UsageError('memory --source is invalid')
  if (writable && source !== 'user' && source !== 'import')
    throw new MemoryError('memory_scope_denied', 'CLI may only create user or import memories')
  return source
}

function parseLimit(value: unknown): number {
  if (value === undefined) return 100
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new UsageError('memory --limit must be an integer from 1 to 500')
  return limit
}

function parseBoolean(value: unknown): boolean {
  if (value === true || value === false) return value
  if (value === 'true') return true
  if (value === 'false') return false
  return Boolean(value)
}

function requireId(args: ParsedCliArgs, action: string): string {
  const id = args._[2]
  if (!id) throw new UsageError(`memory ${action} requires an id`)
  return id
}

async function readContent(
  args: ParsedCliArgs,
  io: CliIo,
  position: number,
): Promise<string | undefined> {
  if (args.bodyStdin) return io.readStdin()
  if (args.content !== undefined) return String(args.content)
  const positional = args._.slice(position).join(' ')
  return positional || undefined
}

async function findRecord(memory: MemoryService, scopes: readonly MemoryRecordScope[], id: string) {
  for (const scope of scopes) {
    const record = await memory.get(scope, id)
    if (record && !record.deletedAt) return record
  }
  return undefined
}

async function requireLocated(
  memory: MemoryService,
  scopes: readonly MemoryRecordScope[],
  id: string,
) {
  const record = await findRecord(memory, scopes, id)
  if (!record) throw new MemoryError('memory_not_found', `Memory ${id} was not found`)
  return record
}

function mutationOptions(args: ParsedCliArgs) {
  return args.expectedUpdatedAt ? { expectedUpdatedAt: String(args.expectedUpdatedAt) } : undefined
}

function safeRecord(record: MemoryRecord): MemoryRecord {
  return sanitize({ ...record, content: stripAnsi(record.content) })
}

function stripAnsi(value: string): string {
  return value.replace(ansiPattern, '')
}

function formatList(items: readonly MemoryRecord[], nextCursor?: string): string {
  if (!items.length) return 'No memories found.\n'
  const rows = items.map((record) => {
    const content = stripAnsi(sanitize(record.content)).replace(/\s+/g, ' ').trim().slice(0, 80)
    return `${record.id}\t${record.scope.kind}\t${record.pinned ? 'pinned' : '-'}\t${record.tags.join(',') || '-'}\t${content}`
  })
  if (nextCursor) rows.push(`next-cursor\t${nextCursor}`)
  return `${rows.join('\n')}\n`
}

function formatRecord(record: MemoryRecord): string {
  const value = safeRecord(record)
  return `---\nid: ${value.id}\nscope: ${value.scope.kind}\nsource: ${value.provenance.source}\ntags: [${value.tags.join(', ')}]\npinned: ${value.pinned}\ncreated: ${value.createdAt}\nupdated: ${value.updatedAt}\n---\n${value.content}\n`
}

function success(args: ParsedCliArgs, payload: unknown, text: string): CliResult {
  return { exitCode: 0, stdout: args.json ? `${JSON.stringify(payload)}\n` : text, stderr: '' }
}

function memoryFailure(args: ParsedCliArgs, error: unknown): CliResult {
  if (error instanceof UsageError) return failure(args, 2, 'memory_validation', error.message)
  if (error instanceof MemoryError) {
    const exitCode =
      error.code === 'memory_not_found' ? 3 : error.code === 'memory_scope_denied' ? 13 : 2
    return failure(args, exitCode, error.code, error.message)
  }
  return failure(args, 1, 'memory_internal', error instanceof Error ? error.message : String(error))
}

function failure(args: ParsedCliArgs, exitCode: number, code: string, message: string): CliResult {
  const safeMessage = stripAnsi(sanitize(message))
  return args.json
    ? {
        exitCode,
        stdout: `${JSON.stringify({ schemaVersion: 1, error: { code, message: safeMessage, exitCode } })}\n`,
        stderr: '',
      }
    : { exitCode, stdout: '', stderr: safeMessage }
}

class UsageError extends Error {}
