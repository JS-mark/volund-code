import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { PermissionManager } from '@volund/permission'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MultiEditTool,
  ReadTool,
  ToolExecutor,
  builtinTools,
  truncateToolResult,
  type FileBackupPort,
} from './index'
const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function fixture() {
  const cwd = await mkdtemp(resolve(tmpdir(), 'volund-tools-'))
  dirs.push(cwd)
  return cwd
}
function context(cwd: string) {
  return {
    abortSignal: new AbortController().signal,
    session: { id: 'session-1', cwd, turnId: 'turn-1' },
    native: { execute: async () => '' },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ui: { requestInput: async () => '' },
  }
}
describe('L1 tools', () => {
  it('registers MultiEdit and all destructive tools require sandbox', () => {
    const tools = builtinTools()
    expect(tools.map((x) => x.name)).toEqual([
      'Read',
      'Write',
      'Edit',
      'MultiEdit',
      'Bash',
      'Grep',
      'Glob',
      'Todo',
      'WebSearch',
      'WebFetch',
    ])
    for (const name of ['Write', 'Edit', 'MultiEdit', 'Bash'])
      expect(
        (tools.find((x) => x.name === name) as unknown as { sandboxRequired: boolean })
          .sandboxRequired,
      ).toBe(true)
  })

  it('applies multiple files only after every exact match validates', async () => {
    const cwd = await fixture()
    await writeFile(resolve(cwd, 'a.txt'), 'alpha')
    await writeFile(resolve(cwd, 'b.txt'), 'beta beta')
    const tool = new MultiEditTool()
    const failed = await tool.invoke(
      {
        edits: [
          { path: 'a.txt', old_string: 'alpha', new_string: 'A' },
          { path: 'b.txt', old_string: 'beta', new_string: 'B' },
        ],
      },
      context(cwd),
    )
    expect(failed.isError).toBe(true)
    expect(await readFile(resolve(cwd, 'a.txt'), 'utf8')).toBe('alpha')
    expect(await readFile(resolve(cwd, 'b.txt'), 'utf8')).toBe('beta beta')
  })

  it('rolls every file back when committing the backup transaction fails', async () => {
    const cwd = await fixture()
    const first = resolve(cwd, 'a.txt'),
      second = resolve(cwd, 'b.txt')
    await writeFile(first, 'alpha')
    await writeFile(second, 'beta')
    const backups: FileBackupPort = {
      async prepare(_sessionId, paths) {
        const originals = await Promise.all(
          paths.map(async (path) => [path, await readFile(path)] as const),
        )
        return {
          async commit() {
            throw new Error('backup disk full')
          },
          async rollback() {
            await Promise.all(originals.map(([path, bytes]) => writeFile(path, bytes)))
          },
        }
      },
    }
    const result = await new MultiEditTool(backups).invoke(
      {
        edits: [
          { path: 'a.txt', old_string: 'alpha', new_string: 'A' },
          { path: 'b.txt', old_string: 'beta', new_string: 'B' },
        ],
      },
      context(cwd),
    )
    expect(result.isError).toBe(true)
    expect(await readFile(first, 'utf8')).toBe('alpha')
    expect(await readFile(second, 'utf8')).toBe('beta')
  })

  it('refuses symlink writes and a lock held by another session', async () => {
    const cwd = await fixture(),
      outside = resolve(await fixture(), 'outside.txt')
    await writeFile(outside, 'outside')
    await symlink(outside, resolve(cwd, 'linked.txt'))
    const linked = await new MultiEditTool().invoke(
      { edits: [{ path: 'linked.txt', old_string: 'outside', new_string: 'changed' }] },
      context(cwd),
    )
    expect(linked.isError).toBe(true)
    expect(await readFile(outside, 'utf8')).toBe('outside')

    await writeFile(resolve(cwd, 'locked.txt'), 'before')
    await writeFile(resolve(cwd, 'locked.txt.volundlock'), 'other-session')
    const pending = new MultiEditTool().invoke(
      { edits: [{ path: 'locked.txt', old_string: 'before', new_string: 'after' }] },
      context(cwd),
    )
    expect((await pending).isError).toBe(true)
    expect(await readFile(resolve(cwd, 'locked.txt'), 'utf8')).toBe('before')
  }, 10_000)
  it('validates before permission', async () => {
    const prompt = vi.fn(),
      manager = new PermissionManager()
    manager.setPromptHandler(prompt)
    const executor = new ToolExecutor(manager, (signal) => ({
      abortSignal: signal,
      session: { id: 's', cwd: process.cwd(), turnId: 't' },
      native: { execute: async () => '' },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      ui: { requestInput: async () => '' },
    }))
    expect((await executor.execute(new ReadTool(), {}, new AbortController().signal)).isError).toBe(
      true,
    )
    expect(prompt).not.toHaveBeenCalled()
  })
  it('middle-truncates long output', () => {
    const out = truncateToolResult([{ type: 'text', text: 'x'.repeat(100) }], 20)[0]
    expect(out?.type === 'text' && out.text).toContain('truncated')
  })
})
