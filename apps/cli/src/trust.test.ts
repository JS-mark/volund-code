import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DirectoryTrustStore } from './trust'

const fixtures: string[] = []
afterEach(async () =>
  Promise.all(fixtures.map((path) => rm(path, { recursive: true, force: true }))),
)

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'volund-trust-'))
  fixtures.push(root)
  const configDir = join(root, 'config')
  const workspace = join(root, 'work', 'project')
  await mkdir(workspace, { recursive: true })
  return { root, workspace, store: new DirectoryTrustStore(configDir) }
}

describe('DirectoryTrustStore', () => {
  it('matches exact and tree rules without matching adjacent prefixes', async () => {
    const { root, workspace, store } = await fixture()
    await store.grant(workspace, 'exact')
    expect(await store.check(workspace)).toMatchObject({ trusted: true, scope: 'exact' })
    const child = join(workspace, 'child')
    await mkdir(child)
    expect(await store.check(child)).toEqual({
      trusted: false,
      canonicalPath: await store.canonicalize(child),
    })

    await store.grant(workspace, 'tree')
    expect(await store.check(child)).toMatchObject({ trusted: true, scope: 'tree' })
    const adjacent = join(root, 'work', 'project-evil')
    await mkdir(adjacent)
    expect((await store.check(adjacent)).trusted).toBe(false)
  })

  it('canonicalizes dot segments and symlinks before granting and checking', async () => {
    const { root, workspace, store } = await fixture()
    const link = join(root, 'linked-project')
    await symlink(workspace, link, 'dir')
    await store.grant(join(workspace, '..', 'project'), 'tree')
    expect(await store.check(link)).toMatchObject({
      trusted: true,
      canonicalPath: await store.canonicalize(workspace),
    })
  })

  it('backs up corrupt state and recovers with an atomic valid write', async () => {
    const { workspace, store } = await fixture()
    await mkdir(store.configDir, { recursive: true })
    await writeFile(store.filePath, '{broken', 'utf8')
    expect((await store.check(workspace)).trusted).toBe(false)
    await store.grant(workspace, 'exact')
    expect(JSON.parse(await readFile(store.filePath, 'utf8')).rules).toHaveLength(1)
    expect(await readFile(`${store.filePath}.corrupt`, 'utf8')).toBe('{broken')
  })

  it('serializes concurrent grants without losing rules', async () => {
    const { root, workspace, store } = await fixture()
    const second = join(root, 'work', 'second')
    await mkdir(second)
    await Promise.all([store.grant(workspace, 'exact'), store.grant(second, 'tree')])
    expect(await store.list()).toHaveLength(2)
  })

  it('revokes one canonical rule or all rules', async () => {
    const { root, workspace, store } = await fixture()
    const second = join(root, 'work', 'second')
    await mkdir(second)
    await store.grant(workspace, 'exact')
    await store.grant(second, 'tree')
    expect(await store.revoke(workspace)).toBe(1)
    expect(await store.list()).toHaveLength(1)
    expect(await store.revokeAll()).toBe(1)
    expect(await store.list()).toEqual([])
  })

  it('refuses filesystem roots and sensitive user-level scopes', async () => {
    const { store } = await fixture()
    await expect(store.grant('/', 'tree')).rejects.toThrow('sensitive directory')
  })
})
