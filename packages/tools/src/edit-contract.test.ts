import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { EditTool, MultiEditTool, type FileBackupPort } from './index'

const race = vi.hoisted(() => ({ path: '', bytes: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      await actual.rename(from, to)
      // simulate a concurrent writer landing immediately after our atomic write
      if (race.path && to === race.path) await actual.appendFile(to, race.bytes)
    },
  }
})

const dirs: string[] = []
afterEach(async () => {
  race.path = ''
  race.bytes = ''
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function fixture() {
  const cwd = await mkdtemp(resolve(tmpdir(), 'volund-edit-'))
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
const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((part) => part.text ?? '').join('')

describe('Edit contract (spec §4.3.2, r13-J3)', () => {
  it('schema: old_string/new_string required, replace_all optional, no unknown fields', () => {
    const schema = new EditTool().inputSchema as unknown as Record<string, unknown>
    expect(schema.required).toEqual(['path', 'old_string', 'new_string'])
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties as object)).toStrictEqual([
      'path',
      'old_string',
      'new_string',
      'replace_all',
    ])
  })

  it('rejects multiple matches and asks for longer context', async () => {
    const cwd = await fixture()
    await writeFile(resolve(cwd, 'dup.txt'), 'beta beta')
    const result = await new EditTool().invoke(
      { path: 'dup.txt', old_string: 'beta', new_string: 'B' },
      context(cwd),
    )
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('old_string matches 2 locations')
    expect(textOf(result)).toContain('provide a longer context to disambiguate')
    expect(await readFile(resolve(cwd, 'dup.txt'), 'utf8')).toBe('beta beta')
  })

  it('replace_all: true rewrites every match', async () => {
    const cwd = await fixture()
    await writeFile(resolve(cwd, 'dup.txt'), 'beta beta')
    const result = await new EditTool().invoke(
      { path: 'dup.txt', old_string: 'beta', new_string: 'B', replace_all: true },
      context(cwd),
    )
    expect(result.isError).toBeUndefined()
    expect(await readFile(resolve(cwd, 'dup.txt'), 'utf8')).toBe('B B')
  })

  it('reports not-found with the re-Read hint', async () => {
    const cwd = await fixture()
    await writeFile(resolve(cwd, 'miss.txt'), 'present')
    const result = await new EditTool().invoke(
      { path: 'miss.txt', old_string: 'absent', new_string: 'x' },
      context(cwd),
    )
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain(
      `old_string not found in ${resolve(cwd, 'miss.txt')} (file may have changed; re-Read)`,
    )
    expect(await readFile(resolve(cwd, 'miss.txt'), 'utf8')).toBe('present')
  })

  it('rejects a no-op edit (new_string === old_string)', async () => {
    const cwd = await fixture()
    await writeFile(resolve(cwd, 'noop.txt'), 'stable')
    const result = await new EditTool().invoke(
      { path: 'noop.txt', old_string: 'stable', new_string: 'stable' },
      context(cwd),
    )
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('no-op')
    expect(await readFile(resolve(cwd, 'noop.txt'), 'utf8')).toBe('stable')
  })

  it('lock conflict: reports the holder pid and leaves the file untouched', async () => {
    const cwd = await fixture()
    const target = resolve(cwd, 'locked.txt')
    await writeFile(target, 'before')
    await writeFile(`${target}.volundlock`, '4242 other-session\n')
    const result = await new EditTool().invoke(
      { path: 'locked.txt', old_string: 'before', new_string: 'after' },
      context(cwd),
    )
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('file locked by another volund session (pid 4242)')
    expect(await readFile(target, 'utf8')).toBe('before')
  }, 10_000)

  it('captures a backup before writing (§8.6 dual gate, second gate)', async () => {
    const cwd = await fixture()
    const target = resolve(cwd, 'backed.txt')
    await writeFile(target, 'before')
    const calls: string[] = []
    const backups: FileBackupPort = {
      async prepare(sessionId, paths) {
        calls.push(`prepare:${sessionId}:${paths.join(',')}`)
        return {
          commit: async () => {
            calls.push('commit')
          },
          rollback: async () => {
            calls.push('rollback')
          },
        }
      },
    }
    const result = await new EditTool(backups).invoke(
      { path: 'backed.txt', old_string: 'before', new_string: 'after' },
      context(cwd),
    )
    expect(result.isError).toBeUndefined()
    expect(calls).toEqual(['prepare:session-1:' + target, 'commit'])
    expect(await readFile(target, 'utf8')).toBe('after')
  })

  it('mtime+size gate: rejects when the file changed size since read', async () => {
    const cwd = await fixture()
    const target = resolve(cwd, 'stale-size.txt')
    await writeFile(target, 'version-one')
    const backups: FileBackupPort = {
      async prepare(_sessionId, paths) {
        const originals = await Promise.all(
          paths.map(async (path) => [path, await readFile(path)] as const),
        )
        await writeFile(paths[0]!, 'version-one-but-foreign-and-longer')
        return {
          commit: async () => {},
          rollback: async () => {
            for (const [path, bytes] of originals) await writeFile(path, bytes)
          },
        }
      },
    }
    const result = await new EditTool(backups).invoke(
      { path: 'stale-size.txt', old_string: 'version-one', new_string: 'edited' },
      context(cwd),
    )
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('changed since read')
    expect(textOf(result)).toContain('re-Read')
    expect(await readFile(target, 'utf8')).toBe('version-one')
  })

  it('mtime+size gate: rejects when only mtime changed since read', async () => {
    const cwd = await fixture()
    const target = resolve(cwd, 'stale-mtime.txt')
    await writeFile(target, 'version-one')
    const bumped = new Date(Date.now() + 5000)
    const backups: FileBackupPort = {
      async prepare() {
        await utimes(target, bumped, bumped)
        return { commit: async () => {}, rollback: async () => {} }
      },
    }
    const result = await new EditTool(backups).invoke(
      { path: 'stale-mtime.txt', old_string: 'version-one', new_string: 'edited' },
      context(cwd),
    )
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('changed since read')
    expect(await readFile(target, 'utf8')).toBe('version-one')
  })

  it('post-write gate: rolls the edit back when a concurrent writer lands after our write', async () => {
    const cwd = await fixture()
    const target = resolve(cwd, 'post.txt')
    await writeFile(target, 'original')
    race.path = target
    race.bytes = 'FOREIGN'
    const result = await new EditTool().invoke(
      { path: 'post.txt', old_string: 'original', new_string: 'edited' },
      context(cwd),
    )
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('concurrent modification')
    expect(await readFile(target, 'utf8')).toBe('original')
  })

  it('MultiEdit: spec field names, sequential application, all-or-nothing on no-op', async () => {
    const cwd = await fixture()
    await writeFile(resolve(cwd, 'a.txt'), 'alpha')
    await writeFile(resolve(cwd, 'b.txt'), 'beta beta')
    const result = await new MultiEditTool().invoke(
      {
        edits: [
          { path: 'a.txt', old_string: 'alpha', new_string: 'A' },
          { path: 'b.txt', old_string: 'beta', new_string: 'beta' },
        ],
      },
      context(cwd),
    )
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('no-op')
    expect(await readFile(resolve(cwd, 'a.txt'), 'utf8')).toBe('alpha')
    expect(await readFile(resolve(cwd, 'b.txt'), 'utf8')).toBe('beta beta')
  })
})

describe('line-change reporting (tool.completed ?linesAdded/?linesRemoved)', () => {
  it('diffLineCounts: multiset line diff, no inflation on rewrite or reorder', async () => {
    const { diffLineCounts } = await import('./index')
    expect(diffLineCounts('', '')).toEqual({ linesAdded: 0, linesRemoved: 0 })
    expect(diffLineCounts('a\nb\nc', 'a\nb\nc')).toEqual({ linesAdded: 0, linesRemoved: 0 })
    expect(diffLineCounts('a\nb\nc', 'a\nx\nc')).toEqual({ linesAdded: 1, linesRemoved: 1 })
    expect(diffLineCounts('a\nb', 'a\nb\nc\nd')).toEqual({ linesAdded: 2, linesRemoved: 0 })
    // 纯重排不算变更
    expect(diffLineCounts('a\nb', 'b\na')).toEqual({ linesAdded: 0, linesRemoved: 0 })
  })

  it('Edit reports replaced line counts in result meta', async () => {
    const cwd = await fixture()
    await writeFile(resolve(cwd, 'lines.txt'), 'one\ntwo\nthree\n')
    const result = await new EditTool().invoke(
      { path: 'lines.txt', old_string: 'two', new_string: '2\n2.5' },
      context(cwd),
    )
    expect(result.isError).toBeUndefined()
    // 'two' 移除；'2' 与 '2.5' 新增（多重集行 diff）
    expect(result.meta?.linesAdded).toBe(2)
    expect(result.meta?.linesRemoved).toBe(1)
  })

  it('Write reports full content for new files and diff for overwrites', async () => {
    const { WriteTool } = await import('./index')
    const cwd = await fixture()
    const created = await new WriteTool().invoke(
      { path: 'new.txt', content: 'a\nb\nc\n' },
      context(cwd),
    )
    expect(created.meta?.linesAdded).toBe(3)
    expect(created.meta?.linesRemoved).toBe(0)
    const overwritten = await new WriteTool().invoke(
      { path: 'new.txt', content: 'a\nx\nc\nd\n' },
      context(cwd),
    )
    expect(overwritten.meta?.linesAdded).toBe(2)
    expect(overwritten.meta?.linesRemoved).toBe(1)
  })

  it('MultiEdit sums line counts across files', async () => {
    const cwd = await fixture()
    await writeFile(resolve(cwd, 'a.txt'), 'alpha\nshared\n')
    await writeFile(resolve(cwd, 'b.txt'), 'beta\nshared\n')
    const result = await new MultiEditTool().invoke(
      {
        edits: [
          { path: 'a.txt', old_string: 'alpha', new_string: 'A1\nA2' },
          { path: 'b.txt', old_string: 'beta', new_string: 'B1\nB2\nB3' },
        ],
      },
      context(cwd),
    )
    expect(result.isError).toBeUndefined()
    // a.txt: 'alpha'→'A1\nA2'（+2/-1）；b.txt: 'beta'→'B1\nB2\nB3'（+3/-1）
    expect(result.meta?.linesAdded).toBe(5)
    expect(result.meta?.linesRemoved).toBe(2)
    expect(result.meta?.filesTouched).toHaveLength(2)
  })
})
