import { mkdir, mkdtemp, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, parse } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { validateWorkspacePath } from './path-guard'

const fixtures: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(fixtures.map((path) => rm(path, { force: true, recursive: true })))
})

describe('validateWorkspacePath', () => {
  it('returns a realpath for an ordinary workspace', async () => {
    const root = await mkdtemp(join(process.cwd(), '.path-guard-'))
    fixtures.push(root)
    expect(await validateWorkspacePath(root)).toBe(root)
  })

  it.each([parse(process.cwd()).root, homedir()])('rejects protected root %s', async (path) => {
    await expect(validateWorkspacePath(path)).rejects.toMatchObject({ code: 'VOLUND_UNSAFE_CWD' })
  })

  it('rejects sensitive prefixes after resolving a symlink', async () => {
    const root = await mkdtemp(join(process.cwd(), '.path-guard-'))
    const link = join(root, 'escape')
    fixtures.push(root)
    await mkdir(join(homedir(), '.volund'), { recursive: true })
    await symlink(join(homedir(), '.volund'), link)
    await expect(validateWorkspacePath(link)).rejects.toMatchObject({ code: 'VOLUND_UNSAFE_CWD' })
  })
})
