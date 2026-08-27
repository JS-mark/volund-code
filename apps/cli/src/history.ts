import { createReadStream, existsSync } from 'node:fs'
import { glob, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'

import { replaySessionState } from '@volund/core'
import type { SessionState } from '@volund/core'
import { SessionStore } from '@volund/storage'
import type { StoredEvent } from '@volund/storage'
import type { SessionCandidate } from '@volund/ui'

import type { HistoryMessage, HistoryPort, HistorySessionDetail, HistorySearchHit } from './ports'

/**
 * 与 runtime.ts 的 sessionIdPattern 同一约束：id 用于拼 sessions 目录下的文件
 * 路径，必须先校验，防路径穿越。
 */
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function messageFullText(content: SessionState['messages'][number]['content']): string {
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim()
}

function notFound(id: string): Error {
  return Object.assign(new Error(`Session not found: ${id}`), { code: 'session_not_found' })
}

/**
 * §11.3.4 `volund history` 的生产端口。会话档案是 ~/.volund/sessions/<id>.jsonl
 * 事件流（附录 D）；读取一律走事件 replay（与 resume / session.list 同一条
 * 派生链），不引入第二份解释逻辑。
 */
export function createHistoryPort(input: {
  sessionsDir: string
  listCandidates: () => Promise<readonly SessionCandidate[]>
}): HistoryPort {
  const pathFor = (id: string): string => {
    if (!sessionIdPattern.test(id))
      throw Object.assign(new Error(`Invalid session id: ${id}`), { code: 'session_id_invalid' })
    return join(input.sessionsDir, `${id}.jsonl`)
  }
  const loadSession = async (
    id: string,
  ): Promise<{ events: StoredEvent[]; detail: HistorySessionDetail }> => {
    const events = await new SessionStore(pathFor(id)).load()
    if (events.length === 0) throw notFound(id)
    const replay = replaySessionState(id, events, {
      maxTokens: 200_000,
      toolRegistrySnapshot: 'builtin:l1',
    })
    const messages: HistoryMessage[] = replay.state.messages.flatMap((message) => {
      const text = messageFullText(message.content)
      if (
        !text ||
        (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system')
      )
        return []
      return [{ role: message.role, text }]
    })
    const first = events[0]
    const last = events.at(-1)
    return {
      events,
      detail: {
        id,
        cwd: typeof replay.state.cwd === 'string' ? replay.state.cwd : '',
        ...(first ? { startedAt: first.at } : {}),
        updatedAt: last?.at ?? '',
        events: events.length,
        messages,
      },
    }
  }
  return {
    async list(options) {
      let candidates = await input.listCandidates()
      if (options.since)
        candidates = candidates.filter(
          (candidate) => Date.parse(candidate.updatedAt) >= options.since!.getTime(),
        )
      if (options.cwd) candidates = candidates.filter((candidate) => candidate.cwd === options.cwd)
      if (options.limit !== undefined) candidates = candidates.slice(0, options.limit)
      return candidates
    },
    async show(id) {
      return (await loadSession(id)).detail
    },
    async exportSession(id, format) {
      const { events, detail } = await loadSession(id)
      if (format === 'json')
        return `${JSON.stringify(
          { version: 1, sessionId: id, exportedAt: new Date().toISOString(), events },
          null,
          2,
        )}\n`
      const lines = [
        `# Session ${detail.id}`,
        '',
        `- cwd: ${detail.cwd}`,
        ...(detail.startedAt ? [`- started: ${detail.startedAt}`] : []),
        `- updated: ${detail.updatedAt}`,
      ]
      for (const message of detail.messages) {
        const role = message.role.charAt(0).toUpperCase() + message.role.slice(1)
        lines.push('', `## ${role}`, '', message.text)
      }
      return `${lines.join('\n')}\n`
    },
    async importSession(content) {
      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch {
        throw new Error('Invalid history export: not a JSON document')
      }
      const candidate = parsed as {
        version?: unknown
        sessionId?: unknown
        events?: unknown
      }
      if (
        candidate?.version !== 1 ||
        typeof candidate.sessionId !== 'string' ||
        !Array.isArray(candidate.events)
      )
        throw new Error('Invalid history export: expected {version: 1, sessionId, events[]}')
      const id = candidate.sessionId
      const file = pathFor(id)
      const events = candidate.events as Array<Record<string, unknown>>
      for (const event of events) {
        if (
          !event ||
          typeof event !== 'object' ||
          typeof event.v !== 'number' ||
          typeof event.id !== 'string' ||
          typeof event.type !== 'string' ||
          typeof event.sessionId !== 'string' ||
          typeof event.at !== 'string' ||
          !('payload' in event)
        )
          throw new Error('Invalid history export: malformed event entry')
      }
      if (existsSync(file)) throw new Error(`Session already exists: ${id}`)
      await mkdir(input.sessionsDir, { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      await writeFile(temporary, events.map((event) => JSON.stringify(event)).join('\n') + '\n', {
        encoding: 'utf8',
        mode: 0o600,
      })
      await rename(temporary, file)
      return { id, file }
    },
    async clear(options) {
      const removed: string[] = []
      for await (const path of glob(join(input.sessionsDir, '*.jsonl'))) {
        if (!options.all) {
          const info = await stat(path)
          if (!(info.mtimeMs < options.olderThan!.getTime())) continue
        }
        await rm(path, { force: true })
        removed.push(basename(path, '.jsonl'))
      }
      return { removed }
    },
    async search(query, options) {
      const needle = query.trim().toLowerCase()
      if (!needle) return []
      const limit = options?.limit ?? 20
      // 本地关键词匹配（不做 embedding / 网络请求），只命中消息文本——原始
      // 事件行里的 JSON 转义会把 snippet 弄得不可读。最近修改的 session 优先。
      const files: Array<{ path: string; mtimeMs: number }> = []
      for await (const path of glob(join(input.sessionsDir, '*.jsonl')))
        files.push({ path, mtimeMs: (await stat(path)).mtimeMs })
      files.sort((a, b) => b.mtimeMs - a.mtimeMs)
      const hits: HistorySearchHit[] = []
      for (const { path } of files) {
        const stream = createReadStream(path, 'utf8')
        const lines = createInterface({ input: stream })
        for await (const line of lines) {
          let event: { at?: unknown; payload?: unknown }
          try {
            event = JSON.parse(line)
          } catch {
            continue
          }
          const payload = event?.payload as
            | { content?: Array<{ type: string; text?: string }>; text?: unknown }
            | undefined
          const text = Array.isArray(payload?.content)
            ? payload.content
                .filter((part) => part.type === 'text' && typeof part.text === 'string')
                .map((part) => part.text!)
                .join(' ')
            : typeof payload?.text === 'string'
              ? payload.text
              : ''
          const index = text.toLowerCase().indexOf(needle)
          if (index === -1) continue
          const start = Math.max(0, index - 60)
          const snippet = text
            .slice(start, index + query.length + 60)
            .replace(/\s+/g, ' ')
            .trim()
          hits.push({
            sessionId: basename(path, '.jsonl'),
            snippet,
            ...(typeof event.at === 'string' ? { at: event.at } : {}),
          })
          if (hits.length >= limit) {
            lines.close()
            stream.destroy()
            return hits
          }
        }
      }
      return hits
    },
  }
}
