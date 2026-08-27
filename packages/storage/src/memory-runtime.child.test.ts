import { access, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import { DefaultMemoryService, LocalMemoryRepository } from './memory-runtime'

const file = process.env.VOLUND_MEMORY_CHILD_FILE
const gate = process.env.VOLUND_MEMORY_CHILD_GATE
const id = process.env.VOLUND_MEMORY_CHILD_ID

describe.skipIf(!file || !gate || !id)('memory runtime child writer', () => {
  it('commits one record after both processes are ready', async () => {
    if (!file || !gate || !id) throw new Error('Memory child environment is incomplete')
    await writeFile(`${gate}.${id}.ready`, '')
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try {
        await access(gate)
        break
      } catch {
        await delay(10)
      }
    }
    await access(gate)

    const service = new DefaultMemoryService(new LocalMemoryRepository(file))
    await service.create({
      id,
      scope: { kind: 'project', workspaceId: 'ws', projectId: `project-${id}` },
      content: `child-${id}`,
      provenance: { source: 'user' },
    })
    expect(
      await service.get({ kind: 'project', workspaceId: 'ws', projectId: `project-${id}` }, id),
    ).toMatchObject({ id })
  })
})
