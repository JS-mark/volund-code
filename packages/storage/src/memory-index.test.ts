import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DefaultMemoryMaintenanceService,
  DefaultMemoryRecallService,
  IndexingMemoryService,
  LocalKeywordMemoryIndex,
} from './memory-index'
import {
  DefaultMemoryService,
  HierarchicalMemoryPolicy,
  LocalMemoryRepository,
  MemoryError,
  type MemoryRecord,
  type MemoryRecordScope,
} from './memory-runtime'

const roots: string[] = []
const projectScope: MemoryRecordScope = {
  kind: 'project',
  workspaceId: 'local',
  projectId: 'project-a',
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'volund-memory-index-'))
  roots.push(root)
  const repository = new LocalMemoryRepository(join(root, 'records.json'))
  let tick = 0
  const facts = new DefaultMemoryService(
    repository,
    new HierarchicalMemoryPolicy(),
    () => new Date(1_800_000_000_000 + tick++),
  )
  const index = new LocalKeywordMemoryIndex(join(root, 'index.json'))
  const memory = new IndexingMemoryService(facts, repository, index)
  return {
    facts,
    index,
    maintenance: new DefaultMemoryMaintenanceService(repository, index),
    memory,
    recall: new DefaultMemoryRecallService(memory, index),
    repository,
    root,
  }
}

function input(id: string, content: string) {
  return {
    id,
    scope: projectScope,
    content,
    provenance: { source: 'user' as const },
  }
}

