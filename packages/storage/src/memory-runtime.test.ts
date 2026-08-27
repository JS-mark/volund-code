import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DefaultMemoryService,
  LocalMemoryRepository,
  MemoryError,
  type MemoryRecord,
  type MemoryRecordScope,
  type MemoryRepository,
} from './memory-runtime'

const roots: string[] = []
const fixedNow = () => new Date(1_800_000_000_000)
const vitestExecutable = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
)
const workspace = { kind: 'workspace', workspaceId: 'ws' } as const
const project = { kind: 'project', workspaceId: 'ws', projectId: 'volund' } as const
const otherProject = { kind: 'project', workspaceId: 'ws', projectId: 'other' } as const
const session = {
  kind: 'session',
  workspaceId: 'ws',
  projectId: 'volund',
  sessionId: 'session-1',
} as const

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function snapshotPath() {
  const root = await mkdtemp(join(tmpdir(), 'volund-memory-runtime-'))
  roots.push(root)
  return join(root, 'memory', 'records.json')
}

function input(scope: MemoryRecordScope, content = 'Use pnpm') {
  return {
    scope,
    content,
    provenance: { source: 'user' as const, actorId: 'alice' },
    tags: [' tooling ', 'tooling'],
    pinned: true,
  }
}

describe('DefaultMemoryService', () => {
  it('freezes record metadata and keeps workspace, project, and session reads isolated', async () => {
    const service = new DefaultMemoryService(new LocalMemoryRepository(await snapshotPath()))
    await service.create({ ...input(workspace), id: 'workspace' })
    await service.create({ ...input(project), id: 'project' })
    await service.create({ ...input(session), id: 'session' })

    expect((await service.list(workspace)).map(({ id }) => id)).toEqual(['workspace'])
    expect((await service.list(project)).map(({ id }) => id)).toEqual(['project'])
    expect((await service.list(otherProject)).map(({ id }) => id)).toEqual([])
    expect((await service.list(session)).map(({ id }) => id)).toEqual(['session'])
    expect(await service.get(otherProject, 'project')).toBeUndefined()
    expect((await service.get(project, 'project'))?.tags).toEqual(['tooling'])
  })

  it('persists updates and soft deletes across a restart', async () => {
    const file = await snapshotPath()
    const first = new DefaultMemoryService(
      new LocalMemoryRepository(file),
      undefined,
      () => new Date(1),
    )
    await first.create({ ...input(project), id: 'preference' })
    await first.update(project, 'preference', { content: 'Use pnpm 11', pinned: false })
    await first.delete(project, 'preference')
    await first.flush()

    const restarted = new DefaultMemoryService(new LocalMemoryRepository(file))
    expect(await restarted.list(project)).toEqual([])
    expect(await restarted.list(project, { includeDeleted: true })).toMatchObject([
      { id: 'preference', content: 'Use pnpm 11', pinned: false, deletedAt: expect.any(String) },
    ])
  })

  it('rolls in-memory state back and returns a stable error after a disk failure', async () => {
    let fail = false
    const records: MemoryRecord[] = []
    const repository: MemoryRepository = {
      load: async () => records,
      save: async (next) => {
        if (fail) throw new Error('disk full')
        records.splice(0, records.length, ...next)
      },
      flush: async () => {},
    }
    const service = new DefaultMemoryService(repository)
    await service.create({ ...input(project), id: 'safe' })
    fail = true
    await expect(service.update(project, 'safe', { content: 'lost' })).rejects.toMatchObject({
      code: 'memory_io',
    })
    expect((await service.get(project, 'safe'))?.content).toBe('Use pnpm')
  })

  it('provides stable pagination, optimistic concurrency, and idempotent mutations', async () => {
    let tick = 0
    const service = new DefaultMemoryService(
      new LocalMemoryRepository(await snapshotPath()),
      undefined,
      () => new Date(tick++),
    )
    const one = await service.create({ ...input(project), id: 'one' })
    expect(await service.create({ ...input(project), id: 'one' })).toEqual(one)
    await service.create({ ...input(project), id: 'two' })
    const first = await service.listPage(project, { limit: 1 })
    expect(first.items.map(({ id }) => id)).toEqual(['two'])
    expect(first.nextCursor).toBeDefined()
    expect(
      (await service.listPage(project, { limit: 1, cursor: first.nextCursor! })).items,
    ).toMatchObject([{ id: 'one' }])

    await service.update(
      project,
      'one',
      { content: 'Use pnpm 11' },
      { expectedUpdatedAt: one.updatedAt },
    )
    await expect(
      service.update(project, 'one', { content: 'stale' }, { expectedUpdatedAt: one.updatedAt }),
    ).rejects.toMatchObject({ code: 'memory_conflict' })
    expect(await service.pin(project, 'one')).toMatchObject({ pinned: true })
    const unpinned = await service.unpin(project, 'one')
    expect(unpinned).toMatchObject({ pinned: false })
    expect(
      await service.delete(project, 'one', { expectedUpdatedAt: unpinned.updatedAt }),
    ).toMatchObject({
      deletedAt: expect.any(String),
    })
    expect(await service.delete(project, 'one')).toMatchObject({ deletedAt: expect.any(String) })
  })

  it('merges concurrent writes from separate service instances across scopes', async () => {
    const file = await snapshotPath()
    // LL-7: this hammer relies on the real cross-process file lock. Loaded
    // Windows runners need a retry budget wider than a single round (and
    // transient lock access errors retried) or the write fails as memory_io.
    // Production defaults stay 10s/10ms; only this test widens the budget.
    const repository = () =>
      new LocalMemoryRepository(file, { lockTimeoutMs: 30_000, lockRetryMs: 25 })
    for (let round = 0; round < 20; round++) {
      const first = new DefaultMemoryService(repository())
      const second = new DefaultMemoryService(repository())
      await Promise.all([first.start(), second.start()])

      await Promise.all([
        first.create({ ...input(project, `project-${round}`), id: `project-${round}` }),
        second.create({ ...input(otherProject, `other-${round}`), id: `other-${round}` }),
      ])
    }

    const records = await new LocalMemoryRepository(file).load()
    expect(records).toHaveLength(40)
    expect(new Set(records.map(({ id }) => id)).size).toBe(40)
  }, 30_000)

  it('returns memory_conflict when separate instances race on the same id', async () => {
    const file = await snapshotPath()
    const first = new DefaultMemoryService(new LocalMemoryRepository(file))
    const second = new DefaultMemoryService(new LocalMemoryRepository(file))
    await Promise.all([first.start(), second.start()])

    const results = await Promise.allSettled([
      first.create({ ...input(project, 'first value'), id: 'shared' }),
      second.create({ ...input(project, 'second value'), id: 'shared' }),
    ])

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(({ status }) => status === 'rejected')).toMatchObject([
      { reason: { code: 'memory_conflict' } },
    ])
    expect(await new LocalMemoryRepository(file).load()).toHaveLength(1)
  })

  it('checks optimistic concurrency against the lock-time snapshot', async () => {
    const file = await snapshotPath()
    const seed = new DefaultMemoryService(new LocalMemoryRepository(file), undefined, fixedNow)
    const original = await seed.create({ ...input(project, 'original'), id: 'shared' })
    const first = new DefaultMemoryService(new LocalMemoryRepository(file), undefined, fixedNow)
    const stale = new DefaultMemoryService(new LocalMemoryRepository(file), undefined, fixedNow)
    await Promise.all([first.start(), stale.start()])

    const current = await first.update(
      project,
      'shared',
      { content: 'current' },
      { expectedUpdatedAt: original.updatedAt },
    )
    expect(current.updatedAt).not.toBe(original.updatedAt)
    await expect(
      stale.update(
        project,
        'shared',
        { content: 'stale' },
        { expectedUpdatedAt: original.updatedAt },
      ),
    ).rejects.toMatchObject({ code: 'memory_conflict' })
    expect((await new LocalMemoryRepository(file).load())[0]?.content).toBe('current')
  })

  it('preserves writes from two real child processes', async () => {
    const file = await snapshotPath()
    const gate = `${file}.gate`
    await mkdir(dirname(file), { recursive: true })
    const helper = join(import.meta.dirname, 'memory-runtime.child.test.ts')
    const children = ['first', 'second'].map((id) =>
      runChild(helper, {
        VOLUND_MEMORY_CHILD_FILE: file,
        VOLUND_MEMORY_CHILD_GATE: gate,
        VOLUND_MEMORY_CHILD_ID: id,
      }),
    )
    const childrenDone = Promise.all(children)
    await Promise.race([
      Promise.all(['first', 'second'].map((id) => waitForFile(`${gate}.${id}.ready`))),
      childrenDone.then(() => {
        throw new Error('Memory child processes exited before reporting readiness')
      }),
    ])
    await writeFile(gate, 'go')
    await childrenDone

    expect((await new LocalMemoryRepository(file).load()).map(({ id }) => id).toSorted()).toEqual([
      'first',
      'second',
    ])
  }, 30_000)

  it('runs mandatory memory.preWrite before persistence and rejects secrets and invalid text', async () => {
    const seen: string[] = []
    const service = new DefaultMemoryService(
      new LocalMemoryRepository(await snapshotPath()),
      undefined,
      undefined,
      undefined,
      ({ content }) => {
        seen.push(content)
        if (content === 'blocked') throw new Error('policy veto')
      },
    )
    await expect(
      service.create({ ...input(project, 'blocked'), id: 'blocked' }),
    ).rejects.toMatchObject({
      code: 'memory_validation',
    })
    await expect(
      service.create({ ...input(project, 'api_key=sk-secret'), id: 'secret' }),
    ).rejects.toMatchObject({ code: 'memory_validation' })
    await expect(
      service.create({ ...input(project, '\ud800'), id: 'unicode' }),
    ).rejects.toMatchObject({
      code: 'memory_validation',
    })
    await expect(
      service.create({ ...input(project, '\ud800text'), id: 'unicode-prefix' }),
    ).rejects.toMatchObject({ code: 'memory_validation' })
    await expect(
      service.create({ ...input(project, 'valid \ud83d\ude80'), id: 'valid-unicode' }),
    ).resolves.toMatchObject({ content: 'valid \ud83d\ude80' })
    expect(seen).toEqual(['blocked', 'valid \ud83d\ude80'])
    expect(await service.list(project)).toMatchObject([{ id: 'valid-unicode' }])
  })

  it('rejects provider credentials on create and update without changing facts', async () => {
    const file = await snapshotPath()
    const service = new DefaultMemoryService(new LocalMemoryRepository(file))
    const before = await service.create({ ...input(project, 'safe original'), id: 'original' })
    const corpus = [
      `sk-proj-${'FAKE'.repeat(6)}`,
      `ghp_${'FAKE'.repeat(8)}`,
      `AKIA${'FAKE'.repeat(4)}`,
      `eyJ${'F'.repeat(8)}.${'A'.repeat(12)}.${'K'.repeat(12)}`,
      `Authorization: Bearer ${'FAKE'.repeat(4)}`,
      `redis://volund:${'FAKE'.repeat(3)}@cache.example.test/0`,
    ]

    for (const [index, content] of corpus.entries()) {
      await expect(
        service.create({ ...input(project, content), id: `rejected-${index}` }),
      ).rejects.toMatchObject({ code: 'memory_validation' })
      await expect(service.update(project, 'original', { content })).rejects.toMatchObject({
        code: 'memory_validation',
      })
    }

    expect(await service.get(project, 'original')).toEqual(before)
    expect((await service.list(project)).map(({ id }) => id)).toEqual(['original'])
    const persisted = await readFile(file, 'utf8')
    for (const content of corpus) expect(persisted).not.toContain(content)
  })

  it('tracks attachment invalidation and deletion as tombstones without embedding bytes', async () => {
    const service = new DefaultMemoryService(new LocalMemoryRepository(await snapshotPath()))
    const attachment = {
      schemaVersion: 1 as const,
      id: 'diagram',
      handle: `${'a'.repeat(64)}.png`,
      mime: 'image/png',
      size: 42,
      digest: 'a'.repeat(64),
      state: 'active' as const,
      createdAt: '2026-08-12T00:00:00.000Z',
      invalidatedAt: null,
      deletedAt: null,
    }
    await service.create({ ...input(project), id: 'with-attachment', attachments: [attachment] })
    await expect(
      service.invalidateAttachment(project, 'with-attachment', 'diagram'),
    ).resolves.toMatchObject({ attachments: [{ state: 'invalidated', deletedAt: null }] })
    await expect(
      service.deleteAttachment(project, 'with-attachment', 'diagram'),
    ).resolves.toMatchObject({
      attachments: [
        { state: 'deleted', invalidatedAt: expect.any(String), deletedAt: expect.any(String) },
      ],
    })
  })
})

