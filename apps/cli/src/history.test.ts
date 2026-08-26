import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SessionCandidate } from '@apollo-code/ui'

import { createHistoryPort } from './history'

const fixtures: string[] = []
afterEach(async () =>
  Promise.all(fixtures.map((path) => rm(path, { force: true, recursive: true }))),
)

const sessionA = '018f2d3a-0000-7000-8000-00000000000a'
const sessionB = '018f2d3a-0000-7000-8000-00000000000b'

function event(
  id: string,
  sessionId: string,
  type: string,
  at: string,
  payload: unknown,
): string {
  return JSON.stringify({ v: 1, id, type, sessionId, at, payload })
}

async function seedSession(
  dir: string,
  id: string,
  options: { cwd?: string; messages?: Array<[string, string]> } = {},
): Promise<void> {
  const lines = [
    event(`${id}-started`, id, 'session.started', '2026-08-01T10:00:00.000Z', {
      cwd: options.cwd ?? '/work/project-a',
    }),
  ]
  let index = 0
  for (const [role, text] of options.messages ?? []) {
    index += 1
    lines.push(
      event(`${id}-msg-${index}`, id, 'message.appended', `2026-08-01T10:0${index}:00.000Z`, {
        messageId: `${role}-${index}`,
        role,
        content: [{ type: 'text', text }],
      }),
    )
  }
  await writeFile(join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`, 'utf8')
}

function historyPort(
  dir: string,
  listCandidates: () => Promise<readonly SessionCandidate[]> = async () => [],
) {
  return createHistoryPort({ sessionsDir: dir, listCandidates })
}

describe('createHistoryPort', () => {
  it('shows a session conversation via event replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-history-'))
    fixtures.push(root)
    await seedSession(root, sessionA, {
      messages: [
        ['user', 'fix the flaky test'],
        ['assistant', 'Looking at the test now.'],
      ],
    })
    const detail = await historyPort(root).show(sessionA)
    expect(detail).toMatchObject({ id: sessionA, cwd: '/work/project-a', events: 3 })
    expect(detail.messages).toEqual([
      { role: 'user', text: 'fix the flaky test' },
      { role: 'assistant', text: 'Looking at the test now.' },
    ])
    await expect(historyPort(root).show(sessionB)).rejects.toMatchObject({
      code: 'session_not_found',
    })
    await expect(historyPort(root).show('../../etc/passwd')).rejects.toMatchObject({
      code: 'session_id_invalid',
    })
  })

  it('exports markdown and JSON, and imports a JSON export back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-history-'))
    fixtures.push(root)
    await seedSession(root, sessionA, { messages: [['user', 'hello world']] })
    const port = historyPort(root)

    const markdown = await port.exportSession(sessionA, 'markdown')
    expect(markdown).toContain(`# Session ${sessionA}`)
    expect(markdown).toContain('## User')
    expect(markdown).toContain('hello world')

    const json = await port.exportSession(sessionA, 'json')
    const parsed = JSON.parse(json)
    expect(parsed.version).toBe(1)
    expect(parsed.events).toHaveLength(2)

    await rm(join(root, `${sessionA}.jsonl`))
    await expect(port.importSession(json)).resolves.toMatchObject({ id: sessionA })
    await expect(port.importSession(json)).rejects.toThrow(/already exists/)
    await expect(port.importSession('not json')).rejects.toThrow(/not a JSON document/)
    await expect(port.importSession('{"version":2}')).rejects.toThrow(/expected/)

    const restored = await port.show(sessionA)
    expect(restored.messages).toEqual([{ role: 'user', text: 'hello world' }])
  })

  it('searches message text locally, most-recent session first, honoring the limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-history-'))
    fixtures.push(root)
    await seedSession(root, sessionA, { messages: [['user', 'Rename the Foobar widget']] })
    await seedSession(root, sessionB, {
      messages: [['assistant', 'The foobar module is unchanged.']],
    })
    // B 更新，应排在前面
    const past = new Date('2026-08-01T10:00:00.000Z')
    await utimes(join(root, `${sessionA}.jsonl`), past, past)

    const port = historyPort(root)
    const hits = await port.search('FOOBAR')
    expect(hits).toHaveLength(2)
    expect(hits[0]!.sessionId).toBe(sessionB)
    expect(hits[0]!.snippet).toContain('foobar')
    const limited = await port.search('foobar', { limit: 1 })
    expect(limited).toHaveLength(1)
    await expect(port.search('absent-term')).resolves.toEqual([])
  })

  it('clears sessions by --all or --older-than', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-history-'))
    fixtures.push(root)
    await seedSession(root, sessionA)
    await seedSession(root, sessionB)
    const old = new Date('2020-01-01T00:00:00.000Z')
    await utimes(join(root, `${sessionA}.jsonl`), old, old)

    const port = historyPort(root)
    const partial = await port.clear({ olderThan: new Date('2021-01-01T00:00:00.000Z') })
    expect(partial.removed).toEqual([sessionA])
    const rest = await port.clear({ all: true })
    expect(rest.removed).toEqual([sessionB])
  })

  it('lists candidates with since/cwd/limit filters', async () => {
    const candidates = [
      { id: sessionA, cwd: '/work/a', updatedAt: '2026-08-10T00:00:00.000Z', title: 'a' },
      { id: sessionB, cwd: '/work/b', updatedAt: '2026-08-20T00:00:00.000Z', title: 'b' },
    ]
    const port = historyPort(join(tmpdir(), 'unused'), async () => candidates)
    await expect(port.list({})).resolves.toHaveLength(2)
    await expect(port.list({ since: new Date('2026-08-15') })).resolves.toEqual([candidates[1]])
    await expect(port.list({ cwd: '/work/a' })).resolves.toEqual([candidates[0]])
    await expect(port.list({ limit: 1 })).resolves.toEqual([candidates[0]])
  })
})
