import { describe, expect, it, vi } from 'vitest'

import { PermissionManager, type PermissionRequest } from './index'
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
const grantKey = (request: PermissionRequest) => JSON.stringify([request.toolName, request.spec])

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
  'git status & unknown-command',
  'git status < input.txt',
  'git status > output.txt',
  'git status >> output.txt',
  "cat <<'EOF'\ngit status\nEOF",
  'cat <<< "git status"',
  'cat <(git status)',
  'git status `unknown-command`',
  'git status $(unknown-command)',
  'git status \\\nunknown-command',
  'git\tstatus',
  'git status\nunknown-command',
  'git status\runknown-command',
  'git status\r\nunknown-command',
  'git status\u0085unknown-command',
  'git\u00a0status',
  'git status\u2028unknown-command',
  'git status\u2029unknown-command',
  'git status\u202eunknown-command',
  'git\u200bstatus',
  'git status "&&" unknown-command',
  'unknown-command --flag',
  'gh pr create',
  'gh pr view 123',
  'gh pr checks 123',
]

const RAW_BASH_CORPUS = [...FORMERLY_SILENT_BASH_COMMANDS, ...BASH_CONTROL_CORPUS]

describe('PermissionManager', () => {
  it('puts project and global deny rules above session cache and explicit allows', async () => {
    let projectDeny = false
    let projectAllow = false
    let globalAllow = false
    const configuration = { dangerouslySkip: false }
    const cachedPrompt = vi.fn(async () => ({ kind: 'allow-session' as const }))
    const cached = new PermissionManager(
      {
        projectDeny: () => projectDeny,
        projectAllow: () => projectAllow,
        globalAllow: () => globalAllow,
      },
      configuration,
    )
    cached.setPromptHandler(cachedPrompt)

    // Seed an exact session grant without conflicting rules, then turn every lower step on.
    expect(await cached.request(bashReq('git status'))).toEqual({ kind: 'allow-session' })
    projectDeny = true
    projectAllow = true
    globalAllow = true
    configuration.dangerouslySkip = true

    expect(await cached.request(bashReq('git status'))).toEqual({ kind: 'deny' })
    expect(cachedPrompt).toHaveBeenCalledOnce()

    const prompt = vi.fn(async () => ({ kind: 'allow-once' as const }))
    const globalDenied = new PermissionManager(
      {
        globalDeny: () => true,
        projectAllow: () => true,
        globalAllow: () => true,
      },
      { dangerouslySkip: true },
    )
    globalDenied.setPromptHandler(prompt)

    expect(await globalDenied.request(bashReq('pnpm test'))).toEqual({ kind: 'deny' })
    expect(prompt).not.toHaveBeenCalled()
  })

  it('covers the cache, project, global, dangerous, and prompt conflict matrix', async () => {
    const command = bashReq('git status')

    let lowerRulesEnabled = false
    const cachedPrompt = vi.fn(async () => ({ kind: 'allow-session' as const }))
    const cachedConfiguration = { dangerouslySkip: false }
    const cached = new PermissionManager(
      {
        projectAllow: () => lowerRulesEnabled,
        globalAllow: () => lowerRulesEnabled,
      },
      cachedConfiguration,
    )
    cached.setPromptHandler(cachedPrompt)
    expect(await cached.request(command)).toEqual({ kind: 'allow-session' })
    lowerRulesEnabled = true
    cachedConfiguration.dangerouslySkip = true
    expect(await cached.request(command)).toEqual({ kind: 'allow-session' })
    expect(cachedPrompt).toHaveBeenCalledOnce()

    const projectPrompt = vi.fn(async () => ({ kind: 'deny' as const }))
    const project = new PermissionManager(
      { projectAllow: () => true, globalAllow: () => true },
      { dangerouslySkip: true },
    )
    project.setPromptHandler(projectPrompt)
    expect(await project.request(command)).toEqual({ kind: 'allow-project' })
    expect(projectPrompt).not.toHaveBeenCalled()

    const globalPrompt = vi.fn(async () => ({ kind: 'deny' as const }))
    const global = new PermissionManager({ globalAllow: () => true }, { dangerouslySkip: true })
    global.setPromptHandler(globalPrompt)
    expect(await global.request(command)).toEqual({ kind: 'allow-forever' })
    expect(globalPrompt).not.toHaveBeenCalled()

    const bypassPrompt = vi.fn(async () => ({ kind: 'deny' as const }))
    const bypass = new PermissionManager({}, { dangerouslySkip: true })
    bypass.setPromptHandler(bypassPrompt)
    expect(await bypass.request(command)).toEqual({ kind: 'allow-once' })
    expect(bypassPrompt).not.toHaveBeenCalled()

    const finalPrompt = vi.fn(async () => ({ kind: 'deny' as const }))
    const prompted = new PermissionManager()
    prompted.setPromptHandler(finalPrompt)
    expect(await prompted.request(command)).toEqual({ kind: 'deny' })
    expect(finalPrompt).toHaveBeenCalledOnce()
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
    const prompt = vi.fn(async () => ({ kind: 'deny' as const }))
    const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
    const manager = new PermissionManager({}, { dangerouslySkip: true, logger })
    manager.setPromptHandler(prompt)
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
    expect(prompt).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
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

  it('records prompted grants; every scope grant and deny-forever suppresses repeat prompts', async () => {
    const persist = vi.fn(async () => undefined)
    const project = new PermissionManager({}, { persist })
    const projectPrompt = vi.fn(async () => ({ kind: 'allow-project' as const }))
    project.setPromptHandler(projectPrompt)
    const projectRequest = bashReq('git status')

    expect(await project.request(projectRequest)).toEqual({ kind: 'allow-project' })
    expect(persist).toHaveBeenCalledWith('project', projectRequest, true)
    // Persistence for project scope is not wired in production yet; the grant
    // still holds as a session cache entry, replaying its true decision kind.
    expect(await project.request(bashReq('git status'))).toEqual({ kind: 'allow-project' })
    expect(projectPrompt).toHaveBeenCalledTimes(1)

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

    const denying = new PermissionManager({}, { persist })
    const denyPrompt = vi.fn(async () => ({ kind: 'deny-forever' as const }))
    denying.setPromptHandler(denyPrompt)

    expect(await denying.request(bashReq('rm -rf /')).then((d) => d.kind)).toBe('deny-forever')
    // A cached denial must replay the denial, never surface as a grant.
    expect(await denying.request(bashReq('rm -rf /')).then((d) => d.kind)).toBe('deny-forever')
    expect(denyPrompt).toHaveBeenCalledTimes(1)
  })

  it('keys Bash session grants by the exact command and prompts again for variants', async () => {
    const prompt = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'allow-session' as const })
      .mockResolvedValue({ kind: 'deny' as const })
    const manager = new PermissionManager()
    manager.setPromptHandler(prompt)

    expect(await manager.request(bashReq('git status'))).toEqual({ kind: 'allow-session' })
    expect(await manager.request(bashReq('git status'))).toEqual({ kind: 'allow-session' })
    expect(await manager.request(bashReq('git status '))).toEqual({ kind: 'deny' })
    expect(await manager.request(bashReq('git  status'))).toEqual({ kind: 'deny' })
    expect(prompt).toHaveBeenCalledTimes(3)
  })

  it('keeps a raw bidi command grant isolated from its literal visible escape text', async () => {
    const prompt = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'allow-session' as const })
      .mockResolvedValue({ kind: 'deny' as const })
    const manager = new PermissionManager()
    manager.setPromptHandler(prompt)
    const rawBidi = 'printf "\u202E"'
    const literalEscape = 'printf "\\u{202E}"'

    expect(await manager.request(bashReq(rawBidi))).toEqual({ kind: 'allow-session' })
    expect(await manager.request(bashReq(rawBidi))).toEqual({ kind: 'allow-session' })
    expect(await manager.request(bashReq(literalEscape))).toEqual({ kind: 'deny' })
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it.each([
    { decision: 'allow-project' as const, scope: 'project' as const },
    { decision: 'allow-forever' as const, scope: 'global' as const },
  ])(
    'reloads an exact $scope Bash grant without widening to variants',
    async ({ decision, scope }) => {
      const persisted = new Set<string>()
      const first = new PermissionManager(
        {},
        {
          persist: async (savedScope, request, allow) => {
            if (allow && savedScope === scope) persisted.add(grantKey(request))
          },
        },
      )
      first.setPromptHandler(async () => ({ kind: decision }))
      expect(await first.request(bashReq('pnpm test'))).toEqual({ kind: decision })

      const reloadPrompt = vi.fn(async () => ({ kind: 'deny' as const }))
      const reloaded = new PermissionManager(
        scope === 'project'
          ? { projectAllow: (request) => persisted.has(grantKey(request)) }
          : { globalAllow: (request) => persisted.has(grantKey(request)) },
      )
      reloaded.setPromptHandler(reloadPrompt)

      expect(await reloaded.request(bashReq('pnpm test'))).toEqual({
        kind: scope === 'project' ? 'allow-project' : 'allow-forever',
      })
      expect(await reloaded.request(bashReq('pnpm test -- --runInBand'))).toEqual({ kind: 'deny' })
      expect(reloadPrompt).toHaveBeenCalledOnce()
    },
  )

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
