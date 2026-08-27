import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DefaultMemoryService, LocalMemoryRepository } from './memory-runtime'

// LL-7 regression tests: on loaded Windows runners the memory transaction lock
// races with competing processes creating/removing the lock file, and open or
// unlink surface transient EPERM/EACCES/EBUSY errors instead of EEXIST. Those
// must be retried inside the lock budget (or treated as released), never
// escalated to a fatal `Unable to persist memory`.

const lockState = vi.hoisted(() => ({
  path: '',
  openFailures: [] as string[],
  rmFailures: [] as string[],
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const injectedError = (code: string) =>
    Object.assign(new Error(`injected lock failure: ${code}`), { code })
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const [path, flags] = args
      if (
        typeof path === 'string' &&
        path === lockState.path &&
        typeof flags === 'string' &&
        flags.includes('x') &&
        lockState.openFailures.length > 0
      ) {
        throw injectedError(lockState.openFailures.shift()!)
      }
      return actual.open(...args)
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const [path] = args
      if (typeof path === 'string' && path === lockState.path && lockState.rmFailures.length > 0) {
        const code = lockState.rmFailures.shift()!
        // Model Windows delete-pending: the removal takes effect even though
        // the call itself surfaces a transient error.
        await actual.rm(...args).catch(() => undefined)
        throw injectedError(code)
      }
      return actual.rm(...args)
    },
  }
})

const roots: string[] = []
const project = { kind: 'project', workspaceId: 'ws', projectId: 'volund' } as const

afterEach(async () => {
  lockState.path = ''
  lockState.openFailures.length = 0
  lockState.rmFailures.length = 0
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function prepare(failures: { open?: string[]; rm?: string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'volund-memory-lock-'))
  roots.push(root)
  const file = join(root, 'memory', 'records.json')
  lockState.path = `${file}.lock`
  lockState.openFailures.push(...(failures.open ?? []))
  lockState.rmFailures.push(...(failures.rm ?? []))
  return file
}

describe('LocalMemoryRepository transient lock errors', () => {
  it('retries transient access failures while acquiring the lock', async () => {
    const file = await prepare({ open: ['EPERM', 'EBUSY', 'EACCES'] })
    const service = new DefaultMemoryService(new LocalMemoryRepository(file, { lockRetryMs: 1 }))
    await expect(
      service.create({
        scope: project,
        content: 'Use pnpm',
        provenance: { source: 'user', actorId: 'alice' },
        id: 'resilient',
      }),
    ).resolves.toMatchObject({ id: 'resilient' })
    expect(lockState.openFailures).toHaveLength(0)
    expect(await new LocalMemoryRepository(file).load()).toMatchObject([{ id: 'resilient' }])
    await expect(access(lockState.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('treats a transient failure while releasing the lock as released', async () => {
    const file = await prepare({ rm: ['EPERM'] })
    const service = new DefaultMemoryService(new LocalMemoryRepository(file, { lockRetryMs: 1 }))
    await expect(
      service.create({
        scope: project,
        content: 'Use pnpm',
        provenance: { source: 'user', actorId: 'alice' },
        id: 'released',
      }),
    ).resolves.toMatchObject({ id: 'released' })
    expect(lockState.rmFailures).toHaveLength(0)
    expect(await new LocalMemoryRepository(file).load()).toMatchObject([{ id: 'released' }])
    await expect(access(lockState.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails with the lock timeout error, not a fatal persist error, when retries outlast the budget', async () => {
    const file = await prepare({ open: Array.from({ length: 1000 }, () => 'EACCES') })
    const service = new DefaultMemoryService(
      new LocalMemoryRepository(file, { lockTimeoutMs: 50, lockRetryMs: 5 }),
    )
    const failure = await service
      .create({
        scope: project,
        content: 'Use pnpm',
        provenance: { source: 'user', actorId: 'alice' },
        id: 'starved',
      })
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'memory_io' })
    expect((failure as Error).message).toContain(
      'Timed out waiting for the memory transaction lock',
    )
    expect((failure as { cause?: { code?: string } }).cause).toMatchObject({ code: 'EACCES' })
  }, 10_000)
})
