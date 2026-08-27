import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import {
  MINIMAL_ENV_KEYS,
  PINNED_UNIX_SHELL,
  minimalEnv,
  quoteShellArgument,
  resolvePwshPath,
  selectShell,
} from './bash-shell'
import { BashTool } from './index'

const run = promisify(execFile)
// Real-shell contract tests need /bin/bash; they are skipped on Windows runners.
const itUnix = it.skipIf(process.platform === 'win32')

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('selectShell (r13-I11)', () => {
  it('pins /bin/bash -c on every unix platform and never reads $SHELL', () => {
    const original = process.env.SHELL
    process.env.SHELL = '/usr/bin/fish-with-rc-side-effects'
    try {
      for (const platform of ['darwin', 'linux', 'freebsd']) {
        expect(selectShell(platform)).toEqual({
          program: PINNED_UNIX_SHELL,
          args: ['-c'],
          quoting: 'posix',
        })
      }
    } finally {
      if (original === undefined) delete process.env.SHELL
      else process.env.SHELL = original
    }
  })

  it('ignores windows options on unix platforms', () => {
    const selection = selectShell('darwin', { windowsShell: 'C:\\shells\\pwsh.exe' })
    expect(selection.program).toBe(PINNED_UNIX_SHELL)
    expect(selection.args).toEqual(['-c'])
  })

  it('prefers PowerShell 7+ over cmd on Windows when pwsh is resolvable', () => {
    const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    expect(selectShell('win32', { pwshPath: pwsh })).toEqual({
      program: pwsh,
      args: ['-Command'],
      quoting: 'windows',
    })
  })

  it('falls back to the command processor when PowerShell is absent', () => {
    expect(selectShell('win32')).toEqual({
      program: 'cmd.exe',
      args: ['/C'],
      quoting: 'windows',
    })
    expect(selectShell('win32', { commandProcessor: 'C:\\Windows\\System32\\cmd.exe' })).toEqual({
      program: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/C'],
      quoting: 'windows',
    })
  })

  it('honors the [tools] windows_shell override above detection', () => {
    const override = 'C:\\shells\\pwsh.exe'
    expect(
      selectShell('win32', { windowsShell: override, pwshPath: 'C:\\other\\pwsh.exe' }),
    ).toEqual({
      program: override,
      args: ['-Command'],
      quoting: 'windows',
    })
    expect(selectShell('win32', { windowsShell: 'C:\\Windows\\System32\\cmd.exe' }).args).toEqual([
      '/C',
    ])
  })
})

describe('minimalEnv (r13-I11)', () => {
  it('inherits only PATH/HOME/LANG/TZ from the host environment', () => {
    const inherited = minimalEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/volund',
      LANG: 'en_US.UTF-8',
      TZ: 'UTC',
      SHELL: '/usr/bin/fish',
      SECRET_API_TOKEN: 'leak-me',
      AWS_PROFILE: 'leak-me-too',
    })
    expect(inherited).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/volund',
      LANG: 'en_US.UTF-8',
      TZ: 'UTC',
    })
  })

  it('omits TZ (and any other minimal key) when it is unset on the host', () => {
    const inherited = minimalEnv({ PATH: '/bin', HOME: '/home/volund', LANG: 'C.UTF-8' })
    expect(inherited).not.toHaveProperty('TZ')
    expect(Object.keys(inherited).sort()).toEqual(['HOME', 'LANG', 'PATH'])
  })

  it('expands the pass_through_env whitelist and skips unset names', () => {
    const inherited = minimalEnv(
      { PATH: '/bin', HOME: '/home/volund', VOLUND_TUNING_DIR: '/tmp/tuning', SECRET: 'nope' },
      ['VOLUND_TUNING_DIR', 'VOLUND_UNSET'],
    )
    expect(inherited.VOLUND_TUNING_DIR).toBe('/tmp/tuning')
    expect(inherited).not.toHaveProperty('VOLUND_UNSET')
    expect(inherited).not.toHaveProperty('SECRET')
  })

  it('matches whitelist names exactly (no case folding)', () => {
    const inherited = minimalEnv({ PATH: '/bin', HOME: '/home/volund', path: '/sneaky' }, ['path'])
    expect(inherited.path).toBe('/sneaky')
    expect(inherited.PATH).toBe('/bin')
    expect(Object.keys(inherited).sort()).toEqual(['HOME', 'PATH', 'path'])
  })

  it('documents the pinned minimal key set', () => {
    expect([...MINIMAL_ENV_KEYS]).toEqual(['PATH', 'HOME', 'LANG', 'TZ'])
  })
})

