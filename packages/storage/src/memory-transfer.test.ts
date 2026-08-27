import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DefaultMemoryService, LocalMemoryRepository } from './memory-runtime'
import { MEMORY_EXPORT_SCHEMA_VERSION, MemoryTransferService } from './memory-transfer'

const roots: string[] = []
const project = { kind: 'project', workspaceId: 'ws', projectId: 'project' } as const
const workspace = { kind: 'workspace', workspaceId: 'ws' } as const

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(beforeApply?: (index: number) => void | Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'volund-memory-transfer-'))
  roots.push(root)
  const memory = new DefaultMemoryService(new LocalMemoryRepository(join(root, 'records.json')))
  const transfer = new MemoryTransferService(memory, {
    journalPath: join(root, 'import-journal.json'),
    ...(beforeApply ? { beforeApply } : {}),
    now: () => new Date('2026-08-12T00:00:00.000Z'),
  })
  return { root, memory, transfer }
}

describe('MemoryTransferService', () => {
  it('exports only authorized scopes and keeps attachment references data-only', async () => {
    const { memory, transfer } = await fixture()
    await memory.create({
      id: 'project-memory',
      scope: project,
      content: 'Use pnpm',
      provenance: { source: 'user', actorId: 'alice' },
      attachments: [
        {
          schemaVersion: 1,
          id: 'diagram',
          handle: `${'a'.repeat(64)}.png`,
          mime: 'image/png',
          size: 10,
          digest: 'a'.repeat(64),
          state: 'active',
          createdAt: '2026-08-12T00:00:00.000Z',
          invalidatedAt: null,
          deletedAt: null,
        },
      ],
    })
    await memory.create({
      id: 'workspace-memory',
      scope: workspace,
      content: 'Private workspace note',
      provenance: { source: 'user' },
    })

    const serialized = transfer.serialize(await transfer.export([project]))
    expect(serialized).toContain(MEMORY_EXPORT_SCHEMA_VERSION)
    expect(serialized).toContain('project-memory')
    expect(serialized).not.toContain('workspace-memory')
    expect(serialized).toContain(`${'a'.repeat(64)}.png`)
    expect(serialized).not.toContain('base64')
    const target = await fixture()
    await target.transfer.import(serialized, project)
    expect((await target.memory.get(project, 'project-memory'))?.attachments).toMatchObject([
      { id: 'diagram', state: 'invalidated', invalidatedAt: expect.any(String), deletedAt: null },
    ])
  })

  it('reports conflicts in dry-run and never silently overwrites', async () => {
    const source = await fixture()
    await source.memory.create({
      id: 'same',
      scope: project,
      content: 'incoming',
      provenance: { source: 'agent', actorId: 'source-agent' },
    })
    const archive = source.transfer.serialize(await source.transfer.export([project]))
    const target = await fixture()
    await target.memory.create({
      id: 'same',
      scope: project,
      content: 'existing',
      provenance: { source: 'user' },
    })

    const dryRun = await target.transfer.import(archive, project, {
      strategy: 'overwrite',
      dryRun: true,
    })
    expect(dryRun).toMatchObject({ applied: 0, conflicts: [{ id: 'same', action: 'overwritten' }] })
    expect((await target.memory.get(project, 'same'))?.content).toBe('existing')

    await target.transfer.import(archive, project, { strategy: 'skip' })
    expect((await target.memory.get(project, 'same'))?.content).toBe('existing')
    await target.transfer.import(archive, project, { strategy: 'rename' })
    expect((await target.memory.get(project, 'same-import-1'))?.provenance).toMatchObject({
      source: 'import',
      importedFrom: { source: 'agent', actorId: 'source-agent' },
    })
  })

  it('rolls back a partially applied import and supports a clean retry', async () => {
    let fail = true
    const target = await fixture((index) => {
      if (fail && index === 1) throw new Error('simulated interruption')
    })
    const document = {
      schemaVersion: MEMORY_EXPORT_SCHEMA_VERSION,
      exportedAt: '2026-08-12T00:00:00.000Z',
      records: ['one', 'two'].map((id) => ({
        schemaVersion: 1 as const,
        id,
        scope: project,
        content: id,
        provenance: { source: 'user' as const },
        attachments: [],
        tags: [],
        pinned: false,
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:00:00.000Z',
        deletedAt: null,
      })),
    }
    const archive = target.transfer.serialize(document)
    await expect(target.transfer.import(archive, project)).rejects.toMatchObject({
      code: 'memory_io',
    })
    expect(await target.memory.list(project)).toEqual([])
    fail = false
    await expect(target.transfer.import(archive, project)).resolves.toMatchObject({ applied: 2 })
    expect((await target.memory.list(project)).map(({ id }) => id).toSorted()).toEqual([
      'one',
      'two',
    ])
  })

  it('recovers a durable interruption journal and rejects large, duplicate, malicious, and incompatible input', async () => {
    const { root, memory, transfer } = await fixture()
    await memory.create({
      id: 'changed',
      scope: project,
      content: 'after crash',
      provenance: { source: 'import' },
    })
    await writeFile(
      join(root, 'import-journal.json'),
      JSON.stringify({
        schemaVersion: 1,
        targetScope: project,
        operations: [{ id: 'changed', before: null }],
      }),
    )
    await expect(transfer.recoverInterruptedImport()).resolves.toBe(true)
    expect(await memory.list(project)).toEqual([])

    expect(() => transfer.parse('x'.repeat(17 * 1024 * 1024))).toThrow('16 MiB')
    expect(() =>
      transfer.parse(
        JSON.stringify({
          schemaVersion: MEMORY_EXPORT_SCHEMA_VERSION,
          exportedAt: new Date().toISOString(),
          records: [{ id: '../escape', schemaVersion: 1, attachments: [], tags: [], content: 'x' }],
        }),
      ),
    ).toThrow('invalid record')
    expect(() =>
      transfer.parse(JSON.stringify({ schemaVersion: 'volund.memory.export.v999', records: [] })),
    ).toThrow('incompatible')

    const valid = transfer.serialize({
      schemaVersion: MEMORY_EXPORT_SCHEMA_VERSION,
      exportedAt: '2026-08-12T00:00:00.000Z',
      records: [],
    })
    const duplicate = JSON.parse(valid) as { records: unknown[] }
    const record = {
      schemaVersion: 1,
      id: 'duplicate',
      scope: project,
      content: 'x',
      provenance: { source: 'user' },
      attachments: [],
      tags: [],
      pinned: false,
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      deletedAt: null,
    }
    duplicate.records = [record, record]
    expect(() => transfer.parse(JSON.stringify(duplicate))).toThrow('invalid record')
    const fakeProviderSecret = `ghp_${'FAKE'.repeat(8)}`
    const secret = { ...record, id: 'secret', content: fakeProviderSecret, pinned: true }
    await expect(
      transfer.import(
        JSON.stringify({
          schemaVersion: MEMORY_EXPORT_SCHEMA_VERSION,
          exportedAt: '2026-08-12T00:00:00.000Z',
          records: [secret],
        }),
        project,
        { dryRun: true },
      ),
    ).rejects.toMatchObject({ code: 'memory_validation' })
    await expect(readFile(join(root, 'import-journal.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await memory.get(project, 'secret')).toBeUndefined()
    await expect(readFile(join(root, 'records.json'), 'utf8')).resolves.not.toContain(
      fakeProviderSecret,
    )
  })
})
