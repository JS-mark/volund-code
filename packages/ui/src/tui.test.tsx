import { PassThrough, Writable } from 'node:stream'

import { EventBus } from '@apollo-code/core'
import { render } from 'ink'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { runSlashCommand, type SlashCommand } from './app'
import { InputBox } from './components/InputBox'
import { ModelPicker } from './components/ModelPicker'
import { ScrollableTranscript } from './components/ScrollableTranscript'
import { SelectList } from './components/SelectList'
import { SessionPicker } from './components/SessionPicker'
import { StatusPanel } from './components/StatusPanel'
import { TabBar } from './components/TabBar'
import { PermissionPromptController } from './permission'
import { renderInteractiveApp } from './tui'
import type { WelcomePanelData } from './welcome'

class MemoryWriteStream extends Writable {
  columns = 80
  rows = 24
  isTTY = false
  output = ''

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    this.output += chunk.toString()
    callback()
  }
}

class MemoryReadStream extends PassThrough {
  isRaw = false
  isTTY = true
  ref() {
    return this
  }
  setRawMode(_enabled: boolean) {
    this.isRaw = _enabled
    return this
  }
  unref() {
    return this
  }
}

describe('renderInteractiveApp', () => {
  it('renders while the sandbox probe is pending and backfills the badge when it settles (r13-P1)', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    let resolveProbe!: (value: {
      sandbox: import('./welcome').WelcomeSandboxStatus
      status: string
    }) => void
    const probe = new Promise<{
      sandbox: import('./welcome').WelcomeSandboxStatus
      status: string
    }>((resolve) => {
      resolveProbe = resolve
    })
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        sessionId: 'session-1234567890',
        status: 'sandbox probing',
        welcome: { ...welcomeFixture(), sandbox: { status: 'probing' } },
        sandboxProbe: () => probe,
      },
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await app.waitUntilRenderFlush()
    // The REPL is usable while probing: welcome shows the probing badge.
    expect(stdout.output).toContain('probing')
    expect(stdout.output).not.toContain('sandbox partial')

    resolveProbe({
      sandbox: {
        status: 'available',
        tier: 'full',
        mechanism: 'seatbelt',
        filesystem: 'isolated',
        network: 'available',
      },
      status: 'sandbox full',
    })
    await app.waitUntilRenderFlush()
    await app.unmount()
    await app.waitUntilExit()
    // Backfill refreshed both the welcome badge and the status line.
    expect(stdout.output).toContain('seatbelt (full)')
    expect(stdout.output).toContain('sandbox full')
  })

  it('renders and switches all three status tabs at narrow width', async () => {
    const stdout = new MemoryWriteStream()
    stdout.columns = 42
    const stdin = new MemoryReadStream()
    const panel = render(
      createElement(StatusPanel, {
        data: {
          settings: [{ label: 'Language', value: 'system' }],
          status: [{ label: 'Version', value: '1.0.0' }],
          config: [
            {
              id: 'notifications',
              label: 'Notifications',
              value: false,
              editable: true,
              kind: 'boolean',
            },
          ],
        },
      }),
      {
        debug: true,
        interactive: true,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )
    await panel.waitUntilRenderFlush()
    expect(stdout.output).toContain('> /status')
    expect(stdout.output).toContain('Version')
    stdin.write('\u001B[C')
    await panel.waitUntilRenderFlush()
    expect(stdout.output).toContain('Notifications')
    stdin.write('\u001B[C')
    await panel.waitUntilRenderFlush()
    expect(stdout.output).toContain('Language')
    panel.unmount()
    await panel.waitUntilExit()
  })

  it('renders the welcome panel before the first turn', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        sessionId: 'session-1234567890',
        status: 'ready',
        welcome: welcomeFixture(),
      },
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await app.waitUntilRenderFlush()
    await app.unmount()
    await app.waitUntilExit()

    expect(stdout.output).toContain('Apollo Code  v0.0.0-test')
    expect(stdout.output).toContain('Session')
    expect(stdout.output).toContain('session-1234')
    expect(stdout.output).toContain('Model')
    expect(stdout.output).toContain('runtime resolved')
    expect(stdout.output).toContain('MCP')
    expect(stdout.output).toContain('1 connected / 2 configured')
    expect(stdout.output).toMatch(/>\s*▌Ask Apollo/)
    expect(stdout.output).not.toContain('apollo >')
    expect(stdout.output).toContain('agent ready')
    expect(stdout.output).toContain('mode auto')
    expect(stdout.output).toContain('thinking off')
    expect(stdout.output).toContain('esc interrupt')
    expect(stdout.output).not.toContain('Ready. Start with a message or /help.')
  })

  it('shows permission status transiently without replacing stable welcome state', async () => {
    const permissions = new PermissionPromptController()
    const pending = permissions.request({
      display: {
        approvable: true,
        spec: '{"fs":{"write":["/repo/output.txt"]}}',
        toolName: 'write',
      },
      id: 'permission-1',
      attempt: 1,
      input: { path: '/repo/output.txt' },
      spec: { fs: { write: ['/repo/output.txt'] } },
      toolName: 'write',
    })
    const stdout = new MemoryWriteStream()
    stdout.columns = 120
    stdout.rows = 30
    const app = renderInteractiveApp(
      { cwd: '/repo', permissions, welcome: welcomeFixture() },
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: new MemoryReadStream() as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await app.waitUntilRenderFlush()
    app.unmount()
    await app.waitUntilExit()
    permissions.decide(permissions.requests()[0]!.id, { kind: 'deny' })
    await pending

    expect(stdout.output).toContain('permission required')
    expect(stdout.output).toContain('mode auto')
    expect(stdout.output).toContain('agent ready')
    expect(stdout.output).toContain('thinking off')
  })

  it.each([
    [120, 30, 'FULL'],
    [90, 24, 'COMPACT'],
    [70, 18, 'MINIMAL'],
  ] as const)('renders a unified welcome shell at %sx%s', async (columns, rows, layout) => {
    const stdout = new MemoryWriteStream()
    stdout.columns = columns
    stdout.rows = rows
    const app = renderInteractiveApp(
      { cwd: '/repo', welcome: welcomeFixture() },
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: new MemoryReadStream() as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await app.waitUntilRenderFlush()
    app.unmount()
    await app.waitUntilExit()

    expect(stdout.output).toContain(`TERMINAL WELCOME / ${layout}`)
    expect(stdout.output).toMatch(/>\s*▌Ask Apollo/)
    expect(stdout.output).not.toContain('apollo >')
    expect(stdout.output).toContain('agent ready')
    expect(stdout.output).not.toContain('Ready. Start with a message or /help.')
  })

  it('rerenders the welcome layout when the terminal window is resized', async () => {
    const stdout = new MemoryWriteStream()
    stdout.columns = 120
    stdout.rows = 30
    const app = renderInteractiveApp(
      { cwd: '/repo', welcome: welcomeFixture() },
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: new MemoryReadStream() as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await app.waitUntilRenderFlush()
    expect(stdout.output).toContain('TERMINAL WELCOME / FULL')

    stdout.columns = 70
    stdout.rows = 18
    stdout.emit('resize')
    await app.waitUntilRenderFlush()

    app.unmount()
    await app.waitUntilExit()
    expect(stdout.output).toContain('TERMINAL WELCOME / MINIMAL')
  })

  it('hides the welcome shell after the first prompt without changing submission', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const submitted = vi.fn()
    const app = renderInteractiveApp(
      { cwd: '/repo', onSubmit: submitted, welcome: welcomeFixture() },
      {
        debug: true,
        interactive: true,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    stdin.write('hello')
    await app.waitUntilRenderFlush()
    stdin.write('\r')
    await app.waitUntilRenderFlush()
    app.unmount()
    await app.waitUntilExit()

    expect(submitted).toHaveBeenCalledWith('hello', undefined)
    expect(stdout.output).toContain('Ready. Start with a message or /help.')
    expect(stdout.output.lastIndexOf('WELCOME /')).toBeLessThan(
      stdout.output.lastIndexOf('Ready. Start with a message or /help.'),
    )
  })

  it('does not override the configured model when the user never opened the picker', async () => {
    // 回归：modelPicker 的展示默认值（硬编码 anthropic/claude-sonnet-4-20250514）曾被
    // 当作 explicitModel 随每次 submit 发给 router，把 [provider.anthropic] model
    // 配置整个盖掉（企业网关因此 400）。未显式选择时 submit 不得携带 model。
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const submitted = vi.fn()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        modelPicker: {
          currentModelId: 'anthropic/claude-sonnet-4-20250514',
          models: [
            {
              id: 'anthropic/claude-sonnet-4-20250514',
              provider: 'anthropic',
              model: 'claude-sonnet-4-20250514',
              label: 'Claude Sonnet 4',
            },
          ],
        },
        onSubmit: submitted,
        welcome: welcomeFixture(),
      },
      {
        debug: true,
        interactive: true,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    stdin.write('hello')
    await app.waitUntilRenderFlush()
    stdin.write('\r')
    await app.waitUntilRenderFlush()
    app.unmount()
    await app.waitUntilExit()

    expect(submitted).toHaveBeenCalledWith('hello', undefined)
  })

  it('renders the static Ink shell and stream updates', async () => {
    const events = new EventBus()
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        events,
        initialInput: 'hello',
        sessionId: 'session-1234567890',
        status: 'ready',
      },
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await app.waitUntilRenderFlush()
    // Ink's render flush can resolve before React has committed the event-subscription effect.
    // Yield once so this test never emits stream events into an unsubscribed EventBus.
    await new Promise<void>((resolve) => setImmediate(resolve))

    await events.emit({
      payload: { messageId: 'm-1' },
      sessionId: 'session-1234567890',
      type: 'stream.started',
      version: 1,
    })
    await events.emit({
      payload: { messageId: 'm-1', kind: 'text', fragment: 'pong' },
      sessionId: 'session-1234567890',
      type: 'stream.delta',
      version: 1,
    })
    await events.emit({
      payload: { messageId: 'm-1' },
      sessionId: 'session-1234567890',
      type: 'stream.completed',
      version: 1,
    })
    // 附录 D.2 真实时序（runner.ts）：stream.completed 后紧跟 message.appended，
    // 定稿 entry 由 message.appended 落 transcript。
    await events.emit({
      payload: {
        messageId: 'm-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'pong' }],
      },
      sessionId: 'session-1234567890',
      type: 'message.appended',
      version: 1,
    })
    await app.waitUntilRenderFlush()

    await app.unmount()
    await app.waitUntilExit()

    expect(stdout.output).toContain('Apollo')
    expect(stdout.output).toContain('/repo')
    expect(stdout.output).toContain('> hello')
    expect(stdout.output).toContain('pong')
  })

  it('renders slash command suggestions', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        initialInput: '/',
      },
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await app.waitUntilRenderFlush()
    await app.unmount()
    await app.waitUntilExit()

    expect(stdout.output).toContain('> /help Show slash commands')
    expect(stdout.output).toContain('/status Show runtime status (not available)')
    expect(stdout.output).toContain('/context Show context status (not available)')
    expect(stdout.output).toContain('/memory Browse and manage memory (not available)')
    expect(stdout.output).toContain('/resume Resume a saved session (not available)')
  })

  it('lists /resume, switches bindings, and does not store the slash command in input history', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const append = vi.fn()
    const submit = vi.fn(async () => {})
    const candidate = {
      id: 'target-session',
      cwd: '/target',
      updatedAt: '2026-08-10T00:00:00Z',
      title: 'Target work',
    }
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        history: { append, list: () => [] },
        initialInput: '/resume',
        resume: {
          list: vi.fn(async () => [candidate]),
          resume: vi.fn(async () => ({
            cwd: candidate.cwd,
            id: candidate.id,
            onExit: async () => {},
            onSubmit: submit,
            transcript: [{ id: 'old', role: 'user' as const, text: 'restored context' }],
          })),
        },
      },
      {
        debug: true,
        interactive: true,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await app.waitUntilRenderFlush()
    stdin.write('\r')
    await vi.waitFor(() => expect(stdout.output).toContain('Resume session'))
    // Seeing the picker output does not guarantee its useInput subscription has
    // committed yet. Under a busy CI runner, an immediate Enter can still be
    // handled by the command input that opened the picker.
    await app.waitUntilRenderFlush()
    stdin.write('\r')
    await vi.waitFor(() => expect(stdout.output).toContain('restored context'))
    stdin.write('after switch')
    await app.waitUntilRenderFlush()
    stdin.write('\r')
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith('after switch', undefined))

    expect(append).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledWith('after switch')
    app.unmount()
    await app.waitUntilExit()
  })

  it('runs /undo as single steps and surfaces all three prompt paths (r13-G4)', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const sessionIds: string[] = []
    const outcomes: Array<import('./app').UndoStepOutcome> = [
      { undone: true, paths: ['/repo/project.txt'], warnings: [] },
      {
        undone: true,
        paths: ['/repo/project.txt'],
        warnings: [{ path: '/repo/project.txt', kind: 'target_modified' }],
      },
      { undone: false, reason: 'no_backup', paths: [], warnings: [] },
    ]
    let next = 0
    const undoStep = async (sessionId: string) => {
      sessionIds.push(sessionId)
      return outcomes[next++]!
    }
    const app = renderInteractiveApp(
      { cwd: '/repo', initialInput: '/undo', sessionId: 'session-undo-1', undo: { undoStep } },
      {
        debug: true,
        interactive: true,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await app.waitUntilRenderFlush()
    stdin.write('\r')
    // Success: the newest unconsumed backup step is restored.
    await vi.waitFor(() => expect(stdout.output).toContain('undo: restored 1 file(s)'))
    expect(stdout.output).toContain('restored /repo/project.txt')
    expect(stdout.output).toContain('undid 1 file(s)')

    stdin.write('/undo')
    await app.waitUntilRenderFlush()
    stdin.write('\r')
    // Warning path: restore still happens, the user is told manual changes
    // may have been overwritten (spec 08-session-config.md §8.6.2).
    await vi.waitFor(() =>
      expect(stdout.output).toContain('undo restored with warnings (may have overwritten'),
    )
    expect(stdout.output).toContain('warning: /repo/project.txt was modified after the backup')

    stdin.write('/undo')
    await app.waitUntilRenderFlush()
    stdin.write('\r')
    // Nothing left: the exact StatusLine message from the spec.
    await vi.waitFor(() =>
      expect(stdout.output).toContain('nothing to undo (no backup for last side-effecting tool)'),
    )
    expect(sessionIds).toEqual(['session-undo-1', 'session-undo-1', 'session-undo-1'])

    app.unmount()
    await app.waitUntilExit()
  })

  it('switches slash command suggestions with arrow keys', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const submitted: string[] = []
    const input = render(
      createElement(InputBox, {
        initialValue: '/',
        onSubmit: (value) => {
          submitted.push(value)
        },
        slashCommands: [
          { name: 'help', description: 'Show slash commands', run: () => {} },
          { name: 'model', description: 'Switch model', run: () => {} },
          { available: false, name: 'context', description: 'Show context status', run: () => {} },
        ],
      }),
      {
        debug: true,
        interactive: true,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await input.waitUntilRenderFlush()
    expect(stdout.output).toContain('> /help Show slash commands')

    stdin.write('\u001B[B')
    await input.waitUntilRenderFlush()
    expect(stdout.output).toContain('> /model Switch model')

    stdin.write('\r')
    await input.waitUntilRenderFlush()
    input.unmount()
    await input.waitUntilExit()

    expect(submitted).toEqual(['/model'])
  })

  it('renders an open-ended command band with placeholder and a visible entry cursor', async () => {
    const stdout = new MemoryWriteStream()
    stdout.columns = 100
    const input = render(
      createElement(InputBox, { placeholder: 'Ask Apollo', terminalColumns: 100 }),
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: new MemoryReadStream() as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await input.waitUntilRenderFlush()
    input.unmount()
    await input.waitUntilExit()

    expect(stdout.output).toContain('> ▌Ask Apollo')
    expect(stdout.output).not.toContain('apollo >')
    expect(stdout.output).toContain('─')
    expect(stdout.output).not.toMatch(/[┌┐└┘│]/)
    expect(stdout.output).toContain('Enter send / Shift+Enter newline')
  })

  it('blinks the entry cursor while idle', async () => {
    const stdout = new MemoryWriteStream()
    stdout.columns = 100
    const input = render(
      createElement(InputBox, { placeholder: 'Ask Apollo', terminalColumns: 100 }),
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: new MemoryReadStream() as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await input.waitUntilRenderFlush()
    await new Promise((resolve) => setTimeout(resolve, 700))
    input.unmount()
    await input.waitUntilExit()

    expect(stdout.output).toContain('> ▌Ask Apollo')
    expect(stdout.output).toContain('>  Ask Apollo')
  })

  it('keeps the cursor visible at the end of typed input', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const input = render(createElement(InputBox, { terminalColumns: 100 }), {
      debug: true,
      interactive: true,
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    stdin.write('hello')
    await input.waitUntilRenderFlush()
    input.unmount()
    await input.waitUntilExit()

    expect(stdout.output).toContain('> hello▌')
  })

  it('renders the session search as an input band with a placeholder', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const picker = render(
      createElement(SessionPicker, {
        onCancel: vi.fn(),
        onSelect: vi.fn(),
        placeholder: 'Find a saved session',
        sessions: [
          {
            cwd: '/repo',
            id: 'session-1234567890',
            title: 'Apollo session',
            updatedAt: '2026-08-10T00:00:00Z',
          },
        ],
      }),
      {
        debug: true,
        interactive: true,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await picker.waitUntilRenderFlush()
    expect(stdout.output).toContain('> ▌Find a saved session')
    expect(stdout.output).toContain('─')

    picker.unmount()
    await picker.waitUntilExit()
  })

  it('hides the shortcut hint at narrow widths', async () => {
    const stdout = new MemoryWriteStream()
    stdout.columns = 60
    const input = render(
      createElement(InputBox, { placeholder: 'Ask Apollo', terminalColumns: 60 }),
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: new MemoryReadStream() as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await input.waitUntilRenderFlush()
    input.unmount()
    await input.waitUntilExit()

    expect(stdout.output).toContain('Ask Apollo')
    expect(stdout.output).not.toContain('Enter send / Shift+Enter newline')
  })

  it('does not submit empty input and preserves multiline input', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const submitted = vi.fn()
    const input = render(
      createElement(InputBox, {
        onSubmit: submitted,
        terminalColumns: 100,
      }),
      {
        debug: true,
        interactive: true,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    stdin.write('\r')
    await input.waitUntilRenderFlush()
    expect(submitted).not.toHaveBeenCalled()

    stdin.write('first line')
    stdin.write('\u001B\r')
    stdin.write('second line')
    await input.waitUntilRenderFlush()
    expect(stdout.output).toContain('first line')
    expect(stdout.output).toContain('second line')

    input.unmount()
    await input.waitUntilExit()
  })

  it('advertises /model as available when model picker data exists', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        initialInput: '/',
        modelPicker: modelPickerFixture(),
      },
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await app.waitUntilRenderFlush()
    await app.unmount()
    await app.waitUntilExit()

    expect(stdout.output).toContain('/model Switch model')
    expect(stdout.output).not.toContain('/model Switch model (not available)')
  })

  it('opens /status and closes it with escape', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        initialInput: '/status',
        welcome: welcomeFixture(),
      },
      {
        debug: true,
        interactive: true,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await app.waitUntilRenderFlush()
    stdin.write('\r')
    await app.waitUntilRenderFlush()
    expect(stdout.output).toContain('Status')
    expect(stdout.output).toContain('Workspace')
    expect(stdout.output).toContain('MCP servers')
    expect(stdout.output).toContain('Settings sources')

    stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 40))
    await app.waitUntilRenderFlush()
    await app.unmount()
    await app.waitUntilExit()

    expect(stdout.output).toContain('status closed')
  })

  it('opens /model and moves between available and unavailable models', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const selectedModels: string[] = []
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        initialInput: '/model',
        modelPicker: twoModelPickerFixture(),
        onModelSelect: (model) => {
          selectedModels.push(model)
        },
      },
      {
        debug: true,
        interactive: true,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await app.waitUntilRenderFlush()
    stdin.write('\r')
    await app.waitUntilRenderFlush()
    expect(stdout.output).toContain('Select model')
    expect(stdout.output).toContain('> * Sonnet')

    stdin.write('\u001B[B')
    await app.waitUntilRenderFlush()
    expect(stdout.output).toContain('>   Opus  Unavailable')

    stdin.write('\r')
    await app.waitUntilRenderFlush()
    expect(selectedModels).toEqual([])
    expect(stdout.output).not.toContain('Model set to Opus')

    stdin.write('\u001B[A')
    await app.waitUntilRenderFlush()
    stdin.write('\r')
    await app.waitUntilRenderFlush()
    await vi.waitFor(() => {
      expect(selectedModels).toEqual(['anthropic/sonnet'])
      expect(stdout.output).toContain('Model set to Sonnet')
    })

    await app.unmount()
    await app.waitUntilExit()
  })

  it('reports unavailable and unknown slash commands without throwing', async () => {
    const commands: SlashCommand[] = [
      {
        available: false,
        description: 'Show context status',
        name: 'context',
        run: () => {},
      },
    ]

    await expect(runSlashCommand('/context', commands)).resolves.toBe(
      '/context is not available in this build/session',
    )
    await expect(runSlashCommand('/missing', commands)).resolves.toBe(
      'Unknown slash command: /missing',
    )
  })

  it('buffers stream deltas before rendering', async () => {
    const events = new EventBus()
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        events,
      },
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await events.emit({
      payload: { messageId: 'm-1' },
      sessionId: 'session-1',
      type: 'stream.started',
      version: 1,
    })
    await events.emit({
      payload: { messageId: 'm-1', kind: 'text', fragment: 'a' },
      sessionId: 'session-1',
      type: 'stream.delta',
      version: 1,
    })
    await events.emit({
      payload: { messageId: 'm-1', kind: 'text', fragment: 'b' },
      sessionId: 'session-1',
      type: 'stream.delta',
      version: 1,
    })
    await app.waitUntilRenderFlush()
    expect(stdout.output).not.toContain('ab')

    await new Promise((resolve) => setTimeout(resolve, 40))
    await app.waitUntilRenderFlush()
    await app.unmount()
    await app.waitUntilExit()

    expect(stdout.output).toContain('ab')
  })

  it('renders conversation entries as marker + text, without YOU/APOLLO labels', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const transcript = render(
      createElement(ScrollableTranscript, {
        entries: [
          { id: 'u1', role: 'user' as const, text: 'fix the flaky test' },
          { id: 'a1', role: 'assistant' as const, text: 'looking at the spec now' },
        ],
      }),
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await transcript.waitUntilRenderFlush()
    transcript.unmount()
    await transcript.waitUntilExit()

    expect(stdout.output).toContain('> fix the flaky test')
    expect(stdout.output).toContain('⏺ looking at the spec now')
    expect(stdout.output).not.toContain('YOU')
    expect(stdout.output).not.toContain('APOLLO')
  })

  it('renders queued permission prompts', async () => {
    const permissions = new PermissionPromptController()
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        permissions,
      },
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    const rawCommand = 'touch x\u202E'
    const rawRequest = {
      display: {
        approvable: true,
        spec: '{"bash":{"command":"touch x\\u{202E}"}}',
        toolName: 'Bash',
      },
      attempt: 1,
      id: 'permission-1',
      input: { command: rawCommand },
      spec: { bash: { command: rawCommand } },
      toolName: 'Bash',
    } as const
    void permissions.request(rawRequest)
    void permissions.request({
      display: {
        approvable: true,
        spec: '{"fs":{"write":["x"]}}',
        toolName: 'Write',
      },
      attempt: 1,
      id: 'permission-2',
      input: {},
      spec: { fs: { write: ['x'] } },
      toolName: 'Write',
    })
    await app.waitUntilRenderFlush()
    await app.unmount()
    await app.waitUntilExit()

    expect(stdout.output).toContain('Permission required: Bash')
    expect(stdout.output).toContain('touch x\\u{202E}')
    expect(stdout.output).not.toContain(rawCommand)
    expect(permissions.requests()[0]).toEqual(rawRequest)
    expect(stdout.output).toContain('1 queued')
  })

  it('renders sensitive permission details as deny-only and ignores approval keys', async () => {
    const permissions = new PermissionPromptController()
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const pending = permissions.request({
      display: {
        approvable: false,
        spec: '[sensitive permission details hidden - deny only]',
        toolName: 'Bash',
      },
      attempt: 1,
      id: 'permission-sensitive',
      input: { command: 'echo token=[REDACTED]' },
      spec: { bash: { command: 'echo token=[REDACTED]' } },
      toolName: 'Bash',
    })
    let settled = false
    void pending.then(() => {
      settled = true
    })
    const app = renderInteractiveApp(
      { cwd: '/repo', permissions },
      {
        debug: true,
        interactive: true,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await app.waitUntilRenderFlush()
    expect(stdout.output).toContain('[sensitive permission details hidden - deny only]')
    expect(stdout.output).not.toContain('allow once')
    stdin.write('a')
    await app.waitUntilRenderFlush()
    expect(settled).toBe(false)
    stdin.write('d')
    await expect(pending).resolves.toEqual({ kind: 'deny' })
    await app.unmount()
    await app.waitUntilExit()
  })

  it('renders focused list and tab affordances', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const list = render(
      createElement(SelectList, {
        activeId: 'gpt-5',
        items: [
          {
            id: 'default',
            label: 'Default',
            description: 'Use configured default',
          },
          {
            id: 'gpt-5',
            label: 'gpt-5',
            description: 'Current session',
            selected: true,
          },
        ],
      }),
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await list.waitUntilRenderFlush()
    list.unmount()
    await list.waitUntilExit()

    const tabStdout = new MemoryWriteStream()
    const tabs = render(
      createElement(TabBar, {
        activeId: 'status',
        tabs: [
          { id: 'settings', label: 'Settings' },
          { id: 'status', label: 'Status' },
          { id: 'config', label: 'Config' },
        ],
      }),
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: new MemoryReadStream() as unknown as NodeJS.ReadStream,
        stdout: tabStdout as unknown as NodeJS.WriteStream,
      },
    )
    await tabs.waitUntilRenderFlush()
    tabs.unmount()
    await tabs.waitUntilExit()

    expect(stdout.output).toContain('> * gpt-5  Current session')
    expect(tabStdout.output).toContain('[Status]')
  })

  it('renders model current and unavailable states', async () => {
    const stdout = new MemoryWriteStream()
    const picker = render(
      createElement(ModelPicker, {
        activeId: 'anthropic/sonnet',
        currentModelId: 'anthropic/sonnet',
        models: modelPickerFixture().models,
      }),
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: new MemoryReadStream() as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )
    await picker.waitUntilRenderFlush()
    picker.unmount()
    await picker.waitUntilExit()

    expect(stdout.output).toContain('> * Sonnet')
    expect(stdout.output).toContain('Opus  Unavailable')
    expect(stdout.output).toContain('Unavailable models are muted')
  })

  it('supports model picker down, unavailable focus, and enter interactions', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const activeIds: string[] = []
    const submitted: string[] = []
    const picker = render(
      createElement(ModelPicker, {
        activeId: 'anthropic/sonnet',
        currentModelId: 'anthropic/sonnet',
        models: modelPickerFixture().models,
        onActiveChange: (id) => activeIds.push(id),
        onSubmit: (id) => submitted.push(id),
      }),
      {
        debug: true,
        interactive: true,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    stdin.write('\u001B[B')
    await picker.waitUntilRenderFlush()
    stdin.write('\r')
    await picker.waitUntilRenderFlush()
    expect(activeIds).toEqual(['anthropic/opus'])
    expect(submitted).toEqual([])

    stdin.write('\u001B[B')
    await picker.waitUntilRenderFlush()
    stdin.write('\r')
    await picker.waitUntilRenderFlush()
    expect(submitted).toEqual(['openai/gpt-5'])

    picker.unmount()
    await picker.waitUntilExit()
  })

  it('supports model picker escape cancellation', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const cancelled = vi.fn()
    const picker = render(
      createElement(ModelPicker, {
        activeId: 'anthropic/sonnet',
        currentModelId: 'anthropic/sonnet',
        models: modelPickerFixture().models,
        onCancel: cancelled,
      }),
      {
        debug: true,
        interactive: true,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 40))
    await picker.waitUntilRenderFlush()
    picker.unmount()
    await picker.waitUntilExit()

    expect(cancelled).toHaveBeenCalledOnce()
  })
})

