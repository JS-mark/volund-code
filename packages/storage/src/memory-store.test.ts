import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ScopedMemoryStore, validateMemoryAttachmentReference } from './memory-store'

const roots: string[] = []
const attachment = {
  schemaVersion: 1 as const,
  handle: `${'a'.repeat(64)}.png`,
  digest: 'a'.repeat(64),
  mime: 'image/png',
  size: 42,
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function store() {
  const root = await mkdtemp(resolve(tmpdir(), 'volund-scoped-memory-'))
  roots.push(root)
  return new ScopedMemoryStore(root, () => 123)
}

describe('memory attachment references', () => {
  it('accepts content-addressed references and rejects forged schema fields', () => {
    expect(validateMemoryAttachmentReference(attachment)).toBe(true)
    expect(validateMemoryAttachmentReference({ ...attachment, digest: 'b'.repeat(64) })).toBe(false)
    expect(validateMemoryAttachmentReference({ ...attachment, handle: '../secret.png' })).toBe(
      false,
    )
    expect(validateMemoryAttachmentReference({ ...attachment, size: 0 })).toBe(false)
  })
})

describe('ScopedMemoryStore ACL', () => {
  it('persists attachment references without bytes and recalls only owner/project-visible records', async () => {
    const memory = await store()
    const principal = { userId: 'alice', projectId: 'alpha' }
    await memory.write(
      {
        id: 'global',
        scope: { kind: 'global', ownerId: 'alice' },
        text: 'global',
        attachments: [attachment],
      },
      principal,
    )
    await memory.write(
      {
        id: 'project',
        scope: { kind: 'project', ownerId: 'alice', projectId: 'alpha' },
        text: 'project',
      },
      principal,
    )

    expect(
      (await memory.recall(principal, { global: 0.5, project: 0.9 })).map((x) => x.id),
    ).toEqual(['project', 'global'])
    expect((await memory.list({ userId: 'alice', projectId: 'beta' })).map((x) => x.id)).toEqual([
      'global',
    ])
    expect(await memory.list({ userId: 'mallory', projectId: 'alpha' })).toEqual([])
  })

  it('denies cross-user and cross-project writes', async () => {
    const memory = await store()
    await expect(
      memory.write(
        { id: 'other-user', scope: { kind: 'global', ownerId: 'alice' }, text: 'secret' },
        { userId: 'mallory' },
      ),
    ).rejects.toThrow('memory_scope_denied')
    await expect(
      memory.write(
        {
          id: 'other-project',
          scope: { kind: 'project', ownerId: 'alice', projectId: 'alpha' },
          text: 'secret',
        },
        { userId: 'alice', projectId: 'beta' },
      ),
    ).rejects.toThrow('memory_scope_denied')
  })

  it('keeps team sharing fail-closed pending explicit authorization and membership', async () => {
    const memory = await store()
    const input = { id: 'team', scope: { kind: 'team' as const, teamId: 'red' }, text: 'shared' }
    await expect(memory.write(input, { userId: 'alice', teamIds: ['red'] })).rejects.toThrow(
      'memory_scope_denied',
    )
    await expect(
      memory.write(input, { userId: 'alice', teamIds: ['blue'], teamSharedAuthorized: true }),
    ).rejects.toThrow('memory_scope_denied')
    await memory.write(input, { userId: 'alice', teamIds: ['red'], teamSharedAuthorized: true })
    expect(await memory.list({ userId: 'alice', teamIds: ['red'] })).toEqual([])
    expect(
      await memory.list({ userId: 'alice', teamIds: ['red'], teamSharedAuthorized: true }),
    ).toHaveLength(1)
  })
})
