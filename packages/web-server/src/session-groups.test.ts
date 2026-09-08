import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SessionGroupsPort } from './session-groups'
import { createSessionGroupStore } from './session-groups'

let dir: string
let file: string
let store: SessionGroupsPort

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'volund-web-groups-'))
  file = join(dir, 'session-groups.json')
  store = createSessionGroupStore(file)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code })
}

describe('session group store', () => {
  it('creates groups and persists across store instances', async () => {
    const group = await store.create('  工作  ')
    expect(group.name).toBe('工作')
    expect(group.id).toMatch(/^grp_/)
    // 重新加载（模拟 server 重启）：分组与归属都还在。
    const reloaded = createSessionGroupStore(file)
    const view = await reloaded.list()
    expect(view.groups.map((item) => item.name)).toEqual(['工作'])
  })

  it('assigns sessions to groups and back to ungrouped', async () => {
    const group = await store.create('a')
    await store.assign('sess-1', group.id)
    await store.assign('sess-2', group.id)
    expect((await store.list()).assignments).toEqual({ 'sess-1': group.id, 'sess-2': group.id })
    await store.assign('sess-1', null)
    expect((await store.list()).assignments).toEqual({ 'sess-2': group.id })
  })

  it('renames groups and rejects duplicate names on create/rename', async () => {
    const group = await store.create('a')
    await store.create('b')
    const renamed = await store.rename(group.id, ' c ')
    expect(renamed.name).toBe('c')
    await expectCode(store.create('b'), 'web_state_conflict')
    await expectCode(store.rename(group.id, 'b'), 'web_state_conflict')
    // 自身重名为原名不算冲突
    await store.rename(group.id, 'c')
  })

  it('remove deletes the group and drops its assignments', async () => {
    const group = await store.create('a')
    await store.assign('sess-1', group.id)
    await store.remove(group.id)
    const view = await store.list()
    expect(view.groups).toEqual([])
    expect(view.assignments).toEqual({})
  })

  it('rejects operations on unknown group ids', async () => {
    await expectCode(store.rename('grp_none', 'x'), 'web_session_group_not_found')
    await expectCode(store.remove('grp_none'), 'web_session_group_not_found')
    await expectCode(store.assign('sess-1', 'grp_none'), 'web_session_group_not_found')
  })

  it('validates names and session ids', async () => {
    await expectCode(store.create('   '), 'web_schema_invalid')
    await expectCode(store.create('x'.repeat(61)), 'web_schema_invalid')
    await expectCode(store.assign('', null), 'web_schema_invalid')
  })

  it('tolerates a corrupt file by starting empty, and prunes dangling assignments on load', async () => {
    await writeFile(file, 'not json')
    expect(await store.list()).toEqual({ groups: [], assignments: {} })
    // 归属指向已删除分组的条目在加载时被裁掉。
    await writeFile(
      file,
      JSON.stringify({
        groups: [{ id: 'grp_a', name: 'a', createdAt: 1 }],
        assignments: { 'sess-1': 'grp_a', 'sess-2': 'grp_gone' },
      }),
    )
    const fresh = createSessionGroupStore(file)
    const view = await fresh.list()
    expect(view.assignments).toEqual({ 'sess-1': 'grp_a' })
  })

  it('serializes concurrent mutations without losing writes', async () => {
    await Promise.all([store.create('a'), store.create('b'), store.create('c')])
    const view = await store.list()
    expect(view.groups.map((group) => group.name).sort()).toEqual(['a', 'b', 'c'])
    // 文件内容合法且与内存一致。
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { groups: unknown[] }
    expect(onDisk.groups).toHaveLength(3)
  })
})
