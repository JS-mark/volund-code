import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { createProductionToolPermissionChain } from '@volund/app-runtime'
import { createSession, EventBus, MachineEventFormatter } from '@volund/core'
import type { JsonValue } from '@volund/shared'
import type { ToolContext } from '@volund/tool-kit'
import { BashTool } from '@volund/tools'
import type { SandboxDisclosure } from '@volund/ui'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runCli } from './cli'
import { command } from './command'
import { assignConfigValue, deleteConfigValue } from './config-edit'
import type { VolundPorts, PermissionInteractionMode } from './ports'

const fixtures: string[] = []
afterEach(async () =>
  Promise.all(fixtures.map((path) => rm(path, { force: true, recursive: true }))),
)

function ports(overrides: Partial<VolundPorts> = {}): VolundPorts {
  return {
    identity: { version: '0.0.0-test' },
    version: '0.0.0-test',
    native: {
      probe: vi.fn(async () => ({
        tier: 'full' as const,
        mechanism: 'test sandbox',
        features: { filesystem: true, network: true },
        degradationReasons: [],
      })),
      health: vi.fn(async () => ({ sandbox: true, search: false, fs: false })),
    },
    auth: {
      health: vi.fn(async () => ({
        configured: false,
        detail: 'anthropic credential unavailable',
      })),
      login: vi.fn(async () => ({ detail: 'anthropic credential stored in encrypted file' })),
      logout: vi.fn(async () => ({ detail: 'anthropic credential removed' })),
    },
    config: { health: vi.fn(async () => ({ valid: true, detail: 'valid' })) },
    telemetry: {
      securityEvent: vi.fn(async () => {}),
      summary: vi.fn(async () => ({
        samples: 0,
        corruptLines: 0,
        tiers: {},
        escape: { allow: 0, deny: 0, ratio: null },
        probe: null,
      })),
      export: vi.fn(async () => 0),
      clear: vi.fn(async () => {}),
      health: vi.fn(async () => ({
        exists: false,
        writable: true,
        corruptLines: 0,
        samples: 0,
        detail: 'local sink not created yet',
      })),
    },
    confirmation: { confirmDangerousNoSandbox: vi.fn(async () => false) },
    trust: {
      check: vi.fn(async (path: string) => ({ canonicalPath: path, trusted: true })),
      grant: vi.fn(async (path: string, scope: 'exact' | 'tree') => ({ path, scope })),
      list: vi.fn(async () => []),
      revoke: vi.fn(async () => 0),
      revokeAll: vi.fn(async () => 0),
    },
    session: {
      startSession: vi.fn(async () => ({ id: 'session-1' })),
      resume: vi.fn(async (id) => ({ id })),
      interrupt: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
      configurePermissionInteraction: vi.fn(),
    },
    ...overrides,
  }
}

