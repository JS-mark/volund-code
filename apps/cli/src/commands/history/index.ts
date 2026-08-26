import { readFile, writeFile } from 'node:fs/promises'

import type { CliIo, CliResult, CommandDefinition } from '../../shared/cli-types'

function failure(exitCode: number, message: string): CliResult {
  return { exitCode, stdout: '', stderr: message }
}

/**
 * §11.3.4 `apollo history`：session 会话档案（~/.apollo/sessions/*.jsonl）的
 * list/show/search/export/import/clear。与输入行历史（~/.apollo/history）无关。
 */
export function createHistoryCommand(io: CliIo): CommandDefinition {
  return {
    name: 'history',
    async run({ args, cwd, ports }) {
      const history = ports.history
      if (!history)
        return failure(2, 'history integration port is not connected')
      const action = args._[1] ?? 'list'
      try {
        if (action === 'list') {
          const limit = parseLimit(args.limit)
          if (args.limit !== undefined && limit === undefined)
            return failure(2, `Invalid --limit: ${String(args.limit)}`)
          const since = parseDate(args.since)
          if (args.since !== undefined && !since)
            return failure(2, `Invalid --since date: ${String(args.since)}`)
          const sessions = await history.list({
            ...(limit !== undefined ? { limit } : {}),
            ...(since ? { since } : {}),
            ...(args.project === true ? { cwd } : {}),
          })
          if (args.json) return { exitCode: 0, stdout: `${JSON.stringify(sessions)}\n`, stderr: '' }
          return {
            exitCode: 0,
            stdout: sessions.length
              ? `${sessions
                  .map(
                    (session) =>
                      `${session.id}\t${session.updatedAt}\t${session.cwd}\t${session.title}`,
                  )
                  .join('\n')}\n`
              : 'No sessions.\n',
            stderr: '',
          }
        }
        if (action === 'show') {
          const id = args._[2]
          if (!id) return failure(2, 'history show requires a session id')
          const detail = await history.show(id)
          if (args.json) return { exitCode: 0, stdout: `${JSON.stringify(detail)}\n`, stderr: '' }
          const lines = [
            `# Session ${detail.id}`,
            '',
            `cwd: ${detail.cwd}`,
            `updated: ${detail.updatedAt}`,
            `events: ${detail.events}`,
          ]
          for (const message of detail.messages)
            lines.push('', `${message.role}:`, '', message.text)
          return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
        }
        if (action === 'export') {
          const id = args._[2]
          if (!id) return failure(2, 'history export requires a session id')
          const content = await history.exportSession(id, args.json ? 'json' : 'markdown')
          const output = args.o ?? args.output
          if (output) {
            await writeFile(String(output), content, 'utf8')
            return { exitCode: 0, stdout: `Exported session ${id} to ${String(output)}\n`, stderr: '' }
          }
          return { exitCode: 0, stdout: content, stderr: '' }
        }
        if (action === 'import') {
          const file = args._[2]
          if (!file) return failure(2, 'history import requires a file')
          const imported = await history.importSession(await readFile(file, 'utf8'))
          return {
            exitCode: 0,
            stdout: args.json
              ? `${JSON.stringify(imported)}\n`
              : `Imported session ${imported.id}\n`,
            stderr: '',
          }
        }
        if (action === 'search') {
          const query = args._[2]
          if (!query) return failure(2, 'history search requires a query')
          const limit = parseLimit(args.limit)
          if (args.limit !== undefined && limit === undefined)
            return failure(2, `Invalid --limit: ${String(args.limit)}`)
          const hits = await history.search(query, limit !== undefined ? { limit } : undefined)
          if (args.json) return { exitCode: 0, stdout: `${JSON.stringify(hits)}\n`, stderr: '' }
          return {
            exitCode: 0,
            stdout: hits.length
              ? `${hits
                  .map((hit) => `${hit.sessionId}\t${hit.at ?? ''}\t${hit.snippet}`)
                  .join('\n')}\n`
              : 'No matches.\n',
            stderr: '',
          }
        }
        if (action === 'clear') {
          const all = args.all === true
          const olderThan = parseDate(args.olderThan)
          if (args.olderThan !== undefined && !olderThan)
            return failure(2, `Invalid --older-than date: ${String(args.olderThan)}`)
          if (all === (olderThan !== undefined))
            return failure(2, 'history clear requires exactly one of --all or --older-than <date>')
          // 与 memory delete 同一确认契约：非交互/--json/--no-tui 必须显式 --yes。
          if (args.yes !== true) {
            if (args.json || args.noTui || !io.isInteractiveTerminal?.() || !io.confirm)
              return failure(2, 'history clear requires --yes outside an interactive terminal')
            const scope = all ? 'ALL saved sessions' : `sessions older than ${olderThan!.toISOString()}`
            if (!(await io.confirm(`Delete ${scope}?`)))
              return failure(2, 'History was not cleared')
          }
          const { removed } = await history.clear({
            ...(all ? { all } : {}),
            ...(olderThan ? { olderThan } : {}),
          })
          return {
            exitCode: 0,
            stdout: args.json
              ? `${JSON.stringify({ removed })}\n`
              : `Removed ${removed.length} session(s).\n`,
            stderr: '',
          }
        }
        return failure(2, `Unknown history action: ${action}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code =
          error !== null && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : undefined
        return failure(code === 'session_not_found' ? 3 : 1, message)
      }
    },
  }
}

function parseLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 1000 ? parsed : undefined
}

function parseDate(value: unknown): Date | undefined {
  if (value === undefined) return undefined
  const parsed = new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}