describe('local keyword memory index', () => {
  it('forwards fact mutation notifications to wrapper consumers', async () => {
    const { memory } = await fixture()
    let changes = 0
    const subscription = memory.onDidChange(() => changes++)

    await memory.create(input('observed', 'first value'))
    expect(changes).toBe(1)
    subscription.dispose()
    await memory.update(projectScope, 'observed', { content: 'second value' })
    expect(changes).toBe(1)
  })

  it('runs lifecycle policy before index side effects and emits post/delete after commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund-memory-hooks-'))
    roots.push(root)
    const repository = new LocalMemoryRepository(join(root, 'records.json'))
    const index = new LocalKeywordMemoryIndex(join(root, 'index.json'))
    const events: string[] = []
    const memory = new IndexingMemoryService(
      new DefaultMemoryService(repository),
      repository,
      index,
      {
        preWrite(context) {
          events.push(`pre:${context.phase}:${context.operation}:${context.content ?? '-'}`)
          if (context.content === 'blocked')
            throw new MemoryError('memory_hook_veto', 'fixture policy')
        },
        postWrite(context) {
          events.push(`post:${context.operation}`)
        },
        deleted(context) {
          events.push(`deleted:${context.operation}`)
        },
      },
    )

    await expect(memory.create(input('blocked', 'blocked'))).rejects.toMatchObject({
      code: 'memory_hook_veto',
    })
    expect(await repository.load()).toEqual([])
    expect(await index.health()).toMatchObject({ status: 'missing', indexedRecords: 0 })

    const beforeSecret = events.length
    await expect(memory.create(input('secret', 'api_key=FAKE-secret-value'))).rejects.toMatchObject(
      {
        code: 'memory_validation',
      },
    )
    expect(events).toHaveLength(beforeSecret)

    const attachment = {
      schemaVersion: 1 as const,
      id: 'diagram',
      handle: `${'a'.repeat(64)}.png`,
      mime: 'image/png',
      size: 42,
      digest: 'a'.repeat(64),
      state: 'active' as const,
      createdAt: '2026-08-13T00:00:00.000Z',
      invalidatedAt: null,
      deletedAt: null,
    }
    await memory.create({ ...input('allowed', 'safe'), attachments: [attachment] })
    await memory.update(projectScope, 'allowed', { tags: ['updated'] })
    await memory.pin(projectScope, 'allowed')
    await memory.unpin(projectScope, 'allowed')
    await memory.invalidateAttachment(projectScope, 'allowed', 'diagram')
    await memory.deleteAttachment(projectScope, 'allowed', 'diagram')
    await memory.delete(projectScope, 'allowed')

    expect(events.filter((event) => event.startsWith('post:'))).toEqual([
      'post:create',
      'post:update',
      'post:pin',
      'post:unpin',
      'post:invalidateAttachment',
      'post:deleteAttachment',
      'post:delete',
    ])
    expect(events.at(-1)).toBe('deleted:delete')
  })

  it('incrementally removes old terms and deleted facts', async () => {
    const { maintenance, memory, recall } = await fixture()
    await memory.create(input('preference', 'Use pnpm workspaces'))
    expect((await recall.recall(projectScope, 'pnpm')).map((hit) => hit.record.id)).toEqual([
      'preference',
    ])

    await memory.update(projectScope, 'preference', { content: 'Use cargo workspaces' })
    expect(await recall.recall(projectScope, 'pnpm')).toEqual([])
    expect((await recall.recall(projectScope, 'cargo'))[0]?.record.content).toBe(
      'Use cargo workspaces',
    )

    await memory.pin(projectScope, 'preference')
    expect((await maintenance.doctor()).healthy).toBe(true)
    await memory.delete(projectScope, 'preference')
    expect(await recall.recall(projectScope, 'cargo')).toEqual([])
    expect((await maintenance.doctor()).index).toMatchObject({
      status: 'healthy',
      indexedRecords: 0,
    })
  })

  it('filters ghost, stale, deleted, and unauthorized candidates through the fact service', async () => {
    const { facts, index, memory, recall } = await fixture()
    const record = await memory.create(input('visible', 'shared keyword'))
    await index.upsert({ ...record, id: 'ghost' })
    const stale = await memory.create(input('stale', 'outdated keyword'))
    await facts.update(projectScope, stale.id, { content: 'current content' })

    expect((await recall.recall(projectScope, 'keyword')).map((hit) => hit.record.id)).toEqual([
      'visible',
    ])
    expect(await recall.recall(projectScope, 'outdated')).toEqual([])
    expect(
      await recall.recall(
        { kind: 'project', workspaceId: 'local', projectId: 'project-b' },
        'keyword',
      ),
    ).toEqual([])
  })

  it('uses a dirty marker to recover an interrupted incremental update on restart', async () => {
    const { facts, index, maintenance, repository, root } = await fixture()
    await facts.create(input('first', 'existing term'))
    await index.reindex(await repository.load())
    await index.markDirty('simulated-crash')
    await facts.create(input('second', 'recovered term'))
    expect((await maintenance.doctor()).index.status).toBe('dirty')

    const restartedIndex = new LocalKeywordMemoryIndex(join(root, 'index.json'))
    const restarted = new IndexingMemoryService(
      new DefaultMemoryService(repository),
      repository,
      restartedIndex,
    )
    const recall = new DefaultMemoryRecallService(restarted, restartedIndex)
    expect((await recall.recall(projectScope, 'recovered'))[0]?.record.id).toBe('second')
    expect(
      (await new DefaultMemoryMaintenanceService(repository, restartedIndex).doctor()).healthy,
    ).toBe(true)
  })

  it('reports a stale index after independently coordinated fact writers and rebuilds it', async () => {
    const { index, maintenance, repository } = await fixture()
    await index.reindex([])
    const first = new DefaultMemoryService(repository)
    const second = new DefaultMemoryService(new LocalMemoryRepository(repository.path))
    await Promise.all([first.start(), second.start()])
    await Promise.all([
      first.create(input('first', 'first concurrent fact')),
      second.create(input('second', 'second concurrent fact')),
    ])

    expect(await maintenance.doctor()).toMatchObject({
      healthy: false,
      facts: { healthy: true, records: 2 },
      index: { status: 'stale', sourceRecords: 2 },
    })
    await maintenance.reindex()
    expect(await maintenance.doctor()).toMatchObject({
      healthy: true,
      facts: { healthy: true, records: 2 },
      index: { status: 'healthy', indexedRecords: 2 },
    })
  })

  it('detects corruption without touching facts and rebuilds a healthy generation', async () => {
    const { maintenance, memory, root } = await fixture()
    await memory.create(input('durable', 'survives corruption'))
    await writeFile(join(root, 'index.json'), '{broken')

    const before = await maintenance.doctor()
    expect(before).toMatchObject({
      healthy: false,
      facts: { healthy: true, records: 1 },
      index: { status: 'corrupt' },
    })
    const report = await maintenance.reindex({ force: true, batchSize: 1 })
    expect(report).toMatchObject({
      action: 'rebuilt',
      processedRecords: 1,
      after: { status: 'healthy' },
    })
    expect((await memory.get(projectScope, 'durable'))?.content).toBe('survives corruption')
  })

  it('keeps the previous healthy generation when a rebuild is interrupted', async () => {
    const { index, memory, repository, root } = await fixture()
    await memory.create(input('old', 'old generation'))
    const oldRecords = await repository.load()
    await index.reindex(oldRecords, { force: true })
    await new DefaultMemoryService(repository).create(input('new', 'new generation'))

    const interrupted = new LocalKeywordMemoryIndex(join(root, 'index.json'), {
      afterBatch() {
        throw new Error('simulated interruption')
      },
    })
    await expect(interrupted.reindex(await repository.load(), { force: true })).rejects.toThrow(
      'simulated interruption',
    )
    expect(await interrupted.search('old')).toMatchObject([{ id: 'old' }])
    expect(await interrupted.health(oldRecords)).toMatchObject({ status: 'healthy' })
  })

  it('does not steal an active reindex lock, even in force mode', async () => {
    const { index, repository, root } = await fixture()
    await writeFile(join(root, 'index.json.lock'), JSON.stringify({ pid: process.pid }))
    await expect(index.reindex(await repository.load(), { force: true })).rejects.toMatchObject({
      code: 'memory_index_busy',
    })
  })

  it('indexes and queries 5000 local records within the regression baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund-memory-index-perf-'))
    roots.push(root)
    const index = new LocalKeywordMemoryIndex(join(root, 'index.json'))
    const records: MemoryRecord[] = Array.from({ length: 5_000 }, (_, number) => ({
      schemaVersion: 1,
      id: `memory-${number}`,
      scope: projectScope,
      content: `local keyword document ${number} ${number === 4_999 ? 'needle' : 'ordinary'}`,
      provenance: { source: 'user' },
      attachments: [],
      tags: ['benchmark'],
      pinned: false,
      createdAt: '2027-01-15T08:00:00.000Z',
      updatedAt: '2027-01-15T08:00:00.000Z',
      deletedAt: null,
    }))

    const buildStarted = performance.now()
    await index.reindex(records, { batchSize: 500 })
    const buildMs = performance.now() - buildStarted
    const queryStarted = performance.now()
    const hits = await index.search('needle')
    const queryMs = performance.now() - queryStarted

    expect(hits[0]?.id).toBe('memory-4999')
    expect(buildMs).toBeLessThan(5_000)
    expect(queryMs).toBeLessThan(1_000)
  })
})
