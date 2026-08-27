import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DefaultMemoryService, LocalMemoryRepository } from '@volund/storage'
import type { ToolContext } from '@volund/tool-kit'
import { afterEach, describe, expect, it } from 'vitest'

import { projectMemoryScope } from './memory-scope'
import { createMemoryTools } from './memory-tools'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'volund-memory-tools-'))
  roots.push(root)
  const memory = new DefaultMemoryService(new LocalMemoryRepository(join(root, 'records.json')))
  const tools = new Map(createMemoryTools(memory).map((tool) => [tool.name, tool]))
  const context = {
    abortSignal: new AbortController().signal,
    session: { id: 'session-1', cwd: '/workspace/project', turnId: 'turn-1' },
    native: { execute: async () => undefined },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ui: { requestInput: async () => '' },
  } as ToolContext
  return { memory, tools, context }
}

describe('Memory.* model tools', () => {
  it('exports complete schemas and delegates CRUD to the shared service', async () => {
    const { tools, context } = await fixture()
    expect([...tools.keys()]).toEqual([
      'Memory.create',
      'Memory.get',
      'Memory.list',
      'Memory.update',
      'Memory.delete',
      'Memory.pin',
      'Memory.unpin',
    ])
    for (const tool of tools.values()) {
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
    }

    await tools
      .get('Memory.create')!
      .invoke(
        { scope: 'project', id: 'preference', content: 'Use pnpm', tags: ['tooling'] },
        context,
      )
    const listed = await tools.get('Memory.list')!.invoke({ scope: 'project', limit: 10 }, context)
    expect(listed.content[0]).toMatchObject({ type: 'text' })
    expect(JSON.parse((listed.content[0] as { text: string }).text).items).toMatchObject([
      { id: 'preference', content: 'Use pnpm' },
    ])
    await tools.get('Memory.pin')!.invoke({ scope: 'project', id: 'preference' }, context)
    await tools.get('Memory.delete')!.invoke({ scope: 'project', id: 'preference' }, context)
    expect(
      JSON.parse(
        (
          (await tools.get('Memory.get')!.invoke({ scope: 'project', id: 'preference' }, context))
            .content[0] as { text: string }
        ).text,
      ),
    ).toMatchObject({ deletedAt: expect.any(String) })
  })

  it('derives scope identity from the tool context instead of model parameters', async () => {
    const { tools, context } = await fixture()
    await tools
      .get('Memory.create')!
      .invoke({ scope: 'session', id: 'private', content: 'session only' }, context)
    const other = { ...context, session: { ...context.session, id: 'session-2' } }
    const result = await tools.get('Memory.get')!.invoke({ scope: 'session', id: 'private' }, other)
    expect(JSON.parse((result.content[0] as { text: string }).text)).toBeNull()
  })

  it('fails closed when model output contains a provider credential', async () => {
    const { memory, tools, context } = await fixture()
    const fakeProviderSecret = `sk-proj-${'FAKE'.repeat(6)}`
    await expect(
      tools
        .get('Memory.create')!
        .invoke({ scope: 'project', id: 'rejected', content: fakeProviderSecret }, context),
    ).rejects.toMatchObject({ code: 'memory_validation' })
    expect(await memory.list(projectMemoryScope(context.session.cwd))).toEqual([])
  })
})