describe('runCli', () => {
  it('declares the implemented command surface', () => {
    expect(Object.keys(command.subCommands ?? {})).toEqual([
      'chat',
      'resume',
      'restore',
      'login',
      'logout',
      'config',
      'status',
      'history',
      'context',
      'evolution',
      'plugin',
      'telemetry',
      'trust',
      'doctor',
      'memory',
      'hook',
      'skill',
      'mcp',
      'version',
      'help',
    ])
  })

  it('renders status as stable JSON without ANSI or secrets', async () => {
    const result = await runCli(
      ['status', '--json'],
      ports({
        config: {
          health: vi.fn(async () => ({ valid: true, detail: 'valid' })),
          status: vi.fn(async () => ({
            settings: [],
            config: [],
            status: [{ label: 'Auth method', value: 'keychain (value hidden)' }],
          })),
        },
      }),
    )
    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({ status: expect.any(Array) }),
    )
    expect(result.stdout).not.toMatch(new RegExp(String.raw`\u001B|token|secret`, 'i'))
  })

  it('renders help flags before sandbox probing or session startup', async () => {
    const testPorts = ports({
      native: {
        probe: vi.fn(async () => ({
          tier: 'none' as const,
          mechanism: 'unavailable',
          features: { filesystem: false, network: false },
          degradationReasons: ['probe failed'],
        })),
        health: vi.fn(async () => ({ sandbox: false, search: false, fs: false })),
      },
    })
    const result = await runCli(['--help'], testPorts)
    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    expect(result.stdout).toContain('volund')
    expect(testPorts.native.probe).not.toHaveBeenCalled()
    expect(testPorts.confirmation.confirmDangerousNoSandbox).not.toHaveBeenCalled()
    expect(testPorts.session.startSession).not.toHaveBeenCalled()
    await expect(runCli(['-h'], ports())).resolves.toMatchObject({ exitCode: 0, stderr: '' })
  })

  it('renders per-command help via <command> --help, help <command>, and <command> help', async () => {
    const testPorts = ports({
      native: {
        probe: vi.fn(async () => ({
          tier: 'none' as const,
          mechanism: 'unavailable',
          features: { filesystem: false, network: false },
          degradationReasons: ['probe failed'],
        })),
        health: vi.fn(async () => ({ sandbox: false, search: false, fs: false })),
      },
    })
    const mcpHelp = await runCli(['mcp', '--help'], testPorts)
    expect(mcpHelp).toMatchObject({ exitCode: 0, stderr: '' })
    expect(mcpHelp.stdout).toContain('Usage: volund mcp')
    expect(mcpHelp.stdout).toContain('-- <command> [args...]')
    expect(mcpHelp.stdout).not.toContain('Usage: volund <command>')
    expect(testPorts.native.probe).not.toHaveBeenCalled()
    expect(testPorts.session.startSession).not.toHaveBeenCalled()

    const doctorHelp = await runCli(['help', 'doctor'], testPorts)
    expect(doctorHelp).toMatchObject({ exitCode: 0, stderr: '' })
    expect(doctorHelp.stdout).toContain('Usage: volund doctor')

    const memoryHelp = await runCli(['memory', 'help'], testPorts)
    expect(memoryHelp).toMatchObject({ exitCode: 0, stderr: '' })
    expect(memoryHelp.stdout).toContain('Usage: volund memory')

    const globalHelp = await runCli(['help'], testPorts)
    expect(globalHelp).toMatchObject({ exitCode: 0, stderr: '' })
    expect(globalHelp.stdout).toContain('volund')

    const unknown = await runCli(['help', 'nope'], testPorts)
    expect(unknown).toMatchObject({ exitCode: 2, stdout: '' })
    expect(unknown.stderr).toContain('Unknown command: nope')
    expect(unknown.stderr).toContain("Run 'volund help'")
  })

  it('does not treat flags after -- as help requests', async () => {
    const testPorts = ports({
      mcp: {
        list: vi.fn(async () => []),
        add: vi.fn(async () => ({ file: 'mcp.toml' })),
        remove: vi.fn(async () => ({ file: 'mcp.toml' })),
        setEnabled: vi.fn(async () => {}),
        test: vi.fn(async () => ({ protocolVersion: 'test' })),
        inspect: vi.fn(async () => ({ tools: [] })),
        login: vi.fn(async () => ({ server: 'x' })),
        logout: vi.fn(async () => {}),
      },
    })
    const result = await runCli(
      ['mcp', 'add', 'server', '--', 'node', 'server.js', '--help'],
      testPorts,
    )
    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    expect(result.stdout).not.toContain('Usage: volund')
    expect(testPorts.mcp?.add).toHaveBeenCalled()
  })

  it('runs config commands through the config port', async () => {
    const store: Record<string, JsonValue> = {}
    const file = '/home/user/.volund/config.toml'
    const testPorts = ports({
      config: {
        health: vi.fn(async () => ({ valid: true, detail: 'valid' })),
        listMerged: vi.fn(async () => ({ config: store, warnings: [] })),
        setValue: vi.fn(async (input: { key: string; value: JsonValue }) => {
          assignConfigValue(store, input.key, input.value)
          return { file }
        }),
        unsetValue: vi.fn(async (input: { key: string }) => {
          const removed = deleteConfigValue(store, input.key)
          return { file, removed }
        }),
        filePaths: vi.fn(() => ({ user: file, project: '/cwd/.volund/config.toml' })),
      },
    })
    await expect(
      runCli(['config', 'set', 'provider.default', 'anthropic'], testPorts),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: `Set provider.default in ${file}\n`,
    })
    await expect(runCli(['config', 'get', 'provider.default'], testPorts)).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'anthropic\n',
    })
    await expect(runCli(['config', 'get', 'missing.key'], testPorts)).resolves.toMatchObject({
      exitCode: 3,
    })
    await expect(runCli(['config', 'set', 'only-key'], testPorts)).resolves.toMatchObject({
      exitCode: 2,
      stderr: 'config set requires a key and a value',
    })
    await expect(runCli(['config', 'unset', 'provider.default'], testPorts)).resolves.toMatchObject(
      { exitCode: 0 },
    )
    await expect(runCli(['config', 'unset', 'provider.default'], testPorts)).resolves.toMatchObject(
      { exitCode: 3 },
    )
    await expect(runCli(['config', 'path', '--json'], testPorts)).resolves.toMatchObject({
      exitCode: 0,
      stdout: `${JSON.stringify({ user: file, project: '/cwd/.volund/config.toml' })}\n`,
    })
    await expect(runCli(['config', 'bogus'], testPorts)).resolves.toMatchObject({ exitCode: 2 })
    await expect(runCli(['config', '--help'], testPorts)).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining('Usage: volund config'),
    })
  })

  it('runs history commands through the history port with a confirmation gate for clear', async () => {
    const candidate = {
      id: '018f2d3a-0000-7000-8000-00000000000a',
      cwd: '/work/a',
      updatedAt: '2026-08-20T00:00:00.000Z',
      title: 'a session',
    }
    const testPorts = ports({
      history: {
        list: vi.fn(async () => [candidate]),
        show: vi.fn(async () => ({
          id: candidate.id,
          cwd: candidate.cwd,
          updatedAt: candidate.updatedAt,
          events: 3,
          messages: [{ role: 'user', text: 'hello' }],
        })),
        exportSession: vi.fn(async () => '# Session\n'),
        importSession: vi.fn(async () => ({ id: candidate.id, file: '/tmp/x.jsonl' })),
        clear: vi.fn(async () => ({ removed: [candidate.id] })),
        search: vi.fn(async () => [{ sessionId: candidate.id, snippet: 'hello' }]),
      },
    })
    const listed = await runCli(['history', 'list', '--json'], testPorts)
    expect(listed).toMatchObject({ exitCode: 0, stderr: '' })
    expect(JSON.parse(listed.stdout)).toEqual([candidate])

    const shown = await runCli(['history', 'show', candidate.id], testPorts)
    expect(shown.exitCode).toBe(0)
    expect(shown.stdout).toContain('hello')

    // clear：非交互且无 --yes → 拒绝；--yes → 执行
    await expect(runCli(['history', 'clear'], testPorts)).resolves.toMatchObject({
      exitCode: 2,
      stderr: 'history clear requires exactly one of --all or --older-than <date>',
    })
    await expect(runCli(['history', 'clear', '--all'], testPorts)).resolves.toMatchObject({
      exitCode: 2,
      stderr: 'history clear requires --yes outside an interactive terminal',
    })
    await expect(runCli(['history', 'clear', '--all', '--yes'], testPorts)).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'Removed 1 session(s).\n',
    })

    await expect(runCli(['history', '--help'], testPorts)).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining('Usage: volund history'),
    })
  })

  it('renders version flags before sandbox probing or session startup', async () => {
    const testPorts = ports({
      native: {
        probe: vi.fn(async () => ({
          tier: 'none' as const,
          mechanism: 'unavailable',
          features: { filesystem: false, network: false },
          degradationReasons: ['probe failed'],
        })),
        health: vi.fn(async () => ({ sandbox: false, search: false, fs: false })),
      },
    })
    const result = await runCli(['--version'], testPorts)
    expect(result).toEqual({ exitCode: 0, stdout: '0.0.0-test\n', stderr: '' })
    expect(testPorts.native.probe).not.toHaveBeenCalled()
    expect(testPorts.confirmation.confirmDangerousNoSandbox).not.toHaveBeenCalled()
    expect(testPorts.session.startSession).not.toHaveBeenCalled()
    await expect(runCli(['-v'], ports())).resolves.toMatchObject({
      exitCode: 0,
      stdout: '0.0.0-test\n',
      stderr: '',
    })
  })

  it('does not sandbox-gate non-chat commands on none-tier hosts', async () => {
    const testPorts = ports({
      native: {
        probe: vi.fn(async () => ({
          tier: 'none' as const,
          mechanism: 'unavailable',
          features: { filesystem: false, network: false },
          degradationReasons: ['probe failed'],
        })),
        health: vi.fn(async () => ({ sandbox: false, search: false, fs: false })),
      },
    })
    const commands = [
      ['doctor', '--json'],
      ['telemetry', 'show', '--json'],
      ['plugin', 'list', '--json'],
      ['hook', 'list'],
      ['mcp', 'list', '--json'],
      ['context', 'show', '--json'],
      ['evolution', 'show', '--json'],
      ['resume'],
      ['restore'],
      ['login', 'openai'],
      ['logout', 'anthropic'],
      ['config'],
      ['history'],
      ['version'],
      ['unknown'],
    ]
    const results = await Promise.all(commands.map((args) => runCli(args, testPorts)))
    expect(results).toHaveLength(commands.length)
    expect(results[commands.findIndex(([name]) => name === 'version')]).toEqual({
      exitCode: 0,
      stdout: '0.0.0-test\n',
      stderr: '',
    })
    expect(testPorts.native.probe).not.toHaveBeenCalled()
    expect(testPorts.confirmation.confirmDangerousNoSandbox).not.toHaveBeenCalled()
    expect(testPorts.session.startSession).not.toHaveBeenCalled()
  }, 30_000)

  it('rejects non-chat global flags without starting a session', async () => {
    const testPorts = ports({
      native: {
        probe: vi.fn(async () => ({
          tier: 'none' as const,
          mechanism: 'unavailable',
          features: { filesystem: false, network: false },
          degradationReasons: ['probe failed'],
        })),
        health: vi.fn(async () => ({ sandbox: false, search: false, fs: false })),
      },
    })
    const unknown = await runCli(['--foo'], testPorts)
    const doctorOnly = await runCli(['--strict'], testPorts)
    const loginOnly = await runCli(['--api-key-stdin'], testPorts)
    expect(unknown).toMatchObject({ exitCode: 2 })
    expect(unknown.stderr).toContain('Unsupported global flag')
    expect(doctorOnly.stderr).toContain('--strict')
    expect(loginOnly.stderr).toContain('--api-key-stdin')
    expect(testPorts.native.probe).not.toHaveBeenCalled()
    expect(testPorts.confirmation.confirmDangerousNoSandbox).not.toHaveBeenCalled()
    expect(testPorts.session.startSession).not.toHaveBeenCalled()
  })

  it('installs, lists, diagnoses, disables, and uninstalls plugins through one port', async () => {
    const availability = {
      available: false as const,
      code: 'plugin_legacy_activation_unavailable' as const,
      detail: 'Legacy plugin install and activation are temporarily unavailable.',
      reopenCondition: 'Catalog v2 verification',
    }
    const plugin = {
      availability: vi.fn(async () => availability),
      install: vi.fn(async () => ({ name: 'volund-plugin-demo', version: '1.0.0' })),
      uninstall: vi.fn(async () => {}),
      list: vi.fn(async () => ({
        'volund-plugin-demo': { version: '1.0.0', enabled: true },
      })),
      setEnabled: vi.fn(async () => {}),
      doctor: vi.fn(async () => ({
        name: 'volund-plugin-demo',
        version: '1.0.0',
        permissions: ['tools.register'],
        compatibility: { status: 'compatible' as const, detail: 'compatible' },
        availability,
      })),
    }
    expect((await runCli(['plugin', 'install', './demo'], ports({ plugin }))).stdout).toContain(
      'Installed volund-plugin-demo@1.0.0',
    )
    expect((await runCli(['plugin', 'list'], ports({ plugin }))).stdout).toBe(
      'volund-plugin-demo@1.0.0\tdisabled (legacy runtime unavailable)\n',
    )
    expect(
      JSON.parse((await runCli(['plugin', 'list', '--json'], ports({ plugin }))).stdout),
    ).toEqual([
      {
        name: 'volund-plugin-demo',
        version: '1.0.0',
        enabled: true,
        availability,
        reasonCode: 'plugin_legacy_activation_unavailable',
      },
    ])
    expect(
      (await runCli(['plugin', 'doctor', 'volund-plugin-demo'], ports({ plugin }))).stdout,
    ).toContain('plugin_legacy_activation_unavailable')
    await runCli(['plugin', 'disable', 'volund-plugin-demo'], ports({ plugin }))
    await runCli(['plugin', 'uninstall', 'volund-plugin-demo'], ports({ plugin }))
    expect(plugin.setEnabled).toHaveBeenCalledWith('volund-plugin-demo', false)
    expect(plugin.uninstall).toHaveBeenCalledWith('volund-plugin-demo')
    const generalDoctor = JSON.parse(
      (await runCli(['doctor', '--json'], ports({ plugin }))).stdout,
    ) as Array<{ name: string; plugin?: typeof availability; warn?: boolean }>
    expect(generalDoctor.find((check) => check.name === 'plugin activation')).toMatchObject({
      warn: true,
      plugin: availability,
    })
  })

  it('emits error and final NDJSON events for every plugin JSON failure path', async () => {
    const availability = {
      available: false as const,
      code: 'plugin_legacy_activation_unavailable' as const,
      detail: 'Legacy plugin activation is temporarily unavailable.',
      reopenCondition: 'Catalog v2 verification',
    }
    const unavailable = Object.assign(new Error('legacy activation unavailable'), {
      code: availability.code,
    })
    const plugin = {
      availability: vi.fn(async () => availability),
      install: vi.fn(async () => Promise.reject(unavailable)),
      uninstall: vi.fn(async () =>
        Promise.reject(Object.assign(new Error('filesystem denied'), { code: 'EACCES' })),
      ),
      list: vi.fn(async () => ({})),
      setEnabled: vi.fn(async (_name: string, enabled: boolean) => {
        if (enabled) throw unavailable
      }),
      doctor: vi.fn(async () => Promise.reject(unavailable)),
    }
    const cases = [
      {
        args: ['plugin', 'install', './demo', '--json'],
        testPorts: ports({ plugin }),
        exitCode: 1,
        code: 'plugin_legacy_activation_unavailable',
        category: 'runtime',
      },
      {
        args: ['plugin', 'enable', 'volund-plugin-demo', '--json'],
        testPorts: ports({ plugin }),
        exitCode: 1,
        code: 'plugin_legacy_activation_unavailable',
        category: 'runtime',
      },
      {
        args: ['plugin', 'enable', '--json'],
        testPorts: ports({ plugin }),
        exitCode: 2,
        code: 'plugin_command_target_required',
        category: 'usage',
      },
      {
        args: ['plugin', 'explode', 'volund-plugin-demo', '--json'],
        testPorts: ports({ plugin }),
        exitCode: 2,
        code: 'plugin_command_unknown',
        category: 'usage',
      },
      {
        args: ['plugin', 'uninstall', 'volund-plugin-demo', '--json'],
        testPorts: ports({ plugin }),
        exitCode: 1,
        code: 'plugin_internal_error',
        category: 'runtime',
      },
      {
        args: ['plugin', 'list', '--json'],
        testPorts: ports(),
        exitCode: 2,
        code: 'plugin_integration_unavailable',
        category: 'runtime',
      },
    ]

    for (const testCase of cases) {
      const result = await runCli(testCase.args, testCase.testPorts)
      const lines = result.stdout.trim().split('\n')
      const events = lines.map((line) => JSON.parse(line))
      expect(result).toMatchObject({ exitCode: testCase.exitCode, stderr: '' })
      expect(lines).toHaveLength(2)
      expect(events).toMatchObject([
        {
          type: 'error',
          seq: 1,
          data: {
            code: testCase.code,
            category: testCase.category,
            retryable: false,
            exitCode: testCase.exitCode,
          },
        },
        {
          type: 'final',
          seq: 2,
          data: { status: 'error', exitCode: testCase.exitCode },
        },
      ])
    }
  })

  it('lists and inspects MCP servers without exposing URL credentials', async () => {
    const mcp = {
      list: vi.fn(async () => [
        { name: 'demo', transport: 'https://user:secret@example.test/sse' },
      ]),
      test: vi.fn(async () => ({ protocolVersion: '2025-03-26' })),
      inspect: vi.fn(async () => ({ tools: [{ name: 'read', description: 'reads' }] })),
      add: vi.fn(async () => ({ file: 'mcp.toml' })),
      remove: vi.fn(async () => ({ file: 'mcp.toml' })),
      setEnabled: vi.fn(async () => {}),
      login: vi.fn(async () => ({ server: 'demo' })),
      logout: vi.fn(async () => {}),
    }
    const listed = await runCli(['mcp', 'list'], ports({ mcp }))
    expect(listed.stdout).toContain('demo')
    expect(listed.stdout).not.toContain('secret')
    expect((await runCli(['mcp', 'test', 'demo'], ports({ mcp }))).stdout).toContain('2025-03-26')
    expect((await runCli(['mcp', 'inspect', 'demo'], ports({ mcp }))).stdout).toContain(
      'read — reads',
    )
  })

  it('shows and rolls back evolution audit records through one port', async () => {
    const evolution = {
      show: vi.fn(async () => [{ namespace: 'context', param: 'target_ratio' }]),
      rollback: vi.fn(async () => [{ param: 'target_ratio' }]),
    }
    const shown = await runCli(
      ['evolution', 'show', '--namespace', 'context', '--json'],
      ports({ evolution }),
    )
    expect(shown.stdout).toContain('target_ratio')
    const rolled = await runCli(
      ['evolution', 'rollback', '--namespace', 'context'],
      ports({ evolution }),
    )
    expect(rolled.stdout).toContain('1 parameter')
    expect(evolution.rollback).toHaveBeenCalledWith({ namespace: 'context' })
  })

  it('exposes context show, keep, compact and policy control through one port', async () => {
    const context = {
      show: vi.fn(async () => ({
        policy: 'summary',
        currentTokens: 80,
        maxTokens: 100,
        threshold: 0.85,
        sources: { messages: 60, system: 20 },
      })),
      keep: vi.fn(async () => {}),
      unkeep: vi.fn(async () => {}),
      compact: vi.fn(async () => ({ beforeTokens: 80, afterTokens: 50 })),
      getPolicy: vi.fn(async () => ({ name: 'summary', params: { keepRecent: 20 } })),
      setPolicy: vi.fn(async () => {}),
    }
    expect((await runCli(['context', 'show', '--json'], ports({ context }))).stdout).toContain(
      '"policy":"summary"',
    )
    await runCli(['context', 'keep', 'm1'], ports({ context }))
    await runCli(['context', 'compact', 'summary'], ports({ context }))
    await runCli(['context', 'policy', 'set', 'sliding', 'keepRecent=30'], ports({ context }))
    expect(context.keep).toHaveBeenCalledWith('m1')
    expect(context.compact).toHaveBeenCalledWith('summary')
    expect(context.setPolicy).toHaveBeenCalledWith('sliding', { keepRecent: '30' })
  })

  it('fails strict doctor and precisely lists unavailable integrations', async () => {
    const result = await runCli(['doctor', '--strict', '--json'], ports())
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('anthropic credential unavailable')
    expect(result.stdout).toContain('native search unavailable')
    expect(result.stdout).toContain('native fs unavailable')
    expect(result.stdout).toContain('"name":"volund version"')
  })

  it('reports gh CLI availability as a structured doctor check', async () => {
    const result = await runCli(['doctor', '--json'], ports())
    const checks = JSON.parse(result.stdout) as Array<{
      detail: string
      gh?: { installed: boolean; path?: string; version?: string }
      name: string
      ok: boolean
      warn?: boolean
    }>
    const gh = checks.find((check) => check.name === 'gh CLI')
    // CI runners and CONTRIBUTING-recommended setups install gh (PR workflow dep).
    expect(gh).toMatchObject({ ok: true, gh: { installed: true } })
    expect(gh?.warn).toBeUndefined()
    expect(gh?.gh?.version).toMatch(/^\d+\.\d+/)
    expect(gh?.gh?.path).toContain('gh')
    expect(gh?.detail).toBe(`${gh?.gh?.version} (${gh?.gh?.path})`)
  })

  it('warns without failing doctor when gh CLI is unavailable', async () => {
    const noGhPath = await mkdtemp(join(process.cwd(), '.cli-gh-missing-'))
    fixtures.push(noGhPath)
    const healthyPorts = ports({
      native: {
        probe: vi.fn(async () => ({
          tier: 'full' as const,
          mechanism: 'test sandbox',
          features: { filesystem: true, network: true },
          degradationReasons: [],
        })),
        health: vi.fn(async () => ({ sandbox: true, search: true, fs: true })),
      },
      auth: {
        health: vi.fn(async () => ({
          configured: true,
          detail: 'anthropic credential available',
        })),
        login: vi.fn(async () => ({ detail: 'stored' })),
        logout: vi.fn(async () => ({ detail: 'removed' })),
      },
    })
    vi.stubEnv('PATH', noGhPath)
    try {
      const strict = await runCli(['doctor', '--strict', '--json'], healthyPorts)
      expect(strict.exitCode).toBe(0)
      const checks = JSON.parse(strict.stdout) as Array<{
        detail: string
        gh?: { installed: boolean; path?: string; version?: string }
        name: string
        ok: boolean
        warn?: boolean
      }>
      expect(checks.find((check) => check.name === 'gh CLI')).toEqual({
        detail: 'PR 工作流需要 gh（CONTRIBUTING 推荐依赖）',
        gh: { installed: false },
        name: 'gh CLI',
        ok: true,
        warn: true,
      })
      const text = await runCli(['doctor'], healthyPorts)
      expect(text.stdout).toContain('⚠️ gh CLI: PR 工作流需要 gh（CONTRIBUTING 推荐依赖）')
      expect(text.stdout).not.toContain('✗ gh CLI')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('normalizes --cwd before starting a session', async () => {
    const root = await mkdtemp(join(process.cwd(), '.cli-cwd-'))
    fixtures.push(root)
    const nested = join(root, 'nested')
    await mkdir(nested)
    const testPorts = ports()
    const result = await runCli(['chat', 'hello', '--cwd', nested], testPorts)
    expect(result.exitCode).toBe(0)
    expect(testPorts.session.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: nested, prompt: 'hello' }),
    )
  })

  it('starts interactive chat without passing an empty prompt', async () => {
    const testPorts = ports()
    const result = await runCli(['chat'], testPorts)
    expect(result.exitCode).toBe(0)
    expect(testPorts.session.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: process.cwd() }),
    )
    expect(testPorts.session.startSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ prompt: '' }),
    )
  })

  it('starts the interactive REPL within the cold-start budget while the native probe hangs (r13-P1 §5.8)', async () => {
    // Mandatory integration test: probe stub hangs for seconds; the REPL
    // initialization path (session start + UI render) must return without it.
    const hangingProbe = new Promise<SandboxDisclosure>(() => {})
    let probeSettled = false
    void hangingProbe.then(() => {
      probeSettled = true
    })
    const interactive = {
      id: 'session-1',
      events: new EventBus(),
      setPermissionPromptHandler: vi.fn(),
      submit: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
      exitCode: vi.fn(() => 0),
    }
    const renderInteractiveApp = vi.fn(() => ({
      clear: vi.fn(),
      unmount: vi.fn(),
      waitUntilExit: vi.fn(async () => {}),
      waitUntilRenderFlush: vi.fn(async () => {}),
    }))
    const testPorts = ports({
      native: {
        probe: vi.fn(() => hangingProbe),
        health: vi.fn(async () => ({ sandbox: false, search: false, fs: false })),
        startProbes: vi.fn(),
      },
      session: {
        startSession: vi.fn(async () => ({ id: 'legacy-session' })),
        startInteractive: vi.fn(async () => interactive),
        resume: vi.fn(async (id) => ({ id })),
        interrupt: vi.fn(async () => {}),
        end: vi.fn(async () => {}),
        configurePermissionInteraction: vi.fn(),
        configureTerminalOutput: vi.fn(),
      },
      ui: {
        renderInteractiveApp,
      },
    })

    const startedAt = performance.now()
    const result = await runCli(['chat'], testPorts, {
      isInteractiveTerminal: () => true,
      readStdin: async () => '',
    })
    const elapsedMs = performance.now() - startedAt

    expect(result).toEqual({ exitCode: 0, stderr: '', stdout: '' })
    expect(renderInteractiveApp).toHaveBeenCalledOnce()
    // §9.10 cold-start budget: the REPL path never waits for the probe.
    expect(elapsedMs).toBeLessThan(100)
    expect(testPorts.native.probe).toHaveBeenCalledOnce()
    expect(testPorts.native.startProbes).toHaveBeenCalledOnce()
    // The probe was fired but never awaited by the REPL path.
    expect(probeSettled).toBe(false)
    expect(renderInteractiveApp).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'sandbox probing',
        sandboxProbe: expect.any(Function),
        welcome: expect.objectContaining({ sandbox: { status: 'probing' } }),
      }),
    )
  })

  it('routes promptless TTY chat to the Ink UI port', async () => {
    const interactive = {
      id: 'session-1',
      events: new EventBus(),
      setPermissionPromptHandler: vi.fn(),
      submit: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
      exitCode: vi.fn(() => 0),
    }
    const waitUntilExit = vi.fn(async () => {})
    const testPorts = ports({
      session: {
        startSession: vi.fn(async () => ({ id: 'legacy-session' })),
        startInteractive: vi.fn(async () => interactive),
        resume: vi.fn(async (id) => ({ id })),
        interrupt: vi.fn(async () => {}),
        end: vi.fn(async () => {}),
        configurePermissionInteraction: vi.fn(),
        configureTerminalOutput: vi.fn(),
      },
      ui: {
        renderInteractiveApp: vi.fn(() => ({
          clear: vi.fn(),
          unmount: vi.fn(),
          waitUntilExit,
          waitUntilRenderFlush: vi.fn(async () => {}),
        })),
      },
    })

    const result = await runCli(['chat'], testPorts, {
      isInteractiveTerminal: () => true,
      readStdin: async () => '',
    })

    expect(result).toEqual({ exitCode: 0, stderr: '', stdout: '' })
    expect(testPorts.session.startInteractive).toHaveBeenCalledWith({ cwd: process.cwd() })
    expect(testPorts.session.startSession).not.toHaveBeenCalled()
    expect(testPorts.session.configureTerminalOutput).toHaveBeenCalledWith({
      streamToStdout: false,
    })
    expect(testPorts.session.configurePermissionInteraction).toHaveBeenCalledWith({ mode: 'tui' })
    expect(testPorts.ui?.renderInteractiveApp).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: process.cwd(),
        events: interactive.events,
        modelPicker: expect.objectContaining({
          currentModelId: 'anthropic/claude-sonnet-4-20250514',
          models: expect.arrayContaining([
            expect.objectContaining({
              id: 'anthropic/claude-sonnet-4-20250514',
              label: 'Claude Sonnet 4',
            }),
            expect.objectContaining({
              id: 'anthropic/claude-opus-4-20250514',
              disabled: true,
            }),
          ]),
        }),
        permissions: expect.any(Object),
        sandboxProbe: expect.any(Function),
        sessionId: 'session-1',
        status: 'sandbox probing',
        welcome: expect.objectContaining({
          cwd: process.cwd(),
          sessionId: 'session-1',
          version: '0.0.0-test',
          sandbox: { status: 'probing' },
          permission: expect.objectContaining({ mode: 'ask', dangerous: false }),
        }),
      }),
    )
    // The probe result arrives asynchronously and backfills the badge.
    // ports 接口声明的是普通函数类型；运行时是 vi.fn —— 用 vi.mocked 收窄拿 .mock
    const renderMock = vi.mocked(testPorts.ui!.renderInteractiveApp)
    const renderArg = renderMock.mock.calls[0]?.[0] as {
      sandboxProbe: () => Promise<{ sandbox: { status: string; tier?: string }; status: string }>
    }
    await expect(renderArg.sandboxProbe()).resolves.toEqual({
      sandbox: {
        status: 'available',
        tier: 'full',
        mechanism: 'test sandbox',
        filesystem: 'isolated',
        network: 'available',
      },
      status: 'sandbox full',
    })
    expect(interactive.setPermissionPromptHandler).toHaveBeenCalledWith(expect.any(Function))
    expect(waitUntilExit).toHaveBeenCalledOnce()
  })

  it('shows the configured provider model in the picker and welcome instead of the hardcoded default', async () => {
    // 回归（851f62e 的 UI 侧缺口）：picker/welcome 曾写死 anthropic/claude-sonnet-4-20250514，
    // 与 [provider.anthropic] model 实际生效值脱节（企业网关自定义模型时 UI 显示撒谎）。
    const interactive = {
      id: 'session-1',
      events: new EventBus(),
      setPermissionPromptHandler: vi.fn(),
      submit: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
      exitCode: vi.fn(() => 0),
    }
    const testPorts = ports({
      config: {
        health: vi.fn(async () => ({ valid: true, detail: 'valid' })),
        status: vi.fn(async () => ({
          settings: [],
          config: [],
          status: [
            { label: 'Auth method', value: 'credential store (value hidden)' },
            { label: 'Model', value: 'weibo/glm-5.2' },
          ],
        })),
      },
      session: {
        startSession: vi.fn(async () => ({ id: 'legacy-session' })),
        startInteractive: vi.fn(async () => interactive),
        resume: vi.fn(async (id) => ({ id })),
        interrupt: vi.fn(async () => {}),
        end: vi.fn(async () => {}),
        configurePermissionInteraction: vi.fn(),
        configureTerminalOutput: vi.fn(),
      },
      ui: {
        renderInteractiveApp: vi.fn(() => ({
          clear: vi.fn(),
          unmount: vi.fn(),
          waitUntilExit: vi.fn(async () => {}),
          waitUntilRenderFlush: vi.fn(async () => {}),
        })),
      },
    })

    const result = await runCli(['chat'], testPorts, {
      isInteractiveTerminal: () => true,
      readStdin: async () => '',
    })

    expect(result).toEqual({ exitCode: 0, stderr: '', stdout: '' })
    expect(testPorts.ui?.renderInteractiveApp).toHaveBeenCalledWith(
      expect.objectContaining({
        modelPicker: expect.objectContaining({
          currentModelId: 'anthropic/weibo/glm-5.2',
          models: expect.arrayContaining([
            expect.objectContaining({ id: 'anthropic/weibo/glm-5.2' }),
          ]),
        }),
        welcome: expect.objectContaining({
          model: expect.objectContaining({ model: 'weibo/glm-5.2', source: 'config' }),
        }),
      }),
    )
  })

  it('does not register permission prompts in yolo TUI mode', async () => {
    const interactive = {
      id: 'session-1',
      events: new EventBus(),
      setPermissionPromptHandler: vi.fn(),
      submit: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
      exitCode: vi.fn(() => 0),
    }
    const testPorts = ports({
      session: {
        startSession: vi.fn(async () => ({ id: 'legacy-session' })),
        startInteractive: vi.fn(async () => interactive),
        resume: vi.fn(async (id) => ({ id })),
        interrupt: vi.fn(async () => {}),
        end: vi.fn(async () => {}),
        configurePermissionInteraction: vi.fn(),
        configureTerminalOutput: vi.fn(),
      },
      ui: {
        renderInteractiveApp: vi.fn(() => ({
          clear: vi.fn(),
          unmount: vi.fn(),
          waitUntilExit: vi.fn(async () => {}),
          waitUntilRenderFlush: vi.fn(async () => {}),
        })),
      },
    })

    const result = await runCli(['chat', '--yolo'], testPorts, {
      isInteractiveTerminal: () => true,
      readStdin: async () => '',
    })

    expect(result.exitCode).toBe(0)
    expect(interactive.setPermissionPromptHandler).not.toHaveBeenCalled()
    expect(testPorts.ui?.renderInteractiveApp).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'sandbox probing; permissions bypassed',
        welcome: expect.objectContaining({
          sandbox: { status: 'probing' },
          permission: expect.objectContaining({ mode: 'full', dangerous: true }),
        }),
      }),
    )
  })

  it('keeps --no-tui promptless chat on the line fallback even when TTY is available', async () => {
    const interactive = {
      id: 'session-1',
      events: new EventBus(),
      submit: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
      exitCode: vi.fn(() => 0),
    }
    const testPorts = ports({
      session: {
        startSession: vi.fn(async () => ({ id: 'legacy-session' })),
        startInteractive: vi.fn(async () => interactive),
        resume: vi.fn(async (id) => ({ id })),
        interrupt: vi.fn(async () => {}),
        end: vi.fn(async () => {}),
        configurePermissionInteraction: vi.fn(),
        configureTerminalOutput: vi.fn(),
      },
      ui: {
        renderInteractiveApp: vi.fn(() => ({
          clear: vi.fn(),
          unmount: vi.fn(),
          waitUntilExit: vi.fn(async () => {}),
          waitUntilRenderFlush: vi.fn(async () => {}),
        })),
      },
    })

    const result = await runCli(['chat', '--no-tui'], testPorts, {
      isInteractiveTerminal: () => true,
      readStdin: async () => '',
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Before we start:')
    expect(testPorts.session.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: process.cwd() }),
    )
    expect(testPorts.session.startInteractive).not.toHaveBeenCalled()
    expect(testPorts.ui?.renderInteractiveApp).not.toHaveBeenCalled()
    expect(testPorts.session.configureTerminalOutput).toHaveBeenCalledWith({
      streamToStdout: true,
    })
    expect(testPorts.session.configurePermissionInteraction).toHaveBeenCalledWith({ mode: 'line' })
  })

  it('uses NDJSON only for a JSON chat and disables human/TUI output', async () => {
    const testPorts = ports()
    testPorts.session.configureOutput = vi.fn(({ write }) => {
      write('{"v":1,"type":"final"}\n')
    })
    const result = await runCli(['chat', 'hello', '--json'], testPorts)
    expect(result).toEqual({ exitCode: 0, stderr: '', stdout: '{"v":1,"type":"final"}\n' })
    expect(testPorts.session.configureOutput).toHaveBeenCalledWith({
      json: true,
      write: expect.any(Function),
    })
    expect(testPorts.ui?.renderInteractiveApp).toBeUndefined()
    expect(testPorts.session.configurePermissionInteraction).toHaveBeenCalledWith({ mode: 'none' })
  })

  it('forces JSON-on-TTY to none and drives the real Bash permission chain without readline', async () => {
    let interactionMode: PermissionInteractionMode = 'line'
    let writeJson: ((value: string) => void) | undefined
    const rawSecret = `ghp_${'J'.repeat(24)}`
    const rawCommand = `printf '${rawSecret}'`
    const linePrompt = vi.fn(async (_question: string) => 'a')
    const nativeExecute = vi.fn(async () => 'must not execute')
    const configurePermissionInteraction = vi.fn((input: { mode: PermissionInteractionMode }) => {
      interactionMode = input.mode
    })
    const session = {
      startSession: vi.fn(async ({ cwd }: { cwd: string; prompt?: string }) => {
        const state = createSession({
          id: 'session-json-tty',
          cwd,
          maxTokens: 200_000,
          toolRegistrySnapshot: 'json-tty-test',
        })
        const events = new EventBus()
        const formatter = new MachineEventFormatter()
        events.subscribe((event) => {
          const line = formatter.encode(event)
          if (line) writeJson?.(line)
        })
        const logger = {
          debug: vi.fn(),
          error: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
        }
        const chain = createProductionToolPermissionChain({
          state,
          events,
          permissionSnapshot: { dangerouslySkip: false, interactionMode },
          logger,
          interactivePermissionPrompt: () => undefined,
          linePermissionPrompt: linePrompt,
          terminalIsInteractive: () => true,
        })
        const executor = chain.bindExecutor(
          (signal): ToolContext => ({
            abortSignal: signal,
            session: { id: state.id, cwd: state.cwd, turnId: 'turn-json' },
            native: { execute: nativeExecute },
            logger,
            ui: { requestInput: async () => '' },
          }),
        )
        const result = await executor.execute(
          new BashTool({ platform: 'darwin' }),
          { command: rawCommand },
          new AbortController().signal,
          'toolu_json_tty',
        )
        writeJson?.(
          `${JSON.stringify({ type: 'final', data: { denied: result.isError === true } })}\n`,
        )
        return { id: state.id, exitCode: result.isError ? 1 : 0 }
      }),
      resume: vi.fn(async (id: string) => ({ id })),
      interrupt: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
      configureSecurity: vi.fn(),
      configurePermissionInteraction,
      configureOutput: vi.fn((input: { json: boolean; write(value: string): void }) => {
        writeJson = input.write
      }),
      configureTerminalOutput: vi.fn(),
    }
    const result = await runCli(['chat', 'hello', '--json'], ports({ session }), {
      isInteractiveTerminal: () => true,
      readStdin: async () => '',
    })

    expect(configurePermissionInteraction).toHaveBeenCalledWith({ mode: 'none' })
    expect(linePrompt).not.toHaveBeenCalled()
    expect(nativeExecute).not.toHaveBeenCalled()
    expect(result.exitCode).toBe(1)
    expect(result.stdout).not.toContain(rawSecret)
    const lines = result.stdout.trim().split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(1)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })

  it('keeps management --json output as one JSON document', async () => {
    const result = await runCli(['doctor', '--json'], ports())
    expect(result.stdout.trim().split('\n')).toHaveLength(1)
    expect(Array.isArray(JSON.parse(result.stdout))).toBe(true)
  })

  it('returns stable error and final events for invalid JSON chat usage', async () => {
    const result = await runCli(['chat', '--json'], ports())
    const events = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(result).toMatchObject({ exitCode: 2, stderr: '' })
    expect(events).toMatchObject([
      {
        type: 'error',
        data: { code: 'prompt_required', category: 'usage', retryable: false, exitCode: 2 },
      },
      { type: 'final', data: { status: 'error', exitCode: 2 } },
    ])
  })

  it('rejects dangerous mode without an explicit confirmation and emits one event', async () => {
    const testPorts = ports()
    const result = await runCli(['--dangerous-no-sandbox'], testPorts)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('I understand the risk')
    expect(testPorts.telemetry.securityEvent).toHaveBeenCalledOnce()
  })

  it('shows a red warning and records permission bypass once', async () => {
    const testPorts = ports()
    const result = await runCli(['--yolo', '--no-color'], testPorts)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('DANGER: PERMISSIONS DISABLED')
    expect(testPorts.telemetry.securityEvent).toHaveBeenCalledWith(
      'permissions.dangerously_skipped',
      expect.any(Object),
    )
  })

  it('exits 3 when strict sandbox receives a degraded tier', async () => {
    const testPorts = ports({
      native: {
        probe: vi.fn(async () => ({
          tier: 'partial' as const,
          mechanism: 'landlock',
          features: { filesystem: true, network: false },
          degradationReasons: ['no seccomp'],
        })),
        health: vi.fn(async () => ({ sandbox: true, search: false, fs: false })),
      },
    })
    const result = await runCli(['--strict-sandbox'], testPorts)
    expect(result.exitCode).toBe(3)
    expect(result.stdout).toContain('Sandbox: PARTIAL')
  })

  it('never enters a none-tier session without explicit confirmation', async () => {
    const testPorts = ports({
      native: {
        probe: vi.fn(async () => ({
          tier: 'none' as const,
          mechanism: 'unavailable',
          features: { filesystem: false, network: false },
          degradationReasons: ['probe failed'],
        })),
        health: vi.fn(async () => ({ sandbox: false, search: false, fs: false })),
      },
    })
    const result = await runCli([], testPorts)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('I understand the risk')
    expect(testPorts.session.startSession).not.toHaveBeenCalled()
  })

  it('resumes a persisted session through the session runtime port', async () => {
    const testPorts = ports()
    const result = await runCli(['resume', 'session-42'], testPorts)
    expect(result.exitCode).toBe(0)
    expect(testPorts.session.resume).toHaveBeenCalledWith('session-42')
  })

  it('returns structured resume candidates instead of waiting in JSON mode', async () => {
    const testPorts = ports()
    testPorts.session.list = vi.fn(async () => [
      { id: 'session-42', cwd: '/work', updatedAt: '2026-08-10T00:00:00Z', title: 'Work' },
    ])
    const result = await runCli(['resume', '--json'], testPorts)
    expect(result.exitCode).toBe(2)
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: 'session_id_required' },
      candidates: [{ id: 'session-42' }],
    })
    expect(testPorts.session.resume).not.toHaveBeenCalled()
  })

  it('enters interactive chat after selecting a session to resume', async () => {
    const testPorts = ports()
    const candidate = {
      id: 'session-42',
      cwd: '/work',
      updatedAt: '2026-08-10T00:00:00Z',
      title: 'Work',
    }
    testPorts.session.list = vi.fn(async () => [candidate])
    const interactive = {
      id: candidate.id,
      events: new EventBus(),
      setPermissionPromptHandler: vi.fn(),
      submit: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
      exitCode: vi.fn(() => 0),
    }
    const resumeInteractive = vi.fn(async () => interactive)
    testPorts.session.resumeInteractive = resumeInteractive
    const renderSessionPicker = vi.fn(async () => candidate)
    const waitUntilExit = vi.fn(async () => {})
    const renderInteractiveApp = vi.fn(() => ({
      clear: vi.fn(),
      unmount: vi.fn(),
      waitUntilExit,
      waitUntilRenderFlush: vi.fn(async () => {}),
    }))
    testPorts.ui = {
      renderInteractiveApp,
      renderSessionPicker,
    } as never
    const result = await runCli(['resume'], testPorts, {
      readStdin: async () => '',
      isInteractiveTerminal: () => true,
    })
    expect(result.exitCode).toBe(0)
    expect(renderSessionPicker).toHaveBeenCalledWith({ sessions: [candidate] })
    expect(resumeInteractive).toHaveBeenCalledWith('session-42')
    expect(testPorts.session.resume).not.toHaveBeenCalled()
    expect(testPorts.trust.check).toHaveBeenCalledWith('/work')
    expect(renderInteractiveApp).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/work',
        events: interactive.events,
        resume: expect.objectContaining({
          list: expect.any(Function),
          resume: expect.any(Function),
        }),
        sessionId: 'session-42',
      }),
    )
    expect(waitUntilExit).toHaveBeenCalledOnce()
  })

  it('supports restore dry-runs and reports conflicts without writing', async () => {
    const restore = {
      restore: vi.fn(async () => ({
        restored: ['/work/a.ts'],
        conflicts: [],
        missing: false,
        dryRun: true,
      })),
    }
    const result = await runCli(['restore', 'session-42', '--dry-run'], ports({ restore }))
    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    expect(result.stdout).toContain('Would restore 1 file(s)')
    expect(restore.restore).toHaveBeenCalledWith('session-42', { dryRun: true })
  })

  it('connects stdin login without including the credential in output', async () => {
    const testPorts = ports()
    const result = await runCli(['login', 'anthropic', '--api-key-stdin'], testPorts, {
      readStdin: async () => 'super-secret\n',
    })
    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    expect(result.stdout).not.toContain('super-secret')
    expect(testPorts.auth.login).toHaveBeenCalledWith({
      provider: 'anthropic',
      credential: 'super-secret',
      flow: 'stdin',
      dangerouslySkipVerify: false,
    })
  })

  it('requires --dangerous when verification is skipped', async () => {
    const testPorts = ports()
    const result = await runCli(['login', 'anthropic', '--skip-verify'], testPorts)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('--dangerous')
    expect(testPorts.auth.login).not.toHaveBeenCalled()
  })

  it('connects logout to credential revocation', async () => {
    const testPorts = ports()
    const result = await runCli(['logout', 'anthropic'], testPorts)
    expect(result.exitCode).toBe(0)
    expect(testPorts.auth.logout).toHaveBeenCalledWith('anthropic')
  })

  it('denies an untrusted non-interactive workspace before probing or session startup', async () => {
    const testPorts = ports({
      trust: {
        check: vi.fn(async (path) => ({ canonicalPath: path, trusted: false })),
        grant: vi.fn(),
        list: vi.fn(async () => []),
        revoke: vi.fn(async () => 0),
        revokeAll: vi.fn(async () => 0),
      },
    })
    const result = await runCli(['chat', 'hello', '--json'], testPorts)
    expect(result).toMatchObject({ exitCode: 1, stderr: '' })
    expect(result.stdout).toContain('directory_untrusted')
    expect(testPorts.native.probe).not.toHaveBeenCalled()
    expect(testPorts.session.startSession).not.toHaveBeenCalled()
  })

  it('supports a scriptable exact-folder opt-in', async () => {
    const trust = {
      check: vi.fn(async (path: string) => ({ canonicalPath: path, trusted: false })),
      grant: vi.fn(async (path: string, scope: 'exact' | 'tree') => ({ path, scope })),
      list: vi.fn(async () => []),
      revoke: vi.fn(async () => 0),
      revokeAll: vi.fn(async () => 0),
    }
    const testPorts = ports({ trust })
    const result = await runCli(['chat', 'hello', '--json', '--trust-workspace'], testPorts)
    expect(result.exitCode).toBe(0)
    expect(trust.grant).toHaveBeenCalledWith(expect.any(String), 'exact')
    expect(testPorts.session.startSession).toHaveBeenCalledOnce()
  })

  it('exits an interactive trust prompt without starting any runtime', async () => {
    const testPorts = ports({
      trust: {
        check: vi.fn(async (path) => ({ canonicalPath: path, trusted: false })),
        grant: vi.fn(),
        list: vi.fn(async () => []),
        revoke: vi.fn(async () => 0),
        revokeAll: vi.fn(async () => 0),
      },
      ui: {
        renderDirectoryTrustPrompt: vi.fn(async () => 'exit' as const),
        renderInteractiveApp: vi.fn(),
      },
    })
    const result = await runCli([], testPorts, {
      isInteractiveTerminal: () => true,
      readStdin: async () => '',
    })
    expect(result.exitCode).toBe(1)
    expect(testPorts.native.probe).not.toHaveBeenCalled()
    expect(testPorts.session.startSession).not.toHaveBeenCalled()
  })

  it('lists and revokes trust rules without gating the management command', async () => {
    const trust = {
      check: vi.fn(),
      grant: vi.fn(),
      list: vi.fn(async () => [
        { path: '/work/project', scope: 'tree' as const, trustedAt: '2026-08-08T00:00:00Z' },
      ]),
      revoke: vi.fn(async () => 1),
      revokeAll: vi.fn(async () => 1),
    }
    expect((await runCli(['trust', 'list', '--json'], ports({ trust }))).stdout).toContain(
      '/work/project',
    )
    expect((await runCli(['trust', 'revoke', '--all'], ports({ trust }))).stdout).toContain(
      'Revoked 1',
    )
    expect(trust.check).not.toHaveBeenCalled()
  })

  it('searches memory through the recall port with stable JSON output', async () => {
    const recall = vi.fn(async () => [
      {
        score: 2.5,
        record: {
          schemaVersion: 1 as const,
          id: 'tooling',
          scope: { kind: 'project' as const, workspaceId: 'local', projectId: 'project' },
          content: 'Use pnpm',
          provenance: { source: 'user' as const },
          attachments: [],
          tags: ['tooling'],
          pinned: false,
          createdAt: '2027-01-15T08:00:00.000Z',
          updatedAt: '2027-01-15T08:00:00.000Z',
          deletedAt: null,
        },
      },
    ])
    const result = await runCli(
      ['memory', 'search', 'pnpm', '--scope', 'project', '--limit', '3', '--json'],
      ports({ memoryRecall: { recall } }),
    )

    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    expect(JSON.parse(result.stdout)).toMatchObject({
      query: 'pnpm',
      scope: { kind: 'project', workspaceId: 'local' },
      hits: [{ score: 2.5, record: { id: 'tooling', content: 'Use pnpm' } }],
    })
    expect(recall).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'project', workspaceId: 'local' }),
      'pnpm',
      { limit: 3, tags: [] },
    )
  })

  it('keeps memory doctor read-only and exposes reindex check/force semantics', async () => {
    const doctor = vi.fn(async () => ({
      healthy: false,
      facts: { healthy: true, records: 1, detail: 'fact snapshot is readable' },
      index: {
        healthy: false,
        status: 'dirty' as const,
        detail: 'reindex required',
        indexedRecords: 0,
        sourceRecords: 1,
      },
    }))
    const reindex = vi.fn(async () => ({
      action: 'checked' as const,
      before: {
        healthy: false,
        status: 'dirty' as const,
        detail: 'reindex required',
        indexedRecords: 0,
      },
      after: {
        healthy: false,
        status: 'dirty' as const,
        detail: 'reindex required',
        indexedRecords: 0,
      },
      durationMs: 1,
      processedRecords: 0,
    }))
    const testPorts = ports({ memoryMaintenance: { doctor, reindex } })

    expect((await runCli(['memory', 'doctor', '--strict', '--json'], testPorts)).exitCode).toBe(1)
    expect(doctor).toHaveBeenCalledOnce()
    expect((await runCli(['memory', 'reindex', '--check', '--json'], testPorts)).exitCode).toBe(1)
    expect(reindex).toHaveBeenLastCalledWith({ batchSize: 250, check: true, force: false })
    await runCli(['memory', 'reindex', '--force', '--batch-size', '10'], testPorts)
    expect(reindex).toHaveBeenLastCalledWith({ batchSize: 10, check: false, force: true })
  })
})