function modelPickerFixture() {
  return {
    currentModelId: 'anthropic/sonnet',
    models: [
      {
        id: 'anthropic/sonnet',
        provider: 'anthropic',
        model: 'sonnet',
        label: 'Sonnet',
        description: 'Current',
      },
      {
        id: 'anthropic/opus',
        provider: 'anthropic',
        model: 'opus',
        label: 'Opus',
        description: 'Unavailable',
        disabled: true,
      },
      {
        id: 'openai/gpt-5',
        provider: 'openai',
        model: 'gpt-5',
        label: 'GPT-5',
        description: 'Available fallback',
      },
    ],
  }
}

function twoModelPickerFixture() {
  return {
    currentModelId: 'anthropic/sonnet',
    models: [
      {
        id: 'anthropic/sonnet',
        provider: 'anthropic',
        model: 'sonnet',
        label: 'Sonnet',
        description: 'Current',
      },
      {
        id: 'anthropic/opus',
        provider: 'anthropic',
        model: 'opus',
        label: 'Opus',
        description: 'Unavailable',
        disabled: true,
      },
    ],
  }
}

function welcomeFixture(): WelcomePanelData {
  return {
    version: '0.0.0-test',
    sessionId: 'session-1234567890',
    cwd: '/repo',
    model: {
      status: 'unknown',
      reason: { code: 'runtime_resolved', message: 'runtime resolved' },
    },
    sandbox: {
      status: 'available',
      tier: 'partial',
      mechanism: 'apollo-sandbox',
      filesystem: 'isolated',
      network: 'unavailable',
    },
    permission: { mode: 'ask', dangerous: false, source: 'default' },
    config: {
      effectiveSources: ['defaults', 'user'],
      user: { status: 'available', path: 'user config', trusted: true },
      project: { status: 'disabled' },
    },
    mcp: {
      status: 'available',
      connected: 1,
      total: 2,
      servers: [
        { name: 'git', status: 'connected' },
        { name: 'docs', status: 'failed' },
      ],
    },
    history: { status: 'available', path: 'history', entries: 0, maxEntries: 1000 },
  }
}
