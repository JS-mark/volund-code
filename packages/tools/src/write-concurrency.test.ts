import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { EditTool, ReadTool, WriteTool, contentHash, sessionReadHash } from './index'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function fixture() {
  const cwd = await mkdtemp(resolve(tmpdir(), 'volund-write-'))
  dirs.push(cwd)
  return cwd
}
function context(cwd: string, sessionId = 'session-1') {
  return {
    abortSignal: new AbortController().signal,
    session: { id: sessionId, cwd, turnId: 'turn-1' },
    native: { execute: async () => '' },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ui: { requestInput: async () => '' },
  }
}
const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((part) => part.text ?? '').join('')

/** A pid guaranteed to be dead: spawn a child, wait for it to exit. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise<void>((done) => child.on('exit', () => done()))
  if (child.pid === undefined) throw new Error('failed to spawn throwaway process')
  return child.pid
}
async function ageLock(lockPath: string, ageMs = 120_000) {
  const past = new Date(Date.now() - ageMs)
  await utimes(lockPath, past, past)
}

describe('Write cross-agent contract (spec §4.3.4, SAG-05)', () => {
  it('schema: path/content required, expect/force optional, no unknown fields', () => {
    const schema = new WriteTool().inputSchema as unknown as Record<string, unknown>
    expect(schema.required).toEqual(['path', 'content'])
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties as object)).toStrictEqual([
      'path',
      'content',
      'expect',
      'force',
    ])
  })

  it('creates a new path without any read record (creation is always allowed)', async () => {
    const cwd = await fixture()
    const result = await new WriteTool().invoke(
      { path: 'fresh.txt', content: 'brand new' },
      context(cwd),
    )
    expect(result.isError).toBeUndefined()
    expect(await readFile(resolve(cwd, 'fresh.txt'), 'utf8')).toBe('brand new')
  })

  it('rejects overwriting an existing path with no prior read in this session', async () => {
    const cwd = await fixture()
    await writeFile(resolve(cwd, 'existing.txt'), 'foreign data')
    const result = await new WriteTool().invoke(
      { path: 'existing.txt', content: 'mine' },
      context(cwd),
    )
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('changed-since-read')
    expect(textOf(result)).toContain('Read it first')
    expect(await readFile(resolve(cwd, 'existing.txt'), 'utf8')).toBe('foreign data')
  })

  it('Read then Write succeeds: expect defaults to the session last-read hash', async () => {
    const cwd = await fixture()
    await writeFile(resolve(cwd, 'tracked.txt'), 'v1\n')
    await new ReadTool().invoke({ path: 'tracked.txt' }, context(cwd))
    const result = await new WriteTool().invoke(
      { path: 'tracked.txt', content: 'v2\n' },
      context(cwd),
    )
    expect(result.isError).toBeUndefined()
    expect(await readFile(resolve(cwd, 'tracked.txt'), 'utf8')).toBe('v2\n')
  })

  it('partial Read (offset/limit) tracks the full-file hash', async () => {
    const cwd = await fixture()
    await writeFile(resolve(cwd, 'long.txt'), 'l1\nl2\nl3\n')
    const read = await new ReadTool().invoke({ path: 'long.txt', limit: 1 }, context(cwd))
    expect(read.isError).toBeUndefined()
    expect(textOf(read)).toBe('l1')
    expect(sessionReadHash('session-1', resolve(cwd, 'long.txt'))).toBe(contentHash('l1\nl2\nl3\n'))
    const result = await new WriteTool().invoke(
      { path: 'long.txt', content: 'rewritten\n' },
      context(cwd),
    )
    expect(result.isError).toBeUndefined()
  })

  it('rejects when the file changed since the session last read it', async () => {
    const cwd = await fixture()
    await writeFile(resolve(cwd, 'drifted.txt'), 'v1')
    await new ReadTool().invoke({ path: 'drifted.txt' }, context(cwd))
    await writeFile(resolve(cwd, 'drifted.txt'), 'v2-foreign')
    const result = await new WriteTool().invoke(
      { path: 'drifted.txt', content: 'mine' },
      context(cwd),
    )
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('changed-since-read')
    expect(textOf(result)).toContain('re-Read')
    expect(await readFile(resolve(cwd, 'drifted.txt'), 'utf8')).toBe('v2-foreign')
  })

  it('explicit expect mismatch → changed-since-read; matching expect → written', async () => {
    const cwd = await fixture()
    const target = resolve(cwd, 'expect.txt')
    await writeFile(target, 'v1')
    await new ReadTool().invoke({ path: 'expect.txt' }, context(cwd))
    const lastRead = sessionReadHash('session-1', target)
    expect(lastRead).toBe(contentHash('v1'))

    await writeFile(target, 'v2-foreign')
    const stale = await new WriteTool().invoke(
      { path: 'expect.txt', content: 'mine', ...(lastRead ? { expect: lastRead } : {}) },
      context(cwd),
    )
    expect(stale.isError).toBe(true)
    expect(textOf(stale)).toContain('changed-since-read')
    expect(await readFile(target, 'utf8')).toBe('v2-foreign')

    const current = await new WriteTool().invoke(
      { path: 'expect.txt', content: 'mine', expect: contentHash('v2-foreign') },
      context(cwd),
    )
    expect(current.isError).toBeUndefined()
    expect(await readFile(target, 'utf8')).toBe('mine')
  })

  it('explicit expect beats the session last-read hash', async () => {
    const cwd = await fixture()
    const target = resolve(cwd, 'pinned.txt')
    await writeFile(target, 'v1')
    await new ReadTool().invoke({ path: 'pinned.txt' }, context(cwd))
    await writeFile(target, 'v2-foreign')
    // session last-read is stale, but the caller pins the CURRENT hash → allowed
    const result = await new WriteTool().invoke(
      { path: 'pinned.txt', content: 'mine', expect: contentHash('v2-foreign') },
      context(cwd),
    )
    expect(result.isError).toBeUndefined()
    expect(await readFile(target, 'utf8')).toBe('mine')
  })

  it('force: true bypasses the gate and flags the lost update in the result', async () => {
    const cwd = await fixture()
    await writeFile(resolve(cwd, 'forced.txt'), 'foreign data')
    const result = await new WriteTool().invoke(
      { path: 'forced.txt', content: 'mine', force: true },
      context(cwd),
    )
    expect(result.isError).toBeUndefined()
    expect(textOf(result)).toContain('lost-update')
    expect(await readFile(resolve(cwd, 'forced.txt'), 'utf8')).toBe('mine')
  })

  it('a successful write refreshes the session read record (Write → Write without re-Read)', async () => {
    const cwd = await fixture()
    const tool = new WriteTool()
    const first = await tool.invoke({ path: 'chain.txt', content: 'one' }, context(cwd))
    expect(first.isError).toBeUndefined()
    const second = await tool.invoke({ path: 'chain.txt', content: 'two' }, context(cwd))
    expect(second.isError).toBeUndefined()
    expect(await readFile(resolve(cwd, 'chain.txt'), 'utf8')).toBe('two')
  })

  it('Edit refreshes the session read record (Read → Edit → Write without re-Read)', async () => {
    const cwd = await fixture()
    await writeFile(resolve(cwd, 'edited.txt'), 'alpha beta')
    await new ReadTool().invoke({ path: 'edited.txt' }, context(cwd))
    const edit = await new EditTool().invoke(
      { path: 'edited.txt', old_string: 'beta', new_string: 'gamma' },
      context(cwd),
    )
    expect(edit.isError).toBeUndefined()
    const overwrite = await new WriteTool().invoke(
      { path: 'edited.txt', content: 'full rewrite' },
      context(cwd),
    )
    expect(overwrite.isError).toBeUndefined()
    expect(await readFile(resolve(cwd, 'edited.txt'), 'utf8')).toBe('full rewrite')
  })

  it('post-lock gate: two agents racing to create the same path — exactly one wins', async () => {
    const cwd = await fixture()
    const target = resolve(cwd, 'race.txt')
    const [a, b] = await Promise.all([
      new WriteTool().invoke({ path: 'race.txt', content: 'agent-A' }, context(cwd, 'session-A')),
      new WriteTool().invoke({ path: 'race.txt', content: 'agent-B' }, context(cwd, 'session-B')),
    ])
    const winners = [a, b].filter((r) => !r.isError)
    const losers = [a, b].filter((r) => r.isError)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    // the loser serialized behind the lock, saw the path existing with no read
    // record in ITS session → changed-since-read (no silent double-create)
    expect(textOf(losers[0]!)).toContain('changed-since-read')
    expect(await readFile(target, 'utf8')).toBe(winners[0] === a ? 'agent-A' : 'agent-B')
  }, 10_000)

  it('read-tracking is session-scoped: a read in session A does not authorize session B', async () => {
    const cwd = await fixture()
    await writeFile(resolve(cwd, 'scoped.txt'), 'data')
    await new ReadTool().invoke({ path: 'scoped.txt' }, context(cwd, 'session-A'))
    const result = await new WriteTool().invoke(
      { path: 'scoped.txt', content: 'mine' },
      context(cwd, 'session-B'),
    )
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('changed-since-read')
    expect(await readFile(resolve(cwd, 'scoped.txt'), 'utf8')).toBe('data')
  })
})

describe('stale .volundlock reaping (spec §4.3.4, SAG-05)', () => {
  it('reaps a lock whose holder pid is dead AND older than the threshold', async () => {
    const cwd = await fixture()
    const pid = await deadPid()
    const lockPath = resolve(cwd, 'orphaned.txt.volundlock')
    await writeFile(lockPath, `${pid} dead-session\n`)
    await ageLock(lockPath)
    const result = await new WriteTool().invoke(
      { path: 'orphaned.txt', content: 'recovered' },
      context(cwd),
    )
    expect(result.isError).toBeUndefined()
    expect(await readFile(resolve(cwd, 'orphaned.txt'), 'utf8')).toBe('recovered')
  }, 10_000)

  it('never reaps a lock held by a live pid, however old', async () => {
    const cwd = await fixture()
    const lockPath = resolve(cwd, 'held.txt.volundlock')
    await writeFile(lockPath, `${process.pid} live-session\n`)
    await ageLock(lockPath)
    const result = await new WriteTool().invoke({ path: 'held.txt', content: 'x' }, context(cwd))
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('file locked by another volund session')
    // the live holder's lock file is untouched
    expect(await readFile(lockPath, 'utf8')).toBe(`${process.pid} live-session\n`)
  }, 10_000)

  it('does not reap a fresh lock even when the holder pid is dead', async () => {
    const cwd = await fixture()
    const pid = await deadPid()
    await writeFile(resolve(cwd, 'fresh.txt.volundlock'), `${pid} dead-session\n`)
    const result = await new WriteTool().invoke({ path: 'fresh.txt', content: 'x' }, context(cwd))
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('file locked by another volund session')
  }, 10_000)

  it('never reaps a lock file without a parseable pid', async () => {
    const cwd = await fixture()
    const lockPath = resolve(cwd, 'garbled.txt.volundlock')
    await writeFile(lockPath, 'other-session')
    await ageLock(lockPath)
    const result = await new WriteTool().invoke({ path: 'garbled.txt', content: 'x' }, context(cwd))
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('file locked by another volund session')
  }, 10_000)
})