describe('mcp add argument parsing (SKILLS-MCPS-r1 §S3.7)', () => {
  it('parses stdio `--` passthrough, http urls, flags and rejects bad shapes', async () => {
    const { parseMcpAddArgs } = await import('./cli')
    expect(parseMcpAddArgs(['demo', '--', 'npx', '-y', 'pkg'])).toEqual({
      input: {
        name: 'demo',
        scope: 'user',
        transport: { kind: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: {} },
      },
    })
    expect(
      parseMcpAddArgs([
        '-t',
        'http',
        '-s',
        'project',
        '-H',
        'Authorization: Bearer x',
        'remote',
        'https://api.example.com/mcp',
      ]),
    ).toEqual({
      input: {
        name: 'remote',
        scope: 'project',
        transport: {
          kind: 'http',
          url: 'https://api.example.com/mcp',
          headers: { Authorization: 'Bearer x' },
          legacySse: false,
        },
      },
    })
    expect(
      parseMcpAddArgs(['-e', 'TOKEN=abc', 'demo', '--', 'node', 's.js']).input?.transport,
    ).toEqual({
      kind: 'stdio',
      command: 'node',
      args: ['s.js'],
      env: { TOKEN: 'abc' },
    })
    expect(parseMcpAddArgs(['demo', 'https://x.example.com', '--', 'cmd']).error).toBeTruthy()
    expect(parseMcpAddArgs(['demo', 'not-a-url']).error).toBeTruthy()
    expect(parseMcpAddArgs([]).error).toBeTruthy()
    expect(parseMcpAddArgs(['-t', 'ws', 'demo', '--', 'x']).error).toBeTruthy()
  })
})
