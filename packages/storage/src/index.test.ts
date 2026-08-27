import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { DefaultPromptComposer } from '@volund/core'
import { PermissionManager } from '@volund/permission'
import { afterEach, describe, expect, it } from 'vitest'

import { AttachmentStore, BackupStore, PromptLoader, SessionStore } from './index'
const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function temp() {
  const dir = await mkdtemp(resolve(tmpdir(), 'volund-storage-'))
  dirs.push(dir)
  return dir
}
describe('SessionStore', () => {
  it('writes v first, skips deltas, fsyncs append-only records', async () => {
    const dir = await temp(),
      path = resolve(dir, 's.jsonl'),
      store = new SessionStore(path)
    await store.appendCore({
      id: '1',
      type: 'stream.delta',
      version: 1,
      sessionId: 's',
      payload: {},
      at: 0,
    })
    await store.append({
      v: 1,
      id: '2',
      type: 'message.appended',
      sessionId: 's',
      at: 'now',
      payload: { text: 'ok' },
    })
    const line = await readFile(path, 'utf8')
    expect(line.startsWith('{"v":1')).toBe(true)
    expect(line).not.toContain('stream.delta')
  })
  it('rejects inline attachment bytes', async () => {
    const store = new SessionStore(resolve(await temp(), 's.jsonl'))
    await expect(
      store.append({
        v: 1,
        id: 'x',
        type: 'x',
        sessionId: 's',
        at: '',
        payload: { bytes: new Uint8Array([1]) } as never,
      }),
    ).rejects.toThrow('Binary')
  })
  it('persists and resumes attachment handles without binary data', async () => {
    const path = resolve(await temp(), 's.jsonl')
    const store = new SessionStore(path)
    await store.append({
      v: 1,
      id: 'image',
      type: 'session.snapshot',
      sessionId: 's',
      at: 'now',
      payload: {
        content: [
          {
            type: 'image',
            mime: 'image/png',
            source: { kind: 'handle', handle: `${'a'.repeat(64)}.png` },
          },
        ],
      },
    })
    expect(await store.resume()).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ content: [expect.objectContaining({ type: 'image' })] }),
      }),
    ])
    expect(await readFile(path, 'utf8')).not.toContain('bytes')
  })
})
describe('AttachmentStore', () => {
  it('stages content-addressed images and reloads handle references', async () => {
    const dir = await temp()
    const store = new AttachmentStore(resolve(dir, 'attachments'))
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const staged = await store.stage(bytes, 'image/png')
    expect(staged.handle).toMatch(/^[a-f0-9]{64}\.png$/)
    expect(await store.read({ kind: 'handle', handle: staged.handle })).toEqual(bytes)
    expect(
      await new AttachmentStore(resolve(dir, 'attachments')).read({
        kind: 'handle',
        handle: staged.handle,
      }),
    ).toEqual(bytes)
  })
  it('rejects corrupt, unsupported, oversized, and forged handle inputs', async () => {
    const store = new AttachmentStore(resolve(await temp(), 'attachments'), 4)
    await expect(store.stage(Uint8Array.from([1]), 'image/png')).rejects.toThrow('match MIME')
    await expect(store.stage(Uint8Array.from([1]), 'image/svg+xml')).rejects.toThrow('Unsupported')
    await expect(
      store.stage(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1]), 'image/png'),
    ).rejects.toThrow('size limit')
    await expect(store.read({ kind: 'handle', handle: '../secret.png' })).rejects.toThrow('Invalid')
    await expect(store.read({ kind: 'path', absPath: import.meta.filename })).rejects.toThrow(
      'outside allowed roots',
    )
  })
})
describe('BackupStore', () => {
  it('restores the original version after repeated mutations and is idempotent', async () => {
    const dir = await temp(),
      target = resolve(dir, 'project.txt'),
      store = new BackupStore(resolve(dir, 'backups'))
    await writeFile(target, 'original')
    const first = await store.prepare('session-1', [target])
    await writeFile(target, 'one')
    await first.commit()
    const second = await store.prepare('session-1', [target])
    await writeFile(target, 'two')
    await second.commit()
    expect((await store.restore('session-1', { dryRun: true })).restored).toEqual([target])
    await store.restore('session-1')
    expect(await readFile(target, 'utf8')).toBe('original')
    expect((await store.restore('session-1')).conflicts).toEqual([])
    expect(await readFile(target, 'utf8')).toBe('original')
  })

  it('refuses conflicts and reports missing or corrupt manifests', async () => {
    const dir = await temp(),
      target = resolve(dir, 'project.txt'),
      store = new BackupStore(resolve(dir, 'backups'))
    expect((await store.restore('unknown')).missing).toBe(true)
    await writeFile(target, 'before')
    const transaction = await store.prepare('session-2', [target])
    await writeFile(target, 'after')
    await transaction.commit()
    await writeFile(target, 'external change')
    expect((await store.restore('session-2')).conflicts).toEqual([target])
    await writeFile(resolve(dir, 'backups', 'session-2', 'manifest.json'), '{broken')
    await expect(store.restore('session-2')).rejects.toThrow('corrupt')
  })

  it('rolls back new and existing files when a mutation is interrupted', async () => {
    const dir = await temp(),
      existing = resolve(dir, 'existing.txt'),
      created = resolve(dir, 'created.txt'),
      store = new BackupStore(resolve(dir, 'backups'))
    await writeFile(existing, 'before')
    const transaction = await store.prepare('session-3', [existing, created])
    await writeFile(existing, 'partial')
    await writeFile(created, 'partial')
    await transaction.rollback()
    expect(await readFile(existing, 'utf8')).toBe('before')
    await expect(readFile(created, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails before mutation when backup storage is unavailable and garbage-collects by size', async () => {
    const dir = await temp(),
      target = resolve(dir, 'project.txt'),
      invalidRoot = resolve(dir, 'not-a-directory')
    await writeFile(target, 'before')
    await writeFile(invalidRoot, 'file')
    await expect(new BackupStore(invalidRoot).prepare('session-4', [target])).rejects.toThrow()
    expect(await readFile(target, 'utf8')).toBe('before')

    const root = resolve(dir, 'gc'),
      store = new BackupStore(root, { maxBytes: 1 })
    const transaction = await store.prepare('session-5', [target])
    await writeFile(target, 'after')
    await transaction.commit()
    await expect(access(resolve(root, 'session-5'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('BackupStore /undo selection rules (r13-G4)', () => {
  it('undoes one step per call in reverse order and reports no_backup when exhausted', async () => {
    const dir = await temp(),
      target = resolve(dir, 'project.txt'),
      store = new BackupStore(resolve(dir, 'backups'))
    await writeFile(target, 'v0')
    const first = await store.prepare('session-undo', [target])
    await writeFile(target, 'v1')
    await first.commit()
    const second = await store.prepare('session-undo', [target])
    await writeFile(target, 'v2')
    await second.commit()
    // Read-only tools (Read/Grep/Glob) ran after the last write: they touch
    // nothing in the manifest — selection sees only backup entries, so reads
    // are skipped naturally and still target the newest backup entry.
    expect(await readFile(target, 'utf8')).toBe('v2')
    const undo1 = await store.undoStep('session-undo')
    expect(undo1.undone).toBe(true)
    expect(undo1.paths).toEqual([target])
    expect(undo1.warnings).toEqual([])
    expect(await readFile(target, 'utf8')).toBe('v1')
    const undo2 = await store.undoStep('session-undo')
    expect(undo2.undone).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('v0')
    const undo3 = await store.undoStep('session-undo')
    expect(undo3.undone).toBe(false)
    expect(undo3.reason).toBe('no_backup')
    expect(undo3.paths).toEqual([])
    expect(undo3.warnings).toEqual([])
  })

  it('reports no_backup for a session without any backup entries', async () => {
    const store = new BackupStore(resolve(await temp(), 'backups'))
    expect(await store.undoStep('never-seen')).toMatchObject({
      undone: false,
      reason: 'no_backup',
    })
  })

  it('warns but still restores when the target was externally modified after the backup', async () => {
    const dir = await temp(),
      target = resolve(dir, 'project.txt'),
      store = new BackupStore(resolve(dir, 'backups'))
    await writeFile(target, 'before')
    const transaction = await store.prepare('session-mtime', [target])
    await writeFile(target, 'after')
    await transaction.commit()
    // External manual change after the backup: content matches neither the
    // recorded before- nor after-state and mtime is past the backup time.
    await writeFile(target, 'manual edit')
    await utimes(target, new Date(), new Date(Date.now() + 60_000))
    const outcome = await store.undoStep('session-mtime')
    expect(outcome.undone).toBe(true)
    expect(outcome.warnings).toEqual([{ path: target, kind: 'target_modified' }])
    expect(await readFile(target, 'utf8')).toBe('before')
  })

  it('warns when the backup object is missing yet consumes the step', async () => {
    const dir = await temp(),
      target = resolve(dir, 'project.txt'),
      store = new BackupStore(resolve(dir, 'backups'))
    await writeFile(target, 'before')
    const transaction = await store.prepare('session-missing', [target])
    await writeFile(target, 'after')
    await transaction.commit()
    const manifest = JSON.parse(
      await readFile(resolve(dir, 'backups', 'session-missing', 'manifest.json'), 'utf8'),
    ) as { records: Array<{ backupPath: string }> }
    await rm(manifest.records[0]!.backupPath)
    const outcome = await store.undoStep('session-missing')
    expect(outcome.undone).toBe(true)
    expect(outcome.warnings).toEqual([{ path: target, kind: 'backup_missing' }])
    expect(await readFile(target, 'utf8')).toBe('after')
    // The consumed step is never retried even though nothing was restored from it.
    expect(await store.undoStep('session-missing')).toMatchObject({ undone: false })
  })

  it('removes files that the undone tool run created', async () => {
    const dir = await temp(),
      created = resolve(dir, 'created.txt'),
      store = new BackupStore(resolve(dir, 'backups'))
    const transaction = await store.prepare('session-create', [created])
    await writeFile(created, 'new content')
    await transaction.commit()
    const outcome = await store.undoStep('session-create')
    expect(outcome.undone).toBe(true)
    expect(outcome.paths).toEqual([created])
    await expect(readFile(created, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('undoes multi-file batches as one step and groups legacy records by createdAt', async () => {
    const dir = await temp(),
      one = resolve(dir, 'one.txt'),
      two = resolve(dir, 'two.txt'),
      root = resolve(dir, 'backups')
    // MultiEdit-style batch: two records sharing one commit must undo together.
    await writeFile(one, 'one-v0')
    await writeFile(two, 'two-v0')
    const store = new BackupStore(root)
    const batch = await store.prepare('session-multi', [one, two])
    await writeFile(one, 'one-v1')
    await writeFile(two, 'two-v1')
    await batch.commit()
    const outcome = await store.undoStep('session-multi')
    expect(outcome.paths).toEqual([one, two])
    expect(await readFile(one, 'utf8')).toBe('one-v0')
    expect(await readFile(two, 'utf8')).toBe('two-v0')

    // Legacy manifest without stepId: batches are identified by createdAt.
    const legacyRoot = resolve(dir, 'legacy')
    const legacyOne = resolve(dir, 'legacy-one.txt'),
      legacyTwo = resolve(dir, 'legacy-two.txt')
    const manifest = {
      v: 1,
      sessionId: 'legacy-sess',
      records: [
        {
          path: legacyTwo,
          existed: false,
          afterHash: 'b'.repeat(64),
          createdAt: '2026-08-16T10:00:02.000Z',
        },
        {
          path: legacyOne,
          existed: false,
          afterHash: 'a'.repeat(64),
          createdAt: '2026-08-16T10:00:01.000Z',
        },
      ],
    }
    await mkdir(resolve(legacyRoot, 'legacy-sess'), { recursive: true })
    await writeFile(
      resolve(legacyRoot, 'legacy-sess', 'manifest.json'),
      `${JSON.stringify(manifest)}\n`,
    )
    await writeFile(legacyOne, 'later')
    await writeFile(legacyTwo, 'later')
    const legacyStore = new BackupStore(legacyRoot)
    const first = await legacyStore.undoStep('legacy-sess')
    expect(first.undone).toBe(true)
    expect(first.paths).toEqual([legacyTwo])
    await expect(readFile(legacyTwo, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(legacyOne, 'utf8')).toBe('later')
    const second = await legacyStore.undoStep('legacy-sess')
    expect(second.undone).toBe(true)
    expect(second.paths).toEqual([legacyOne])
    await expect(readFile(legacyOne, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never targets Bash-made changes: they create no backup entries (out of scope)', async () => {
    const dir = await temp(),
      target = resolve(dir, 'bash-only.txt'),
      store = new BackupStore(resolve(dir, 'backups'))
    // A session where only Bash touched the file system: no Write/Edit ran, so
    // the backup manifest has no entries for it.
    await writeFile(target, 'bash wrote this')
    const outcome = await store.undoStep('session-bash-only')
    expect(outcome).toMatchObject({ undone: false, reason: 'no_backup' })
    // Nothing was reverted: Bash recovery is out of scope and relies on git.
    expect(await readFile(target, 'utf8')).toBe('bash wrote this')
  })

  it('restores the tracked Write backup even when Bash later edited the same file', async () => {
    const dir = await temp(),
      target = resolve(dir, 'project.txt'),
      store = new BackupStore(resolve(dir, 'backups'))
    await writeFile(target, 'before-write')
    const transaction = await store.prepare('session-bash-mixed', [target])
    await writeFile(target, 'tool wrote')
    await transaction.commit()
    // Bash edits the file outside the backup-tracked Write/Edit/MultiEdit path.
    await writeFile(target, 'bash edited')
    const outcome = await store.undoStep('session-bash-mixed')
    // The undo target is still the tracked Write step; the Bash edit is simply
    // overwritten by the restore (spec: Bash changes are not undo targets).
    expect(outcome.undone).toBe(true)
    expect(outcome.paths).toEqual([target])
    expect(outcome.warnings).toEqual([{ path: target, kind: 'target_modified' }])
    expect(await readFile(target, 'utf8')).toBe('before-write')
  })
})
describe('PromptLoader', () => {
  it('loads AGENT over CLAUDE and expands safe includes', async () => {
    const dir = await temp()
    await writeFile(resolve(dir, 'AGENT.md'), '@include ./rules.md')
    await writeFile(resolve(dir, 'CLAUDE.md'), 'wrong')
    await writeFile(resolve(dir, 'rules.md'), 'rules')
    const permissions = new PermissionManager(),
      composer = new DefaultPromptComposer()
    await new PromptLoader({
      cwd: dir,
      volundHome: resolve(dir, '.volund'),
      permissions,
    }).registerProject(composer)
    const prompt = await composer.compose({ cwd: dir, model: 'm', provider: 'p' })
    expect(prompt).toContain('rules')
    expect(prompt).not.toContain('wrong')
  })
  it('leaves a denial placeholder for sensitive includes', async () => {
    const dir = await temp()
    await writeFile(resolve(dir, 'AGENT.md'), '@include ./.env.md')
    await writeFile(resolve(dir, '.env.md'), 'SECRET')
    const loader = new PromptLoader({
      cwd: dir,
      volundHome: resolve(dir, '.volund'),
      permissions: new PermissionManager(),
    })
    expect(await loader.load(resolve(dir, 'AGENT.md'))).toContain('DENIED (sensitive)')
  })
  it('recognizes Windows separators in sensitive include paths', async () => {
    const dir = await temp()
    const loader = new PromptLoader({
      cwd: dir,
      volundHome: resolve(dir, '.volund'),
      permissions: new PermissionManager(),
    })
    expect(await loader.load(`${dir.replaceAll('/', '\\')}\\.env.md`)).toContain(
      'DENIED (sensitive)',
    )
  })
})