describe('LocalMemoryRepository contract', () => {
  it('recovers a lock left behind by a crashed process', async () => {
    const file = await snapshotPath()
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(
      `${file}.lock`,
      JSON.stringify({ pid: 2_147_483_647, token: 'crashed', at: '2000-01-01T00:00:00.000Z' }),
    )

    const service = new DefaultMemoryService(new LocalMemoryRepository(file))
    await expect(service.create({ ...input(project), id: 'recovered' })).resolves.toMatchObject({
      id: 'recovered',
    })
    await expect(access(`${file}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recovers the last durable snapshot after a corrupt primary', async () => {
    const file = await snapshotPath()
    const service = new DefaultMemoryService(new LocalMemoryRepository(file))
    await service.create({ ...input(project), id: 'one' })
    await service.create({ ...input(project), id: 'two' })
    await writeFile(file, '{interrupted', 'utf8')

    const recovered = new DefaultMemoryService(new LocalMemoryRepository(file))
    expect((await recovered.list(project)).map(({ id }) => id)).toEqual(['one'])
  })

  it('does not replace the existing snapshot when interrupted before rename', async () => {
    const file = await snapshotPath()
    const service = new DefaultMemoryService(new LocalMemoryRepository(file))
    await service.create({ ...input(project), id: 'safe' })
    const interrupted = new DefaultMemoryService(
      new LocalMemoryRepository(file, {
        beforeRename: () => {
          throw new Error('simulated interruption')
        },
      }),
    )
    await expect(interrupted.create({ ...input(project), id: 'unsafe' })).rejects.toBeInstanceOf(
      MemoryError,
    )
    expect(JSON.parse(await readFile(file, 'utf8')).records).toMatchObject([{ id: 'safe' }])
  })

  it('rejects unsupported schemas with a stable corruption error', async () => {
    const file = await snapshotPath()
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, JSON.stringify({ schemaVersion: 999, records: [] }), 'utf8')
    await expect(new LocalMemoryRepository(file).load()).rejects.toMatchObject({
      code: 'memory_corrupt',
    })
  })
})

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      await access(path)
      return
    } catch {
      await delay(10)
    }
  }
  throw new Error(`Timed out waiting for child process readiness: ${path}`)
}

function runChild(helper: string, environment: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [vitestExecutable, 'run', helper, '--pool=forks', '--maxWorkers=1', '--no-file-parallelism'],
      {
        cwd: join(import.meta.dirname, '../../..'),
        env: { ...process.env, ...environment },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let output = ''
    child.stdout.on('data', (chunk) => (output += String(chunk)))
    child.stderr.on('data', (chunk) => (output += String(chunk)))
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Memory child process exited with ${String(code)}:\n${output}`))
    })
  })
}
