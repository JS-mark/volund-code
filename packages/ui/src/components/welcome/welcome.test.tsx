import { PassThrough, Writable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'

import { render, Text } from 'ink'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'

import type { WelcomePanelData } from '../../welcome'
import { formatDisplayCwd, getWelcomeLayout, truncateMiddle } from './welcomeLayout'
import { WelcomeScreen } from './WelcomeScreen'
import { buildWelcomeScreenState } from './welcomeStateAdapter'

class Output extends Writable {
  columns = 120
  output = ''
  _write(chunk: Buffer | string, _encoding: BufferEncoding, done: () => void) {
    this.output += chunk.toString()
    done()
  }
}
class Input extends PassThrough {
  isTTY = true
  isRaw = false
  setRawMode(value: boolean) {
    this.isRaw = value
    return this
  }
}

describe('welcome screen', () => {
  it.each([
    [{ columns: 120, rows: 30 }, 'full'],
    [{ columns: 90, rows: 24 }, 'compact'],
    [{ columns: 70, rows: 18 }, 'minimal'],
  ] as const)('selects responsive layout for %o', (size, layout) => {
    expect(getWelcomeLayout(size)).toBe(layout)
  })

  it('uses the compact logo when a PTY reports zero dimensions', () => {
    expect(getWelcomeLayout({ columns: 0, rows: 0 })).toBe('compact')
  })

  it('middle truncates long cwd while preserving the project name', () => {
    expect(
      formatDisplayCwd('/Users/volund/work/very/long/project-name', '/Users/volund', 24),
    ).toMatch(/^~\/work.*roject-name$/)
    expect(truncateMiddle('anthropic/a-very-long-model-name', 18)).toHaveLength(18)
  })

  it.each([
    [{ columns: 120, rows: 30 }, 'full'],
    [{ columns: 90, rows: 24 }, 'compact'],
    [{ columns: 70, rows: 18 }, 'minimal'],
  ] as const)('renders a unified %s first-screen shell', async (terminalSize, layout) => {
    const state = buildWelcomeScreenState({ data: fixture({ status: 'unknown' }) })
    expect(state.provider).toMatchObject({ authLabel: 'unknown', authTone: 'warning' })
    expect(state.provider.label).toContain('not configured')
    const stdout = new Output()
    const stdin = new Input()
    const view = render(
      createElement(WelcomeScreen, {
        state,
        terminalSize,
        commandInput: createElement(Text, {}, 'COMMAND INPUT'),
        bottomStatus: createElement(Text, {}, 'BOTTOM STATUS'),
      }),
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )
    await view.waitUntilRenderFlush()
    view.unmount()
    await view.waitUntilExit()
    expect(stdout.output).toContain(`TERMINAL WELCOME / ${layout.toUpperCase()}`)
    expect(stdout.output).toContain('Volund CLI  v0.0.0-test')
    if (layout !== 'minimal') expect(stdout.output).toContain('Local TUI session ready')
    expect(stdout.output).toContain('Trusted: folder')
    expect(stdout.output).toContain('not configured')
    expect(stdout.output).toContain('COMMAND INPUT')
    expect(stdout.output).toContain('BOTTOM STATUS')
    expect(stdout.output).not.toContain('COMMAND\n')
    expect(stdout.output).not.toContain('BOTTOM STATUS\nBOTTOM STATUS')
    expect(stdout.output).not.toContain('Auth OK')
  })

  it.each([
    [{ columns: 120, rows: 30 }, ['cwd /repo', 'tokens 200k remaining', 'esc interrupt']],
    [{ columns: 90, rows: 24 }, ['esc interrupt']],
    [{ columns: 70, rows: 18 }, []],
  ] as const)(
    'folds bottom status fields for %o without dropping stable agent state',
    async (terminalSize, optionalFields) => {
      const output = stripVTControlCharacters(
        await renderWelcome(terminalSize, fixture({ status: 'unknown' })),
      )
      expect(output).toContain('mode auto')
      expect(output).toContain('agent ready')
      expect(output).toContain('thinking off')
      for (const field of ['cwd /repo', 'tokens 200k remaining', 'esc interrupt']) {
        expect(output.includes(field)).toBe(optionalFields.some((item) => item === field))
      }
    },
  )

  it('keeps transient runtime status separate from the stable bottom bar', async () => {
    const output = stripVTControlCharacters(
      await renderWelcome({ columns: 120, rows: 30 }, fixture({ status: 'unknown' })),
    )
    expect(output.indexOf('BOTTOM STATUS')).toBeLessThan(output.indexOf('COMMAND INPUT'))
    expect(output.indexOf('COMMAND INPUT')).toBeLessThan(output.indexOf('mode auto'))
  })

  it.each([
    [{ columns: 120, rows: 30 }, 'full'],
    [{ columns: 90, rows: 24 }, 'compact'],
    [{ columns: 70, rows: 18 }, 'minimal'],
  ] as const)(
    'renders the Volund pixel hammer in the %s brand variant',
    async (terminalSize, _layout) => {
      const output = stripVTControlCharacters(
        await renderWelcome(terminalSize, fixture({ status: 'unknown' })),
      )
      expect(output).toContain('  ████████████████████  ')
      expect(output).toContain('████     >_         ████')
      expect(output).toContain('          ████          ')
      expect(output).not.toContain('apollo')
    },
  )

  it('keeps the full logo fixed beside long workspace and provider values', async () => {
    const output = stripVTControlCharacters(
      await renderWelcome(
        { columns: 120, rows: 30 },
        fixture({
          status: 'available',
          provider: 'anthropic-enterprise-production',
          model: 'claude-an-extremely-long-model-name-for-layout-regression',
          source: 'explicit',
        }),
        '/Users/volund/workspaces/a-very-long-enterprise-project-name-that-must-not-crush-branding',
      ),
    )
    const lines = output.split('\n').filter((line) => /^[╭│╰]/.test(line))
    expect(output).toContain('  ████████████████████  ')
    expect(output).toContain('████     >_         ████')
    expect(output).toContain('Workspace')
    expect(output).toContain('anthropic-enterprise-production')
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(120)
  })
})

async function renderWelcome(
  terminalSize: { columns: number; rows: number },
  data: WelcomePanelData,
  cwd?: string,
) {
  const stdout = new Output()
  stdout.columns = terminalSize.columns
  const view = render(
    createElement(WelcomeScreen, {
      state: buildWelcomeScreenState({ data: { ...data, cwd: cwd ?? data.cwd } }),
      terminalSize,
      commandInput: createElement(Text, {}, 'COMMAND INPUT'),
      bottomStatus: createElement(Text, {}, 'BOTTOM STATUS'),
    }),
    {
      debug: true,
      interactive: false,
      patchConsole: false,
      stdin: new Input() as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    },
  )
  await view.waitUntilRenderFlush()
  view.unmount()
  await view.waitUntilExit()
  return stdout.output
}

function fixture(model: WelcomePanelData['model']): WelcomePanelData {
  return {
    version: '0.0.0-test',
    sessionId: 'session-123456',
    cwd: '/repo',
    model,
    sandbox: {
      status: 'available',
      tier: 'full',
      mechanism: 'seatbelt',
      filesystem: 'isolated',
      network: 'available',
    },
    permission: { mode: 'ask', dangerous: false, source: 'default' },
    config: {
      effectiveSources: ['defaults'],
      user: { status: 'disabled' },
      project: { status: 'disabled' },
    },
    mcp: { status: 'disabled' },
    history: { status: 'disabled' },
  }
}
