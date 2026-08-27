import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DefaultMemoryRecallService,
  DefaultMemoryService,
  IndexingMemoryService,
  LocalKeywordMemoryIndex,
  LocalMemoryRepository,
} from '@volund/storage'
import { afterEach, describe, expect, it } from 'vitest'

import { runCli } from './cli'
import { createMemoryPanelController } from './memory-panel'
import { projectMemoryScope } from './memory-scope'
import { unavailablePorts } from './ports'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'volund-memory-panel-'))
  roots.push(root)
  let tick = 0
  const repository = new LocalMemoryRepository(join(root, 'records.json'))
  const index = new LocalKeywordMemoryIndex(join(root, 'index.json'))
  const memory = new IndexingMemoryService(
    new DefaultMemoryService(
      repository,
      undefined,
      () => new Date(`2026-08-12T00:00:0${tick++}.000Z`),
    ),
    repository,
    index,
  )
  const recall = new DefaultMemoryRecallService(memory, index)
  const scope = projectMemoryScope(process.cwd())
  await memory.create({
    id: 'older-pinned',
    scope,
    content: 'Use pnpm for packages',
    provenance: { source: 'user', actorId: 'test' },
    pinned: true,
    tags: ['tooling'],
  })
  await memory.create({
    id: 'newer-note',
    scope,
    content: 'Keep Ink components pure',
    provenance: { source: 'agent', actorId: 'test' },
    tags: ['architecture'],
  })
  return { memory, recall, scope }
}

describe('createMemoryPanelController', () => {
  it('returns the same scoped ordering and recall ids as CLI consumers', async () => {
    const { memory, recall, scope } = await fixture()
    const controller = createMemoryPanelController(memory, recall, scope)
    const ports = { ...unavailablePorts(), memory, memoryRecall: recall }

    const panelPage = await controller.list({ limit: 100 })
    const cliPage = JSON.parse(
      (
        await runCli(['memory', 'list', '--scope', 'project', '--limit', '100', '--json'], ports, {
          isInteractiveTerminal: () => false,
          readStdin: async () => '',
        })
      ).stdout,
    ) as { items: Array<{ id: string }> }
    expect(panelPage.items.map((record) => record.id)).toEqual(
      cliPage.items.map((record) => record.id),
    )
    expect(panelPage.items.map((record) => record.id)).toEqual(['older-pinned', 'newer-note'])

    const panelHits = await controller.search({ query: 'Ink pure', limit: 10 })
    const cliHits = JSON.parse(
      (
        await runCli(['memory', 'search', 'Ink pure', '--scope', 'project', '--json'], ports, {
          isInteractiveTerminal: () => false,
          readStdin: async () => '',
        })
      ).stdout,
    ) as { hits: Array<{ record: { id: string } }> }
    expect(panelHits.map((record) => record.id)).toEqual(cliHits.hits.map((hit) => hit.record.id))
  })

  it('passes optimistic concurrency through and preserves facts after a rejected edit', async () => {
    const { memory, recall, scope } = await fixture()
    const controller = createMemoryPanelController(memory, recall, scope)
    const before = await controller.get('newer-note')
    expect(before).toBeDefined()

    await expect(
      controller.update(
        'newer-note',
        { content: `ghp_${'FAKE'.repeat(8)}`, tags: ['architecture'] },
        before!.updatedAt,
      ),
    ).rejects.toMatchObject({ code: 'memory_validation' })
    await expect(controller.pin('newer-note', 'stale-token')).rejects.toMatchObject({
      code: 'memory_conflict',
    })
    expect(await controller.get('newer-note')).toEqual(before)
  })

  it('maps ANSI-free redacted DTOs and keeps unavailable search explicit', async () => {
    const { memory, scope } = await fixture()
    await memory.create({
      id: 'terminal-safe',
      scope,
      content: '\u001B[31mred\u001B[0m text',
      provenance: { source: 'user' },
    })
    const controller = createMemoryPanelController(memory, undefined, scope)

    expect((await controller.get('terminal-safe'))?.content).toBe('red text')
    expect(controller.searchAvailable).toBe(false)
    await expect(controller.search({ query: 'red', limit: 10 })).rejects.toMatchObject({
      code: 'memory_index_unavailable',
    })
  })
})