describe('quoteShellArgument', () => {
  itUnix('posix-quoting survives a round trip through /bin/sh -c as one argument', async () => {
    const command = "echo 'volund && $HOME' | tr a-z A-Z"
    const quoted = quoteShellArgument(command, 'posix')
    const { stdout } = await run('/bin/sh', ['-c', `/usr/bin/printf '%s' ${quoted}`])
    expect(stdout).toBe(command)
  })

  it('windows-quoting escapes embedded double quotes', () => {
    expect(quoteShellArgument('Write-Output "hi"', 'windows')).toBe('"Write-Output \\"hi\\""')
  })
})

describe('resolvePwshPath', () => {
  it('finds pwsh.exe on the PATH and reports absence without it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'volund-pwsh-'))
    dirs.push(dir)
    await writeFile(join(dir, 'pwsh.exe'), '#!/bin/sh\nexit 0\n')
    await chmod(join(dir, 'pwsh.exe'), 0o755)
    const empty = await mkdtemp(join(tmpdir(), 'volund-pwsh-empty-'))
    dirs.push(empty)
    await mkdir(empty, { recursive: true })
    expect(await resolvePwshPath({ PATH: `${dir};${empty}` })).toBe(join(dir, 'pwsh.exe'))
    expect(await resolvePwshPath({ PATH: empty })).toBeUndefined()
    expect(await resolvePwshPath({})).toBeUndefined()
  })
})

