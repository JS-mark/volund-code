import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createMemoryStack } from './memory'
import { projectMemoryScope } from './memory-scope'
import { createMemoryPanelController } from './memory-controller'

const dirs: string[] = []
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
)

async function makeController() {
  const home = await mkdtemp(join(tmpdir(), 'volund-memory-panel-'))
  dirs.push(home)
  const stack = createMemoryStack(home)
  const controller = createMemoryPanelController(
    stack.memory,
    stack.memoryRecall,
    projectMemoryScope(home),
    stack.memoryTransfer,
  )
  return { controller }
}

describe('memory panel controller create/export/import (WEB-EXT-MANAGE-MARKET-r1 MG-01/03)', () => {
  it('creates with provenance user/web and updates with optimistic concurrency', async () => {
    const { controller } = await makeController()
    const created = await controller.create({ content: '# 记忆\nmarkdown 内容', tags: ['a', 'b'] })
    expect(created.content).toBe('# 记忆\nmarkdown 内容')
    expect(created.tags).toEqual(['a', 'b'])
    expect(created.source).toBe('user')
    expect(created.actor).toBe('web')

    const updated = await controller.update(created.id, { content: 'updated', tags: ['c'] }, created.updatedAt)
    expect(updated.content).toBe('updated')
    expect(updated.tags).toEqual(['c'])

    // 冲突：stale expectedUpdatedAt → memory_conflict
    await expect(
      controller.update(created.id, { content: 'racer', tags: [] }, created.updatedAt),
    ).rejects.toMatchObject({ code: 'memory_conflict' })
  })

  it('export → import roundtrip into a fresh scope-local controller (dry-run applies nothing)', async () => {
    const first = await makeController()
    const record = await first.controller.create({ content: 'exported memory', pinned: true })
    const document = (await first.controller.exportAll()) as {
      schemaVersion: string
      records: { id: string; content: string }[]
    }
    expect(document.schemaVersion).toBe('volund.memory.export.v1')
    expect(document.records).toHaveLength(1)
    expect(document.records[0]!.content).toBe('exported memory')

    const second = await makeController()
    const dryRun = (await second.controller.importDocs({
      serialized: JSON.stringify(document),
      strategy: 'overwrite',
      dryRun: true,
    })) as { dryRun: boolean; applied: number; total: number }
    expect(dryRun.dryRun).toBe(true)
    expect(dryRun.applied).toBe(0)
    expect(dryRun.total).toBe(1)
    expect((await second.controller.list({ limit: 10 })).items).toHaveLength(0)

    const report = (await second.controller.importDocs({
      serialized: JSON.stringify(document),
      strategy: 'overwrite',
    })) as { applied: number; total: number }
    expect(report.applied).toBe(1)
    const items = (await second.controller.list({ limit: 10 })).items
    expect(items).toHaveLength(1)
    expect(items[0]!.content).toBe('exported memory')
    // 导入保留置顶；id 保持一致（同 scope 语义下与导出源同 id）。
    expect(items[0]!.pinned).toBe(true)
    expect(items[0]!.id).toBe(record.id)

    // transfer 未装配 → 明确错误码（动作表透传前端提示）。
    const home = await mkdtemp(join(tmpdir(), 'volund-memory-panel-'))
    dirs.push(home)
    const stack = createMemoryStack(home)
    const bare = createMemoryPanelController(
      stack.memory,
      stack.memoryRecall,
      projectMemoryScope(home),
    )
    await expect(bare.exportAll()).rejects.toMatchObject({ code: 'memory_transfer_unavailable' })
  })
})
