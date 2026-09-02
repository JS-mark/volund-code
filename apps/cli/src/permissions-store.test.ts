import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { PermissionRequest } from '@volund/permission'
import { PermissionManager } from '@volund/permission'
import type { Logger } from '@volund/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PermissionRuleStore } from './permissions-store'

const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

function spyLogger(): Record<keyof Logger, ReturnType<typeof vi.fn>> {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}

async function createStore(logger?: Logger) {
  const directory = await mkdtemp(join(tmpdir(), 'volund-permissions-store-'))
  fixtures.push(directory)
  const paths = {
    project: join(directory, '.volund', 'permissions.toml'),
    global: join(directory, 'home', 'permissions.toml'),
  }
  const store = new PermissionRuleStore({ ...paths, ...(logger ? { logger } : {}) })
  return { directory, paths, store }
}

const bashRequest = (command: string): PermissionRequest => ({
  toolName: 'Bash',
  spec: { bash: { command }, fs: { read: ['.'], write: ['.'] } },
  input: { command },
  session: { id: 's', cwd: process.cwd() },
  attempt: 1,
})

const netRequest = (url: string): PermissionRequest => ({
  toolName: 'WebFetch',
  spec: { net: { url, method: 'GET' } },
  input: { url },
  session: { id: 's', cwd: process.cwd() },
  attempt: 1,
})

describe('PermissionRuleStore', () => {
  it('persists allow-project to <project>/.volund/permissions.toml and reloads it in a fresh store', async () => {
    const { paths, store } = await createStore()
    await store.ready()
    await store.persist('project', bashRequest('git status'), true)

    const saved = await readFile(paths.project, 'utf8')
    expect(saved).toContain('"tool":"Bash"')

    const reloaded = new PermissionRuleStore(paths)
    await reloaded.ready()
    expect(reloaded.isAllowed('project', bashRequest('git status'))).toBe(true)
    expect(reloaded.isAllowed('project', bashRequest('git log'))).toBe(false)
    expect(reloaded.isDenied('project', bashRequest('git status'))).toBe(false)
  })

  it('persists deny-forever to the global file and the decision chain denies before prompting', async () => {
    const { store } = await createStore()
    await store.ready()
    await store.persist('global', bashRequest('curl evil.example'), false)

    const manager = new PermissionManager(
      {
        projectDeny: (request) => store.isDenied('project', request),
        globalDeny: (request) => store.isDenied('global', request),
        projectAllow: (request) => store.isAllowed('project', request),
        globalAllow: (request) => store.isAllowed('global', request),
      },
      { persist: (scope, request, allow) => store.persist(scope, request, allow) },
    )
    const prompt = vi.fn(async () => ({ kind: 'allow-once' as const }))
    manager.setPromptHandler(prompt)
    expect((await manager.request(bashRequest('curl evil.example'))).kind).toBe('deny')
    expect(prompt).not.toHaveBeenCalled()
  })

  it('shares net grants across paths of the same origin', async () => {
    const { store } = await createStore()
    await store.ready()
    await store.persist('global', netRequest('https://example.com/a'), true)
    expect(store.isAllowed('global', netRequest('https://example.com/b'))).toBe(true)
    expect(store.isAllowed('global', netRequest('https://other.example/a'))).toBe(false)
  })

  it('lets a newer decision supersede an older one for the same key', async () => {
    const { paths, store } = await createStore()
    await store.ready()
    await store.persist('project', bashRequest('pnpm test'), true)
    await store.persist('project', bashRequest('pnpm test'), false)
    expect(store.isAllowed('project', bashRequest('pnpm test'))).toBe(false)
    expect(store.isDenied('project', bashRequest('pnpm test'))).toBe(true)

    const reloaded = new PermissionRuleStore(paths)
    await reloaded.ready()
    expect(reloaded.isDenied('project', bashRequest('pnpm test'))).toBe(true)
    expect(reloaded.isAllowed('project', bashRequest('pnpm test'))).toBe(false)
  })

  it('round-trips bash commands containing # through the TOML file', async () => {
    const { paths, store } = await createStore()
    await store.ready()
    const command = 'pnpm test -- --filter "#tag"'
    await store.persist('global', bashRequest(command), true)

    const reloaded = new PermissionRuleStore(paths)
    await reloaded.ready()
    expect(reloaded.isAllowed('global', bashRequest(command))).toBe(true)
  })

  it('warns on a corrupt file, loads as empty, and refuses to overwrite it', async () => {
    const logger = spyLogger()
    const { directory, store } = await createStore(logger as unknown as Logger)
    const projectFile = join(directory, '.volund', 'permissions.toml')
    await mkdir(dirname(projectFile), { recursive: true })
    await writeFile(projectFile, 'allow = [{"tool": "Bash"', 'utf8')
    await store.ready()

    expect(store.isAllowed('project', bashRequest('git status'))).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('permissions.toml'))

    await store.persist('project', bashRequest('git status'), true)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('refusing to rewrite'))
    expect(await readFile(projectFile, 'utf8')).toBe('allow = [{"tool": "Bash"')
    // 内存决策仍然生效（本次进程内继续放行），只是没有落盘
    expect(store.isAllowed('project', bashRequest('git status'))).toBe(true)
  })
})
