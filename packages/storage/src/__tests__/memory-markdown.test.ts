import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DefaultMemoryMaintenanceService } from '../memory-index'
import {
  MarkdownMemoryLayout,
  MarkdownMemoryRepository,
  parseMemoryFile,
} from '../memory-markdown-repository'
import {
  DefaultMemoryService,
  LocalMemoryRepository,
  type MemoryRecord,
  type MemoryRecordScope,
} from '../memory-runtime'

const roots: string[] = []
const fixedNow = new Date('2026-10-09T08:30:00.000Z')

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function memoryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'volund-memory-markdown-'))
  roots.push(root)
  return root
}

function repository(root: string, options: { legacySnapshotPath?: string } = {}) {
  return new MarkdownMemoryRepository({
    layout: new MarkdownMemoryLayout({ root: join(root, 'memory') }),
    lockPath: join(root, 'memory', '.memory.lock'),
    ...options,
  })
}

const workspace = { kind: 'workspace', workspaceId: 'local' } as const
const project = { kind: 'project', workspaceId: 'local', projectId: 'volund' } as const
const otherProject = { kind: 'project', workspaceId: 'local', projectId: 'other' } as const
const session = {
  kind: 'session',
  workspaceId: 'local',
  projectId: 'volund',
  sessionId: 's-1',
} as const

function record(scope: MemoryRecordScope, id: string, content: string): MemoryRecord {
  return {
    schemaVersion: 1,
    id,
    scope,
    content,
    provenance: { source: 'user', actorId: 'mark' },
    attachments: [],
    tags: ['tooling'],
    pinned: false,
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
    deletedAt: null,
  }
}

