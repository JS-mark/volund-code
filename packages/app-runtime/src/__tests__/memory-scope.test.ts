import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { memoryProjectId, memoryProjectRoot, projectMemoryScope } from '../memory-scope'

const dirs: string[] = []
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
)

async function makeRepo(structure: 'plain' | 'worktree-style' | 'none' = 'plain') {
  const root = await mkdtemp(join(await mkdtemp(join('/tmp', 'volund-scope-outer-')), 'repo-'))
  dirs.push(root)
  await mkdir(join(root, 'packages', 'app'), { recursive: true })
  if (structure === 'plain') await mkdir(join(root, '.git'), { recursive: true })
  if (structure === 'worktree-style')
    await writeFile(join(root, '.git'), 'gitdir: /somewhere/else/worktrees/one\n')
  return { root, app: join(root, 'packages', 'app') }
}

describe('memory project scope resolution (ADR-0014)', () => {
  it('binds monorepo subpackages to the git root identity', async () => {
    const { root, app } = await makeRepo()
    expect(memoryProjectRoot(app)).toBe(root)
    expect(memoryProjectId(app)).toBe(memoryProjectId(root))
    // Same resolved root → identical project scope (kind/workspaceId/projectId).
    expect(projectMemoryScope(app)).toEqual(projectMemoryScope(root))
  })

  it('treats a .git pointer file (worktree) as a project root', async () => {
    const { root, app } = await makeRepo('worktree-style')
    expect(memoryProjectRoot(app)).toBe(root)
  })

  it('falls back to the directory itself outside a git repository', async () => {
    const plain = await mkdtemp(join('/tmp', 'volund-scope-nongit-'))
    dirs.push(plain)
    const nested = join(plain, 'deep', 'deeper')
    await mkdir(nested, { recursive: true })
    expect(memoryProjectRoot(nested)).toBe(resolve(nested))
    expect(memoryProjectId(plain)).not.toBe(memoryProjectId(nested))
  })

  it('stops the upward search at the home boundary', () => {
    // A path inside home never resolves a root above home: without a .git the
    // fallback is the directory itself, and different subdirs stay distinct.
    const insideHome = join(homedir(), 'volund-scope-probe-does-not-exist')
    expect(memoryProjectRoot(insideHome)).toBe(resolve(insideHome))
    expect(memoryProjectRoot(join(insideHome, 'sub'))).toBe(join(resolve(insideHome), 'sub'))
    expect(memoryProjectId(join(insideHome, 'sub'))).not.toBe(memoryProjectId(insideHome))
  })
})
