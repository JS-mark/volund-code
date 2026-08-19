import { describe, expect, it, vi } from 'vitest'

import { PermissionManager } from './index'
const req = (toolName = 'Write') => ({
  toolName,
  spec: { fs: { write: ['x'] } },
  input: {},
  session: { id: 's', cwd: process.cwd() },
  attempt: 1,
})
const bashReq = (command: string) => ({
  toolName: 'Bash',
  spec: { bash: { command } },
  input: {},
  session: { id: 's', cwd: process.cwd() },
  attempt: 1,
})

const FORMERLY_SILENT_BASH_COMMANDS = [
  'pwd',
  'ls',
  'git status',
  'git diff',
  'git log',
  'node --version',
  'pnpm test',
  'pnpm typecheck',
]

const BASH_CONTROL_CORPUS = [
  'git status; unknown-command',
  'git status && unknown-command',
  'git status || unknown-command',
  'git status | unknown-command',
  'git status < input.txt',
  'git status > output.txt',
  'git status >> output.txt',
  'git status `unknown-command`',
  'git status $(unknown-command)',
  'git status\nunknown-command',
  'git status\r\nunknown-command',
  'git\u00a0status',
  'git status "&&" unknown-command',
  'unknown-command --flag',
  'gh pr create',
  'gh pr view 123',
  'gh pr checks 123',
]

const RAW_BASH_CORPUS = [...FORMERLY_SILENT_BASH_COMMANDS, ...BASH_CONTROL_CORPUS]