describe('BashTool shell + env inheritance contract (r13-I11)', () => {
  function toolContext(
    execute: (command: string, args: string[], env?: Record<string, string>) => Promise<string>,
  ) {
    return {
      abortSignal: new AbortController().signal,
      session: { id: 'session-1', cwd: process.cwd(), turnId: 'turn-1' },
      native: {
        execute: async (
          command: string,
          args: string[],
          _signal: AbortSignal,
          env?: Record<string, string>,
        ) => execute(command, args, env),
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      ui: { requestInput: async () => '' },
    }
  }
  /** Mirrors the runtime wiring: the sandbox wraps the flattened invocation in /bin/sh -c. */
  async function sandboxLikeExecute(
    command: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<string> {
    const { stdout } = await run('/bin/sh', ['-c', [command, ...args].join(' ')], {
      env: env ?? process.env,
      timeout: 10_000,
    })
    return stdout
  }

  itUnix(
    'hands the pinned shell, quoted command, and minimal env to the native bridge',
    async () => {
      const calls: Array<{
        command: string
        args: string[]
        env: Record<string, string> | undefined
      }> = []
      const tool = new BashTool({ platform: 'darwin' })
      const original = process.env.VOLUND_REM57_JUNK
      process.env.VOLUND_REM57_JUNK = 'host-secret'
      try {
        await tool.invoke(
          { command: 'echo hi' },
          toolContext(async (command, args, env) => {
            calls.push({ command, args, env })
            return ''
          }),
        )
      } finally {
        if (original === undefined) delete process.env.VOLUND_REM57_JUNK
        else process.env.VOLUND_REM57_JUNK = original
      }
      expect(calls).toHaveLength(1)
      expect(calls[0]!.command).toBe(PINNED_UNIX_SHELL)
      expect(calls[0]!.args[0]).toBe('-c')
      expect(quoteShellArgument('echo hi', 'posix')).toBe(calls[0]!.args[1])
      expect(calls[0]!.env).toBeDefined()
      expect(calls[0]!.env!.HOME).toBe(process.env.HOME)
      expect(calls[0]!.env!.PATH).toBe(process.env.PATH)
      expect(calls[0]!.env).not.toHaveProperty('VOLUND_REM57_JUNK')
      expect(calls[0]!.env).not.toHaveProperty('SHELL')
    },
  )

  itUnix('forwards the pass_through_env whitelist into the inherited env', async () => {
    const calls: Array<{ env: Record<string, string> | undefined }> = []
    const tool = new BashTool({ platform: 'linux', passThroughEnv: ['VOLUND_PASS_ME'] })
    process.env.VOLUND_PASS_ME = 'passed'
    try {
      await tool.invoke(
        { command: 'true' },
        toolContext(async (_command, _args, env) => {
          calls.push({ env })
          return ''
        }),
      )
    } finally {
      delete process.env.VOLUND_PASS_ME
    }
    expect(calls[0]!.env?.VOLUND_PASS_ME).toBe('passed')
  })

  /** Extracts the text part of a ToolResult so string assertions read naturally. */
  function resultText(r: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
    return r.content.find((part) => part.type === 'text')?.text ?? ''
  }

  itUnix('runs pipelines and variable expansion under the pinned bash', async () => {
    const tool = new BashTool({ platform: process.platform })
    const piped = resultText(
      await tool.invoke({ command: 'echo volund | tr a-z A-Z' }, toolContext(sandboxLikeExecute)),
    )
    expect(piped.trim()).toBe('VOLUND')
    const home = resultText(
      await tool.invoke({ command: 'printf %s "$HOME"' }, toolContext(sandboxLikeExecute)),
    )
    expect(home).toBe(minimalEnv(process.env).HOME)
  })

  itUnix('does not inherit the host $SHELL value into the sandbox shell', async () => {
    // bash self-initializes $SHELL from /etc/passwd when it is absent, so the
    // contract here is "the host value must not appear", not "$SHELL unset".
    const sentinel = '/usr/bin/fish-with-rc-side-effects'
    const original = process.env.SHELL
    process.env.SHELL = sentinel
    try {
      const tool = new BashTool({ platform: process.platform })
      const out = resultText(
        await tool.invoke(
          { command: 'printf %s "${SHELL:-absent}"' },
          toolContext(sandboxLikeExecute),
        ),
      )
      expect(out).not.toBe(sentinel)
    } finally {
      if (original === undefined) delete process.env.SHELL
      else process.env.SHELL = original
    }
  })

  itUnix('does not leak unrelated host variables into the sandbox env', async () => {
    const original = process.env.VOLUND_REM57_JUNK
    process.env.VOLUND_REM57_JUNK = 'host-secret'
    try {
      const tool = new BashTool({ platform: process.platform })
      const env = resultText(await tool.invoke({ command: 'env' }, toolContext(sandboxLikeExecute)))
      expect(env).not.toContain('VOLUND_REM57_JUNK')
      expect(env).toContain('PATH=')
      // darwin: HOME must be inherited or bash cannot start.
      expect(env).toContain('HOME=')
    } finally {
      if (original === undefined) delete process.env.VOLUND_REM57_JUNK
      else process.env.VOLUND_REM57_JUNK = original
    }
  })

  itUnix('falls back to cmd.exe /C with windows quoting on win32 when pwsh is absent', async () => {
    // On a unix runner the PATH uses ':' separators, so the Windows-style pwsh
    // scan is deterministically empty and the command processor is selected.
    const calls: Array<{ command: string; args: string[] }> = []
    const tool = new BashTool({ platform: 'win32' })
    await tool.invoke(
      { command: 'echo hi' },
      toolContext(async (command, args) => {
        calls.push({ command, args })
        return ''
      }),
    )
    expect(calls[0]!.command).toBe('cmd.exe')
    expect(calls[0]!.args).toEqual(['/C', '"echo hi"'])
  })

  it('routes the windows_shell override through BashTool without pwsh detection', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const tool = new BashTool({ platform: 'win32', windowsShell: 'C:\\shells\\pwsh.exe' })
    await tool.invoke(
      { command: 'echo hi' },
      toolContext(async (command, args) => {
        calls.push({ command, args })
        return ''
      }),
    )
    expect(calls[0]!.command).toBe('C:\\shells\\pwsh.exe')
    expect(calls[0]!.args).toEqual(['-Command', '"echo hi"'])
  })
})