describe('MarkdownMemoryRepository', () => {
  it('round-trips every record field through frontmatter and body', async () => {
    const root = await memoryRoot()
    const repo = repository(root)
    const original: MemoryRecord = {
      ...record(workspace, 'round-trip', '# Hooks order\n\n1. useState'),
      provenance: {
        source: 'import',
        actorId: 'plugin:x',
        sourceId: 'ext-1',
        importedFrom: { source: 'agent', actorId: 'model' },
      },
      attachments: [
        {
          schemaVersion: 1,
          id: 'att-1',
          handle: `${'a'.repeat(64)}.png`,
          mime: 'image/png',
          size: 12,
          digest: 'a'.repeat(64),
          state: 'active',
          createdAt: fixedNow.toISOString(),
          invalidatedAt: null,
          deletedAt: null,
        },
      ],
      tags: ['react', 'hooks'],
      pinned: true,
      deletedAt: null,
    }
    await repo.save([original])
    const loaded = await repo.load()
    expect(loaded).toEqual([original])
  })

  it('keeps content byte-exact including trailing newlines', async () => {
    const root = await memoryRoot()
    const repo = repository(root)
    await repo.save([
      record(workspace, 'no-newline', 'plain text'),
      record(workspace, 'with-newline', 'plain text\n'),
    ])
    const byId = new Map((await repo.load()).map((item) => [item.id, item.content]))
    expect(byId.get('no-newline')).toBe('plain text')
    expect(byId.get('with-newline')).toBe('plain text\n')
  })

  it('routes records to workspace, current-project, other-project, and session directories', async () => {
    const root = await memoryRoot()
    const layout = new MarkdownMemoryLayout({
      root: join(root, 'memory'),
      currentProjectId: 'volund',
      currentProjectDir: join(root, 'repo', '.volund', 'memory'),
    })
    const repo = new MarkdownMemoryRepository({
      layout,
      lockPath: join(root, 'memory', '.memory.lock'),
    })
    await repo.save([
      record(workspace, 'ws-1', 'workspace note'),
      record(project, 'proj-1', 'project note'),
      record(otherProject, 'proj-2', 'other note'),
      record(session, 'sess-1', 'session note'),
    ])
    const names = async (dir: string) => (await readdir(dir)).filter(recordFileFilter)
    expect(await names(join(root, 'memory'))).toHaveLength(1)
    expect(await names(join(root, 'repo', '.volund', 'memory'))).toHaveLength(1)
    expect(await names(join(root, 'memory', 'projects', 'other'))).toHaveLength(1)
    expect(await names(join(root, 'memory', 'sessions'))).toHaveLength(1)
  })

  it('loads hand-authored files, never deletes them, and reuses their path for edits', async () => {
    const root = await memoryRoot()
    const repo = repository(root)
    const handwritten = join(root, 'memory', 'my-own-note.md')
    await mkdir(join(root, 'memory'), { recursive: true, mode: 0o700 })
    await writeFile(
      handwritten,
      [
        '---',
        'schemaVersion: 1',
        'id: handwritten',
        'scope: workspace',
        'workspaceId: local',
        'createdAt: "2026-10-01T00:00:00.000Z"',
        'updatedAt: "2026-10-01T00:00:00.000Z"',
        '---',
        '### my own note',
        'body text',
        '',
      ].join('\n'),
    )
    const loaded = await repo.load()
    expect(loaded.map((item) => item.id)).toEqual(['handwritten'])
    expect(loaded[0]?.content).toBe('### my own note\nbody text\n')
    expect(loaded[0]?.provenance.source).toBe('user')

    // save() is full-set: keeping the loaded hand-authored record preserves its file.
    await repo.save([...loaded, record(workspace, 'fresh', 'fresh record')])
    expect(await readFile(handwritten, 'utf8')).toContain('my own note')

    const edited = loaded.map((item) =>
      item.id === 'handwritten'
        ? { ...item, content: '### my own note\nedited by volund\n' }
        : item,
    )
    await repo.save([...edited, record(workspace, 'fresh', 'fresh record')])
    expect(await readFile(handwritten, 'utf8')).toContain('edited by volund')
    expect(await repo.load().then((items) => items.map((item) => item.id).sort())).toEqual([
      'fresh',
      'handwritten',
    ])
  })

  it('picks the newest file when two files carry the same id', async () => {
    const root = await memoryRoot()
    const repo = repository(root)
    await repo.save([record(workspace, 'dup', 'older body')])
    const directory = join(root, 'memory')
    const canonical = (await readdir(directory)).filter(recordFileFilter).find(Boolean)
    expect(canonical).toBeDefined()
    const staleTime = new Date('2026-10-09T00:00:00.000Z')
    const freshTime = new Date('2026-10-09T12:00:00.000Z')
    await utimes(join(directory, canonical!), staleTime, staleTime)

    const duplicate = join(directory, '2026-10-09-renamed-dup.md')
    await writeFile(
      duplicate,
      [
        '---',
        'schemaVersion: 1',
        'id: dup',
        'scope: workspace',
        'workspaceId: local',
        'createdAt: "2026-10-09T00:00:00.000Z"',
        'updatedAt: "2026-10-09T12:00:00.000Z"',
        '---',
        'newer body',
      ].join('\n'),
    )
    await utimes(duplicate, freshTime, freshTime)

    const records = await repo.load()
    expect(records).toHaveLength(1)
    expect(records[0]?.content).toBe('newer body')
  })

  it('skips files with invalid frontmatter but leaves them on disk', async () => {
    const root = await memoryRoot()
    const repo = repository(root)
    const invalid = join(root, 'memory', 'broken.md')
    await mkdir(join(root, 'memory'), { recursive: true, mode: 0o700 })
    await writeFile(invalid, '---\nschemaVersion: 2\nid: broken\n---\nbody')
    await repo.save([record(workspace, 'good', 'good record')])
    const records = await repo.load()
    expect(records.map((item) => item.id)).toEqual(['good'])
    expect(await readFile(invalid, 'utf8')).toContain('schemaVersion: 2')
  })

  it('deletes the file of a removed record and keeps transaction failures back at the loaded state', async () => {
    const root = await memoryRoot()
    const repo = repository(root)
    await repo.save([record(workspace, 'keep', 'keep'), record(workspace, 'drop', 'drop')])
    await repo.save([record(workspace, 'keep', 'keep')])
    const names = (await readdir(join(root, 'memory'))).filter(recordFileFilter)
    expect(names).toHaveLength(1)

    await expect(
      repo.transaction(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect((await repo.load()).map((item) => item.id)).toEqual(['keep'])
  })

  it('relocates the file when a record moves to another scope', async () => {
    const root = await memoryRoot()
    const layout = new MarkdownMemoryLayout({
      root: join(root, 'memory'),
      currentProjectId: 'volund',
      currentProjectDir: join(root, 'repo', '.volund', 'memory'),
    })
    const repo = new MarkdownMemoryRepository({
      layout,
      lockPath: join(root, 'memory', '.state', '.memory.lock'),
    })
    const original = record(project, 'mover', 'project note')
    await repo.save([original])
    const projectFile = (await readdir(join(root, 'repo', '.volund', 'memory'))).filter(
      recordFileFilter,
    )
    expect(projectFile).toHaveLength(1)

    await repo.save([{ ...original, scope: workspace }])

    expect(
      (await readdir(join(root, 'repo', '.volund', 'memory'))).filter(recordFileFilter),
    ).toEqual([])
    const rootNames = (await readdir(join(root, 'memory'))).filter(recordFileFilter)
    expect(rootNames).toHaveLength(1)
    // Filename stayed stable; only the directory (and frontmatter scope) changed.
    expect(rootNames[0]).toBe(projectFile[0])
    const [moved] = await repo.load()
    expect(moved?.scope).toEqual(workspace)
  })

  it('exposes skipped files through diagnostics and doctor', async () => {
    const root = await memoryRoot()
    const repo = repository(root)
    await mkdir(join(root, 'memory'), { recursive: true, mode: 0o700 })
    const broken = join(root, 'memory', 'broken.md')
    await writeFile(broken, '---\nschemaVersion: 9\nid: broken\n---\nbody')
    await repo.save([record(workspace, 'good', 'good record')])
    await repo.load()

    const issues = repo.diagnostics()
    expect(issues).toHaveLength(1)
    expect(issues[0]?.path).toBe(broken)
    expect(issues[0]?.reason).toBe('invalid_frontmatter')

    const maintenance = new DefaultMemoryMaintenanceService(repo, {
      health: async () => ({ healthy: true, detail: 'ok', indexedRecords: 1 }),
      doctor: async () => ({ healthy: true, detail: 'ok', indexedRecords: 1 }),
      search: async () => [],
      reindex: async () => ({ healthy: true, detail: 'ok', indexedRecords: 1, batchCount: 0 }),
    } as never)
    const report = await maintenance.doctor()
    expect(report.issues).toEqual([{ path: broken, reason: 'invalid_frontmatter' }])
  })

  it('maintains a human MEMORY.md index per managed directory (never for sessions)', async () => {
    const root = await memoryRoot()
    const layout = new MarkdownMemoryLayout({
      root: join(root, 'memory'),
      currentProjectId: 'volund',
      currentProjectDir: join(root, 'repo', '.volund', 'memory'),
    })
    const repo = new MarkdownMemoryRepository({
      layout,
      lockPath: join(root, 'memory', '.state', '.memory.lock'),
    })
    await repo.save([
      { ...record(workspace, 'ws-1', 'Workspace preference line'), pinned: true },
      record(project, 'proj-1', 'Repo convention line'),
      record(session, 'sess-1', 'session note'),
    ])

    const wsIndex = await readFile(join(root, 'memory', 'MEMORY.md'), 'utf8')
    expect(wsIndex).toContain('Auto-generated by volund')
    expect(wsIndex).toMatch(/^- \[[^\]]+\]\([^)]+\.md\) — Workspace preference line `pinned`$/m)
    expect(wsIndex).not.toContain('sess-1')

    const projIndex = await readFile(join(root, 'repo', '.volund', 'memory', 'MEMORY.md'), 'utf8')
    expect(projIndex).toContain('Repo convention line')
    expect(await readdir(join(root, 'memory', 'sessions'))).not.toContain('MEMORY.md')

    // The index is not a record: loads ignore it, saves never sweep it.
    expect((await repo.load()).map((item) => item.id).sort()).toEqual(['proj-1', 'sess-1', 'ws-1'])
  })

  it('indexes hand-authored files once they become managed', async () => {
    const root = await memoryRoot()
    const repo = repository(root)
    await mkdir(join(root, 'memory'), { recursive: true, mode: 0o700 })
    const handwritten = join(root, 'memory', 'my-own-note.md')
    await writeFile(
      handwritten,
      '---\nschemaVersion: 1\nid: handwritten\nscope: workspace\nworkspaceId: local\n---\nmy own note\n',
    )
    await repo.load()
    await repo.save([...(await repo.load()), record(workspace, 'fresh', 'fresh record')])
    const index = await readFile(join(root, 'memory', 'MEMORY.md'), 'utf8')
    expect(index).toContain('my-own-note.md')
    expect(index).toContain('my own note')
    expect(index).toContain('fresh record')
  })

  it('migrates a legacy JSON snapshot once and archives it as records.json.imported', async () => {
    const root = await memoryRoot()
    const snapshotPath = join(root, 'memory', 'records.json')
    const legacy = new LocalMemoryRepository(snapshotPath)
    const legacyRecords = [
      record(workspace, 'legacy-ws', 'workspace legacy'),
      { ...record(project, 'legacy-proj', 'project legacy'), deletedAt: fixedNow.toISOString() },
    ]
    await legacy.save(legacyRecords)

    const repo = repository(root, { legacySnapshotPath: snapshotPath })
    expect(await repo.load()).toEqual(legacyRecords)
    await expect(stat(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(`${snapshotPath}.imported`, 'utf8')).toContain('legacy-ws')
    // workspace record lands in the root, the project record in its project dir
    expect((await readdir(join(root, 'memory'))).filter(recordFileFilter)).toHaveLength(1)
    expect(
      (await readdir(join(root, 'memory', 'projects', 'volund'))).filter(recordFileFilter),
    ).toHaveLength(1)

    // A second repository instance over the same home must not migrate again.
    const second = repository(root, { legacySnapshotPath: snapshotPath })
    expect(await second.load()).toEqual(legacyRecords)
  })

  it('works as the persistence behind DefaultMemoryService', async () => {
    const root = await memoryRoot()
    const service = new DefaultMemoryService(repository(root))
    await service.create({ ...recordInput(), id: 'svc-1' })
    await service.update(workspace, 'svc-1', { content: 'updated body' })
    const fetched = await service.get(workspace, 'svc-1')
    expect(fetched?.content).toBe('updated body')
    await service.delete(workspace, 'svc-1')
    // delete is a soft delete: get() still sees it, list() hides it.
    expect((await service.get(workspace, 'svc-1'))?.deletedAt).not.toBeNull()
    expect(await service.list(workspace)).toHaveLength(0)
  })
})

function recordFileFilter(name: string): boolean {
  return name.endsWith('.md') && name !== 'MEMORY.md'
}

function recordInput() {
  return {
    scope: workspace,
    content: 'initial body',
    provenance: { source: 'user' as const },
    tags: [],
    pinned: false,
  }
}

describe('DefaultMemoryService.gcSessions', () => {
  it('purges only aged session records, keeps fresh and other-scope records, and honors dryRun', async () => {
    const root = await memoryRoot()
    const epoch = new Date('2026-01-01T00:00:00.000Z')
    let clock = epoch.getTime()
    const memory = new DefaultMemoryService(
      new LocalMemoryRepository(join(root, 'records.json')),
      undefined,
      () => new Date(clock),
    )
    const oldSession = {
      kind: 'session',
      workspaceId: 'local',
      projectId: 'p',
      sessionId: 'old',
    } as const
    const freshSession = {
      kind: 'session',
      workspaceId: 'local',
      projectId: 'p',
      sessionId: 'fresh',
    } as const
    await memory.create({
      scope: oldSession,
      id: 'old-memo',
      content: 'old',
      provenance: { source: 'user' },
    })
    clock += 90 * 86_400_000
    await memory.create({
      scope: freshSession,
      id: 'fresh-memo',
      content: 'fresh',
      provenance: { source: 'user' },
    })
    await memory.create({
      scope: workspace,
      id: 'ws-memo',
      content: 'ws',
      provenance: { source: 'user' },
    })
    // Soft delete bumps updatedAt to the delete moment — the purge clock runs from there.
    await memory.delete(oldSession, 'old-memo')
    clock += 90 * 86_400_000
    // Touch the fresh record so it survives the cutoff; workspace records are
    // never candidates regardless of age.
    await memory.update(freshSession, 'fresh-memo', { pinned: true })

    const cutoff = new Date(clock - 60 * 86_400_000).toISOString()
    const dry = await memory.gcSessions(cutoff, { dryRun: true })
    expect(dry.purged.map((item) => item.id)).toEqual(['old-memo'])
    expect(await memory.list(oldSession, { includeDeleted: true })).toHaveLength(1)

    const report = await memory.gcSessions(cutoff)
    expect(report.purged.map((item) => item.id)).toEqual(['old-memo'])
    expect(await memory.list(oldSession, { includeDeleted: true })).toEqual([])
    expect(await memory.list(freshSession)).toHaveLength(1)
    expect(await memory.list(workspace)).toHaveLength(1)
  })
})

describe('parseMemoryFile', () => {
  it('falls back to mtime for missing timestamps and defaults provenance', () => {
    const record = parseMemoryFile(
      [
        '---',
        'schemaVersion: 1',
        'id: minimal',
        'scope: workspace',
        'workspaceId: local',
        '---',
        'body',
      ].join('\n'),
      fixedNow.getTime(),
    )
    expect(record).toMatchObject({
      id: 'minimal',
      content: 'body',
      tags: [],
      pinned: false,
      deletedAt: null,
      provenance: { source: 'user' },
    })
    expect(record?.createdAt).toBe(fixedNow.toISOString())
  })

  it('rejects unknown scopes, bad ids, and non-object frontmatter', () => {
    const wrap = (frontmatter: string) => `---\n${frontmatter}\n---\nbody`
    expect(
      parseMemoryFile(wrap('schemaVersion: 1\nid: x\nscope: team\nworkspaceId: l'), 0),
    ).toBeNull()
    expect(
      parseMemoryFile(wrap('schemaVersion: 1\nid: "-bad"\nscope: workspace\nworkspaceId: l'), 0),
    ).toBeNull()
    expect(parseMemoryFile('just text', 0)).toBeNull()
    expect(parseMemoryFile('---\n[1, 2]\n---\nbody', 0)).toBeNull()
  })
})