describe('PermissionManager', () => {
  it('uses strict decision order', async () => {
    const prompt = vi.fn()
    const manager = new PermissionManager({ projectDeny: () => true, globalAllow: () => true })
    manager.setPromptHandler(prompt)
    expect((await manager.request(req())).kind).toBe('deny')
    expect(prompt).not.toHaveBeenCalled()
  })
  it('serializes prompts and caches session grants', async () => {
    let active = 0,
      max = 0
    const manager = new PermissionManager()
    manager.setPromptHandler(async () => {
      active++
      max = Math.max(max, active)
      await Promise.resolve()
      active--
      return { kind: 'allow-session' }
    })
    await Promise.all([manager.request(req()), manager.request(req('Edit'))])
    expect(max).toBe(1)
    expect((await manager.request(req())).kind).toBe('allow-session')
  })
  it('conservatively auto-allows cwd reads', async () => {
    const manager = new PermissionManager()
    expect(
      (
        await manager.request({
          toolName: 'Read',
          spec: { fs: { read: ['package.json'] } },
          input: {},
          session: { id: 's', cwd: process.cwd() },
          attempt: 1,
        })
      ).kind,
    ).toBe('allow-session')
  })
  it('prompts for every raw Bash command, including shell-control edge cases', async () => {
    const prompt = vi.fn(async () => ({ kind: 'deny' as const }))
    const manager = new PermissionManager()
    manager.setPromptHandler(prompt)

    for (const [index, command] of RAW_BASH_CORPUS.entries()) {
      const decision = await manager.request(bashReq(command))
      expect(decision).toEqual({ kind: 'deny' })
      expect(decision.kind).not.toBe('allow-once')
      expect(prompt).toHaveBeenCalledTimes(index + 1)
      expect(prompt).toHaveBeenLastCalledWith(bashReq(command))
    }
  })

  it('denies every ungranted raw Bash command when no prompt is available', async () => {
    const manager = new PermissionManager()

    for (const command of RAW_BASH_CORPUS) {
      expect(await manager.request(bashReq(command))).toEqual({ kind: 'deny' })
    }
  })

  it('honors explicit project and global Bash grants without prompting', async () => {
    const prompt = vi.fn(async () => ({ kind: 'deny' as const }))
    const project = new PermissionManager({ projectAllow: () => true })
    const global = new PermissionManager({ globalAllow: () => true })
    project.setPromptHandler(prompt)
    global.setPromptHandler(prompt)

    expect(await project.request(bashReq('git status'))).toEqual({ kind: 'allow-project' })
    expect(await global.request(bashReq('pnpm test'))).toEqual({ kind: 'allow-forever' })
    expect(prompt).not.toHaveBeenCalled()
  })

  it('records prompted Bash grants and caches only an explicit session decision', async () => {
    const persist = vi.fn(async () => undefined)
    const project = new PermissionManager({}, { persist })
    project.setPromptHandler(async () => ({ kind: 'allow-project' }))
    const projectRequest = bashReq('git status')

    expect(await project.request(projectRequest)).toEqual({ kind: 'allow-project' })
    expect(persist).toHaveBeenCalledWith('project', projectRequest, true)

    const global = new PermissionManager({}, { persist })
    global.setPromptHandler(async () => ({ kind: 'allow-forever' }))
    const globalRequest = bashReq('pnpm test')

    expect(await global.request(globalRequest)).toEqual({ kind: 'allow-forever' })
    expect(persist).toHaveBeenCalledWith('global', globalRequest, true)

    const prompt = vi.fn(async () => ({ kind: 'allow-session' as const }))
    const session = new PermissionManager()
    session.setPromptHandler(prompt)
    const sessionRequest = bashReq('pwd')

    expect(await session.request(sessionRequest)).toEqual({ kind: 'allow-session' })
    expect(await session.request(sessionRequest)).toEqual({ kind: 'allow-session' })
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('keeps the explicit dangerous bypass after deny rules and logs its use', async () => {
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }
    const bypass = new PermissionManager({}, { dangerouslySkip: true, logger })
    const prompt = vi.fn(async () => ({ kind: 'deny' as const }))
    bypass.setPromptHandler(prompt)

    expect(await bypass.request(bashReq('git status'))).toEqual({ kind: 'allow-once' })
    expect(logger.warn).toHaveBeenCalledWith('permissions bypassed', { toolName: 'Bash' })
    expect(prompt).not.toHaveBeenCalled()

    const denied = new PermissionManager(
      { globalDeny: () => true },
      { dangerouslySkip: true, logger },
    )
    expect(await denied.request(bashReq('git status'))).toEqual({ kind: 'deny' })
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })
  it('caches network grants by canonical origin, not secret-bearing paths', async () => {
    const prompt = vi.fn(async () => ({ kind: 'allow-session' as const }))
    const manager = new PermissionManager()
    manager.setPromptHandler(prompt)
    const network = (url: string) => ({
      toolName: 'WebFetch',
      spec: { net: { url, method: 'GET' as const } },
      input: { url: `${url}/path?token=secret` },
      session: { id: 's', cwd: process.cwd() },
      attempt: 1,
    })
    expect((await manager.request(network('https://example.com'))).kind).toBe('allow-session')
    expect((await manager.request(network('https://example.com/other'))).kind).toBe('allow-session')
    expect(prompt).toHaveBeenCalledTimes(1)
    expect((await manager.request(network('https://other.example'))).kind).toBe('allow-session')
    expect(prompt).toHaveBeenCalledTimes(2)
  })
  it('shares session grants across explicit default ports and non-special schemes', async () => {
    const prompt = vi.fn(async () => ({ kind: 'allow-session' as const }))
    const manager = new PermissionManager()
    manager.setPromptHandler(prompt)
    const network = (url: string) => ({
      toolName: 'WebFetch',
      spec: { net: { url, method: 'GET' as const } },
      input: {},
      session: { id: 's', cwd: process.cwd() },
      attempt: 1,
    })
    expect((await manager.request(network('https://example.com:443/a'))).kind).toBe('allow-session')
    // same origin modulo the default port → cache hit, no second prompt
    expect((await manager.request(network('https://example.com/b'))).kind).toBe('allow-session')
    expect(prompt).toHaveBeenCalledTimes(1)
    // non-special scheme keeps its port in the origin key (URL.origin would be "null")
    expect((await manager.request(network('git://example.com:9418/x'))).kind).toBe('allow-session')
    expect((await manager.request(network('git://example.com:9418/y'))).kind).toBe('allow-session')
    expect(prompt).toHaveBeenCalledTimes(2)
  })
})
