import { PassThrough, Writable } from 'node:stream'

import { EventBus } from '@volund/core'
import { render } from 'ink'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { runSlashCommand, sortSlashCommands, type SlashCommand } from './app'
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

  it('renders and switches all five status tabs at narrow width', async () => {
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
    stdin.write('\u001B[C') // → Config
    await panel.waitUntilRenderFlush()
    expect(stdout.output).toContain('Notifications')
    stdin.write('\u001B[C') // → Usage
    await panel.waitUntilRenderFlush()
    // 42 列宽下不可用提示会折行，断言折行点之前的前缀
    expect(stdout.output).toContain('Usage data is not available')
    stdin.write('\u001B[C') // → Stats
    await panel.waitUntilRenderFlush()
    expect(stdout.output).toContain('No session history found')
    stdin.write('\u001B[C') // → Settings（环绕）
    await panel.waitUntilRenderFlush()
    expect(stdout.output).toContain('Language')
    panel.unmount()
    await panel.waitUntilExit()
  })

  it('renders the Usage tab with session cost, durations, code changes and tokens', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const panel = render(
      createElement(StatusPanel, {
        data: {
          settings: [],
          status: [{ label: 'Version', value: '1.0.0' }],
          config: [],
          usage: {
            costUSD: 0.0123,
            apiDurationMs: 37_000,
            wallDurationMs: 3 * 3_600_000 + 12 * 60_000,
            linesAdded: 12,
            linesRemoved: 4,
            tokens: { input: 2100, output: 1500, cacheRead: 0, cacheWrite: 300 },
          },
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
    stdin.write('\u001B[C') // → Config
    await panel.waitUntilRenderFlush()
    stdin.write('\u001B[C') // → Usage
    await panel.waitUntilRenderFlush()
    expect(stdout.output).toContain('$0.0123')
    expect(stdout.output).toContain('37s')
    expect(stdout.output).toContain('3h 12m')
    expect(stdout.output).toContain('12 lines added, 4 lines removed')
    // 80 列下整行会 truncate-end，断言可见前缀
    expect(stdout.output).toContain('2.1k input, 1.5k output')
    panel.unmount()
    await panel.waitUntilExit()
  })

  it('renders the Stats tab: heatmap, range cycling and the Models subview', async () => {
    const stdout = new MemoryWriteStream()
    stdout.columns = 100
    const stdin = new MemoryReadStream()
    const range = (tokens: number, model: string) => ({
      totalTokens: tokens,
      sessions: 2,
      activeDays: 3,
      rangeDays: 30,
      favoriteModel: model,
      mostActiveDay: 'Mar 3',
      longestSessionMs: 3_600_000,
      longestStreakDays: 3,
      currentStreakDays: 1,
      models: [{ model, tokens, share: 1 }],
    })
    const panel = render(
      createElement(StatusPanel, {
        data: {
          settings: [],
          status: [{ label: 'Version', value: '1.0.0' }],
          config: [],
          stats: {
            heatmap: { start: '2026-08-23', days: [0, 5, 10] },
            ranges: {
              all: { ...range(1_100_000_000, 'kimi-k2.5'), rangeDays: 213 },
              '7d': range(2_000, 'kimi-k2.5'),
              '30d': range(30_000, 'claude-sonnet-4'),
            },
          },
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
    // → Config → Usage → Stats（逐次 flush：连发转义序列会被 ink 合并成一次输入）
    stdin.write('\u001B[C')
    await panel.waitUntilRenderFlush()
    stdin.write('\u001B[C')
    await panel.waitUntilRenderFlush()
    stdin.write('\u001B[C')
    await panel.waitUntilRenderFlush()
    expect(stdout.output).toContain('Overview')
    expect(stdout.output).toContain('Less')
    expect(stdout.output).toContain('More')
    expect(stdout.output).toContain('All time')
    expect(stdout.output).toContain('kimi-k2.5')
    expect(stdout.output).toContain('1.1b')
    expect(stdout.output).toContain('Anna Karenina')
    stdin.write('r') // → Last 7 days
    await panel.waitUntilRenderFlush()
    expect(stdout.output).toContain('Last 7 days')
    stdin.write('r')
    stdin.write('r') // → 回到 All time
    await panel.waitUntilRenderFlush()
    stdin.write('\u001B[B') // ↓ → Models 子视图
    await panel.waitUntilRenderFlush()
    expect(stdout.output).toContain('100%')
    panel.unmount()
    await panel.waitUntilExit()
  })

  it('refreshes panel data on mount when the controller provides refresh', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const stale = {
      settings: [] as const,
      status: [{ label: 'Version', value: '1.0.0' }],
      config: [] as const,
    }
    const fresh = {
      ...stale,
      usage: {
        costUSD: 1,
        apiDurationMs: 0,
        wallDurationMs: 60_000,
        linesAdded: 0,
        linesRemoved: 0,
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      },
    }
    const refresh = vi.fn(async () => fresh)
    const panel = render(
      createElement(StatusPanel, {
        data: stale,
        controller: { update: vi.fn(), refresh },
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
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    stdin.write('\u001B[C')
    await panel.waitUntilRenderFlush()
    stdin.write('\u001B[C') // → Usage
    await panel.waitUntilRenderFlush()
    await vi.waitFor(() => expect(stdout.output).toContain('$1.00'))
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

    expect(stdout.output).toContain('╭─ Volund CLI v0.0.0-test ')
    expect(stdout.output).toContain('Tips for getting started')
    expect(stdout.output).toContain('Recent activity')
    expect(stdout.output).toContain('session-1234')
    expect(stdout.output).toContain('runtime resolved')
    expect(stdout.output).toMatch(/>\s*▌Ask Volund/)
    expect(stdout.output).not.toContain('volund >')
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

    expect(stdout.output).toContain('╭─ Volund CLI v0.0.0-test ')
    if (layout === 'MINIMAL') {
      expect(stdout.output).not.toContain('Tips for getting started')
    } else {
      expect(stdout.output).toContain('Tips for getting started')
    }
    expect(stdout.output).toMatch(/>\s*▌Ask Volund/)
    expect(stdout.output).not.toContain('volund >')
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
    expect(stdout.output).toContain('Volund CLI v0.0.0-test')
    const renderedBeforeResize = stdout.output.length

    stdout.columns = 70
    stdout.rows = 18
    stdout.emit('resize')
    await app.waitUntilRenderFlush()

    app.unmount()
    await app.waitUntilExit()
    // 缩小后重排成 minimal 版（debug 模式逐帧累加输出，帧增长即证明重渲染发生）。
    expect(stdout.output.length).toBeGreaterThan(renderedBeforeResize)
  })

  it('clears the screen when terminal width changes so reflowed frames cannot stack', async () => {
    const stdout = new MemoryWriteStream()
    ;(stdout as { isTTY: boolean }).isTTY = true
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
    expect(stdout.output).not.toContain('\x1b[2J')

    stdout.columns = 100
    stdout.emit('resize')
    await app.waitUntilRenderFlush()
    expect(stdout.output).toContain('\x1b[2J\x1b[3J\x1b[H')

    // 仅高度变化无 reflow，不重复清屏（debug 模式每帧照常追加，只数清屏序列）
    const clearsAfterWidthChange = stdout.output.split('\x1b[2J\x1b[3J\x1b[H').length
    stdout.rows = 40
    stdout.emit('resize')
    await app.waitUntilRenderFlush()

    app.unmount()
    await app.waitUntilExit()
    expect(stdout.output.split('\x1b[2J\x1b[3J\x1b[H').length).toBe(clearsAfterWidthChange)
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

  it('keeps subagent bubble events out of the transcript (SUBAGENTS-UI-r1 background semantics)', async () => {
    const events = new EventBus()
    const stdout = new MemoryWriteStream()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        events,
        sessionId: 'session-1234567890',
        status: 'ready',
      },
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: new MemoryReadStream() as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await app.waitUntilRenderFlush()
    await new Promise<void>((resolve) => setImmediate(resolve))
    // subagent 冒泡（dispatcher 经 EventBus.forward 加 D.3 tag）：对主转录不可见。
    // forward 是真实转发路径（emit 类型上禁止自带 tag）。
    await events.forward(
      {
        id: 'child-m-1-ev',
        sessionId: 'child-session',
        type: 'message.appended',
        version: 1,
        payload: {
          messageId: 'child-m-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'child streaming chatter' }],
        },
        at: Date.now(),
      },
      { parentDepth: 1, parentTurnId: 'parent-turn' },
    )
    await app.waitUntilRenderFlush()
    expect(stdout.output).not.toContain('child streaming chatter')
    // 父会话自己的事件照常渲染
    await events.emit({
      payload: {
        messageId: 'm-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'parent reply' }],
      },
      sessionId: 'session-1234567890',
      type: 'message.appended',
      version: 1,
    })
    await app.waitUntilRenderFlush()
    expect(stdout.output).toContain('parent reply')
    app.unmount()
    await app.waitUntilExit()
  })

  it('accepts input during a turn: slash commands run live, text queues until the turn ends', async () => {
    const events = new EventBus()
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const submitted: Array<string | undefined> = []
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        events,
        onSubmit: (value) => {
          submitted.push(value)
        },
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
    await new Promise<void>((resolve) => setImmediate(resolve))
    // turn 进入 active（stream 事件驱动）
    await events.emit({
      payload: { messageId: 'm-1' },
      sessionId: 'session-1234567890',
      type: 'stream.started',
      version: 1,
    })

    // 运行期输入不直接提交，而是排队
    stdin.write('check the subagents result')
    await app.waitUntilRenderFlush()
    stdin.write('\r')
    await vi.waitFor(() => expect(stdout.output).toContain('queued'))
    expect(submitted).toEqual([])

    // 运行期斜杠命令即时执行（/help 只读）
    stdin.write('/help')
    await app.waitUntilRenderFlush()
    stdin.write('\r')
    await vi.waitFor(() => expect(stdout.output).toContain('Show slash commands'))

    // turn 收尾 → 排队文本自动发出
    await events.emit({
      payload: { messageId: 'm-1' },
      sessionId: 'session-1234567890',
      type: 'stream.completed',
      version: 1,
    })
    await vi.waitFor(() => expect(submitted).toEqual(['check the subagents result']))
    expect(stdout.output).toContain('1 queued message(s)')
    app.unmount()
    await app.waitUntilExit()
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

    expect(stdout.output).toContain('Volund')
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

  it('scrolls the suggestion window so commands beyond the first 10 stay reachable', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    // 内置命令恰好约 10 个：插件贡献的命令（如 /env）会排在第 11 位，
    // 旧的 slice(0, 10) 会让它永远不进列表——这里锁定滚动窗口行为。
    const commands = Array.from({ length: 12 }, (_, index) => ({
      name: `cmd${String(index).padStart(2, '0')}`,
      description: `command ${index}`,
      run: () => {},
    }))
    const input = render(
      createElement(InputBox, {
        initialValue: '/',
        onSubmit: () => {},
        slashCommands: commands,
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
    expect(stdout.output).toContain('/cmd00')
    expect(stdout.output).toContain('/cmd09')
    expect(stdout.output).not.toContain('/cmd10')

    for (let index = 0; index < 10; index += 1) stdin.write('\u001B[B')
    await input.waitUntilRenderFlush()
    expect(stdout.output).toContain('> /cmd10 command 10')

    input.unmount()
    await input.waitUntilExit()
  })

  it('opens a searchable list picker for commands returning a list view', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        slashCommands: [
          {
            name: 'env',
            description: 'Show env',
            run: () => ({
              kind: 'list' as const,
              title: 'Environment — [env]',
              entries: [
                {
                  id: 'NO_PROXY',
                  label: 'NO_PROXY',
                  value: 'localhost,127.0.0.1',
                  status: 'effective · sandbox: passed through',
                  detail: 'NO_PROXY = "localhost,127.0.0.1"\nstatus: effective',
                },
                {
                  id: 'HTTP_PROXY',
                  label: 'HTTP_PROXY',
                  value: 'http://127.0.0.1:7890',
                  status: 'effective · sandbox: withheld',
                },
              ],
            }),
          },
        ],
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
    // 输入 /env → 建议列表选中 → 回车执行 → 打开列表面板
    stdin.write('/env')
    await app.waitUntilRenderFlush()
    stdin.write('\r')
    await app.waitUntilRenderFlush()
    expect(stdout.output).toContain('Environment — [env]')
    expect(stdout.output).toContain('NO_PROXY')
    expect(stdout.output).toContain('HTTP_PROXY')

    // 搜索过滤：只剩 no_proxy 一条
    stdin.write('no')
    await app.waitUntilRenderFlush()
    expect(stdout.output).toContain('› NO_PROXY')

    // 回车选中 → 面板关闭，detail 全文进 transcript
    stdin.write('\r')
    await app.waitUntilRenderFlush()
    expect(stdout.output).toContain('NO_PROXY = "localhost,127.0.0.1"')
    expect(stdout.output).toContain('status: effective')

    await app.unmount()
    await app.waitUntilExit()
  })

  it('renders an open-ended command band with placeholder and a visible entry cursor', async () => {
    const stdout = new MemoryWriteStream()
    stdout.columns = 100
    const input = render(
      createElement(InputBox, { placeholder: 'Ask volund', terminalColumns: 100 }),
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

    expect(stdout.output).toContain('> ▌Ask volund')
    expect(stdout.output).not.toContain('volund >')
    expect(stdout.output).toContain('─')
    expect(stdout.output).not.toMatch(/[┌┐└┘│]/)
    expect(stdout.output).toContain('Enter send / Shift+Enter newline')
  })

  it('blinks the entry cursor while idle', async () => {
    const stdout = new MemoryWriteStream()
    stdout.columns = 100
    const input = render(
      createElement(InputBox, { placeholder: 'Ask volund', terminalColumns: 100 }),
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

    expect(stdout.output).toContain('> ▌Ask volund')
    expect(stdout.output).toContain('>  Ask volund')
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
            title: 'volund session',
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
      createElement(InputBox, { placeholder: 'Ask volund', terminalColumns: 60 }),
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

    expect(stdout.output).toContain('Ask volund')
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

    await expect(runSlashCommand('/context', commands)).resolves.toEqual({
      kind: 'message',
      text: '/context is not available in this build/session',
      level: 'warning',
    })
    await expect(runSlashCommand('/missing', commands)).resolves.toEqual({
      kind: 'message',
      text: 'Unknown slash command: /missing',
      level: 'warning',
    })
  })

  it('treats a string returned from run() as info-level transcript output', async () => {
    const commands: SlashCommand[] = [
      { name: 'env', description: 'Show env', run: () => 'NO_PROXY = localhost (effective)' },
      {
        name: 'boom',
        description: 'Fails',
        run: () => {
          throw new Error('broken')
        },
      },
      { name: 'silent', description: 'No output', run: () => {} },
    ]

    await expect(runSlashCommand('/env', commands)).resolves.toEqual({
      kind: 'message',
      text: 'NO_PROXY = localhost (effective)',
      level: 'info',
    })
    await expect(runSlashCommand('/boom', commands)).resolves.toEqual({
      kind: 'message',
      text: 'broken',
      level: 'error',
    })
    await expect(runSlashCommand('/silent', commands)).resolves.toBeUndefined()
  })

  it('sorts slash commands by optional order while keeping the unsorted tail stable', () => {
    const command = (name: string, order?: number): SlashCommand => ({
      name,
      description: name,
      ...(order !== undefined ? { order } : {}),
      run: () => {},
    })
    // 设置 order 的按升序浮到前面；未设置的保持在传入顺序（现状行为不变）
    expect(
      sortSlashCommands([
        command('help'),
        command('env'),
        command('plugins', 10),
        command('model', -1),
        command('memory'),
      ]).map((item) => item.name),
    ).toEqual(['model', 'plugins', 'help', 'env', 'memory'])
  })

  it('interleaves ordered plugin commands between the numbered builtin band', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        // 内置号段：undo=40、status=50 —— order 45 应落在两者之间
        slashCommands: [{ name: 'midway', order: 45, description: 'Interleaves', run: () => {} }],
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
    stdin.write('/')
    await app.waitUntilRenderFlush()
    const frame = stdout.output
    const undo = frame.lastIndexOf('/undo')
    const midway = frame.lastIndexOf('/midway')
    const status = frame.lastIndexOf('/status')
    expect(undo).toBeGreaterThan(-1)
    expect(midway).toBeGreaterThan(undo)
    expect(status).toBeGreaterThan(midway)
    await app.unmount()
    await app.waitUntilExit()
  })

  it('passes through a list view returned from run() and drops malformed ones', async () => {
    const view = {
      kind: 'list' as const,
      title: 'Environment',
      entries: [{ id: 'NO_PROXY', label: 'NO_PROXY', value: 'localhost' }],
    }
    const commands: SlashCommand[] = [
      { name: 'env', description: 'Show env', run: () => view },
      { name: 'bad', description: 'Malformed', run: () => ({ kind: 'list' }) as never },
    ]

    await expect(runSlashCommand('/env', commands)).resolves.toEqual({ kind: 'list', view })
    // 形状不合法的视图按无输出处理（fail-open，不炸 REPL）
    await expect(runSlashCommand('/bad', commands)).resolves.toBeUndefined()
  })

  it('passes through a tabs view returned from run() and drops malformed ones', async () => {
    const view = {
      kind: 'tabs' as const,
      title: 'Plugins',
      tabs: [
        { id: 'builtin', label: 'Built-in (1)', entries: [{ id: 'env', label: 'env' }] },
        { id: 'dev', label: 'Dev (0)', entries: [] },
      ],
    }
    const commands: SlashCommand[] = [
      { name: 'plugins', description: 'Browse', run: () => view },
      { name: 'badtabs', description: 'Malformed', run: () => ({ kind: 'tabs' }) as never },
    ]

    await expect(runSlashCommand('/plugins', commands)).resolves.toEqual({ kind: 'tabs', view })
    await expect(runSlashCommand('/badtabs', commands)).resolves.toBeUndefined()
  })

  it('opens a tabbed list panel for commands returning a tabs view (/plugins)', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        slashCommands: [
          {
            name: 'plugins',
            description: 'Browse plugins',
            run: () => ({
              kind: 'tabs' as const,
              title: 'Plugins — builtin · dev · market',
              placeholder: 'Search by name, version, or status',
              tabs: [
                {
                  id: 'builtin',
                  label: 'Built-in (2)',
                  entries: [
                    {
                      id: 'volund-plugin-env',
                      label: 'env',
                      value: '0.1.0',
                      status: 'loaded · 1 cmd',
                      detail: 'volund-plugin-env @ 0.1.0\nsource: builtin',
                    },
                    { id: 'volund-plugin-manager', label: 'manager', value: '0.1.0' },
                  ],
                },
                {
                  id: 'market',
                  label: 'Market (1)',
                  entries: [
                    {
                      id: 'volund-plugin-hello',
                      label: 'hello',
                      value: '1.0.0',
                      status: 'available · demo',
                      detail: 'volund-plugin-hello @ 1.0.0\nInstall with: /plugins install hello',
                    },
                  ],
                },
              ],
            }),
          },
        ],
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
    stdin.write('/plugins')
    await app.waitUntilRenderFlush()
    stdin.write('\r')
    await app.waitUntilRenderFlush()
    // 面板标题 + 页签行 + 当前页签条目
    expect(stdout.output).toContain('Plugins — builtin · dev · market')
    expect(stdout.output).toContain('[Built-in (2)]')
    expect(stdout.output).toContain('Market (1)')
    expect(stdout.output).toContain('› env')

    // → 切到 Market 页签（搜索词保留、选中复位）
    stdin.write('\u001b[C')
    await app.waitUntilRenderFlush()
    expect(stdout.output).toContain('[Market (1)]')
    expect(stdout.output).toContain('› hello')

    // 搜索 + 回车选中 → detail 进 transcript，面板关闭
    stdin.write('hel')
    await app.waitUntilRenderFlush()
    stdin.write('\r')
    await app.waitUntilRenderFlush()
    expect(stdout.output).toContain('Install with: /plugins install hello')

    await app.unmount()
    await app.waitUntilExit()
  })

  it('renders startup notices as initial transcript system entries', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        notices: [
          'Builtin plugin volund-plugin-env failed to activate: sandbox unavailable; refusing unsandboxed execution',
        ],
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
    // 插件激活失败发生在 REPL 渲染前——必须直接可见，而不是攒到 stderr 退出才显示。
    expect(stdout.output).toContain(
      'Builtin plugin volund-plugin-env failed to activate: sandbox unavailable',
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
      payload: { messageId: 'm-1', kind: 'text', fragment: 'q' },
      sessionId: 'session-1',
      type: 'stream.delta',
      version: 1,
    })
    await events.emit({
      payload: { messageId: 'm-1', kind: 'text', fragment: 'z' },
      sessionId: 'session-1',
      type: 'stream.delta',
      version: 1,
    })
    await app.waitUntilRenderFlush()
    expect(stdout.output).not.toContain('qz')

    await new Promise((resolve) => setTimeout(resolve, 40))
    await app.waitUntilRenderFlush()
    await app.unmount()
    await app.waitUntilExit()

    expect(stdout.output).toContain('qz')
  })

  it('renders conversation entries as marker + text, without YOU/volund labels', async () => {
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
    expect(stdout.output).not.toContain('volund')
  })

  it('shows a live streaming status with phase, token estimate, and esc hint', async () => {
    const events = new EventBus()
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        events,
        sessionId: 'session-1',
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
    // Let the event-subscription effect commit before emitting.
    await new Promise<void>((resolve) => setImmediate(resolve))

    await events.emit({
      payload: { messageId: 'm-1' },
      sessionId: 'session-1',
      type: 'stream.started',
      version: 1,
    })
    await app.waitUntilRenderFlush()
    expect(stdout.output).toContain('waiting for model')
    expect(stdout.output).toContain('↑ 0 tokens')
    expect(stdout.output).toContain('esc to interrupt')
    expect(stdout.output).toContain('Tip:')

    await events.emit({
      payload: { messageId: 'm-1', kind: 'text', fragment: 'abcd' },
      sessionId: 'session-1',
      type: 'stream.delta',
      version: 1,
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    await app.waitUntilRenderFlush()
    await app.unmount()
    await app.waitUntilExit()

    expect(stdout.output).toContain('streaming')
    expect(stdout.output).toContain('↑ 1 tokens')
  })

  it('pressing esc during a turn interrupts it via onInterrupt', async () => {
    const events = new EventBus()
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const interrupt = vi.fn()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        events,
        onInterrupt: interrupt,
        sessionId: 'session-1',
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
    await new Promise<void>((resolve) => setImmediate(resolve))
    await events.emit({
      payload: { messageId: 'm-1' },
      sessionId: 'session-1',
      type: 'stream.started',
      version: 1,
    })
    await app.waitUntilRenderFlush()
    // The StreamingStatus input subscription commits after the render flush.
    await new Promise<void>((resolve) => setImmediate(resolve))

    stdin.write('\u001B')
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1))

    // After the turn ends, esc is inert again.
    await events.emit({
      payload: { turnId: 't-1', reason: 'user_interrupt' },
      sessionId: 'session-1',
      type: 'turn.aborted',
      version: 1,
    })
    await app.waitUntilRenderFlush()
    await new Promise<void>((resolve) => setImmediate(resolve))
    stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(interrupt).toHaveBeenCalledTimes(1)

    await app.unmount()
    await app.waitUntilExit()
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

    // Multiple pending requests render as a tab strip: one tab per request,
    // first tab focused with its (escaped) details shown.
    expect(stdout.output).toContain('Permission required')
    expect(stdout.output).toContain('1:Bash')
    expect(stdout.output).toContain('2:Write')
    expect(stdout.output).toContain('touch x\\u{202E}')
    expect(stdout.output).not.toContain(rawCommand)
    expect(permissions.requests()[0]).toEqual(rawRequest)
  })

  it('renders human-readable permission summaries', async () => {
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

    void permissions.request({
      display: { approvable: true, spec: '{"fs":{"write":["out.md"]}}', toolName: 'Write' },
      attempt: 1,
      id: 'permission-summary',
      input: {},
      spec: { fs: { write: ['out.md'] } },
      toolName: 'Write',
    })
    await app.waitUntilRenderFlush()
    await app.unmount()
    await app.waitUntilExit()

    // Structured specs render as capability lines instead of raw JSON, with
    // quick keys intact.
    expect(stdout.output).toContain('Permission required')
    expect(stdout.output).toContain('write ')
    expect(stdout.output).toContain('out.md')
    expect(stdout.output).not.toContain('{"fs"')
    expect(stdout.output).toContain('Allow once')
    // 次要范围选项（project/always/never）收进底部暗字提示，快捷键仍直接生效
    expect(stdout.output).toContain('p For this project · f Always · x Never ask again')
    expect(stdout.output).toContain('Full access (this session)')
    expect(stdout.output).toContain('grants match exactly')
  })

  it('exposes all seven decision kinds and decides instantly via quick keys', async () => {
    const permissions = new PermissionPromptController()
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const pending = permissions.request({
      display: { approvable: true, spec: '{"bash":{"command":"make build"}}', toolName: 'Bash' },
      attempt: 1,
      id: 'permission-six',
      input: { command: 'make build' },
      spec: { bash: { command: 'make build' } },
      toolName: 'Bash',
    })
    const second = permissions.request({
      display: { approvable: true, spec: '{"bash":{"command":"make lint"}}', toolName: 'Bash' },
      attempt: 1,
      id: 'permission-six-2',
      input: { command: 'make lint' },
      spec: { bash: { command: 'make lint' } },
      toolName: 'Bash',
    })
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        permissions,
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

    // Both decision groups with every scope are listed.
    expect(stdout.output).toContain('ALLOW')
    expect(stdout.output).toContain('DENY')
    for (const label of [
      'Allow once',
      'For this session',
      'For this project',
      'Always',
      'Full access (this session)',
      'Deny',
      'Never ask again',
    ])
      expect(stdout.output).toContain(label)

    // 'f' decides allow-forever without navigation; the queue advances so 'x'
    // then decides the next request as deny-forever.
    stdin.write('f')
    await expect(pending).resolves.toEqual({ kind: 'allow-forever' })
    await app.waitUntilRenderFlush()
    stdin.write('x')
    await expect(second).resolves.toEqual({ kind: 'deny-forever' })

    await app.unmount()
    await app.waitUntilExit()
  })

  it('lays out multi-line commands as continuation rows with elision', async () => {
    const permissions = new PermissionPromptController()
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const longCommand = [
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'nine',
      'ten',
    ]
      .map((word, index) => `echo step ${index} ${word}`)
      .join('\n')
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

    void permissions.request({
      display: {
        approvable: true,
        spec: `{"bash":{"command":${JSON.stringify(longCommand)}}}`,
        toolName: 'Bash',
      },
      attempt: 1,
      id: 'permission-multiline',
      input: { command: longCommand },
      spec: { bash: { command: longCommand } },
      toolName: 'Bash',
    })
    await app.waitUntilRenderFlush()
    await app.unmount()
    await app.waitUntilExit()

    expect(stdout.output).toContain('$ echo step 0 one')
    expect(stdout.output).toContain('│ echo step 1 two')
    expect(stdout.output).toContain('more')
  })

  it('switches permission request tabs and confirms options per tab', async () => {
    const permissions = new PermissionPromptController()
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const first = permissions.request({
      display: { approvable: true, spec: '{"bash":{"command":"make build"}}', toolName: 'Bash' },
      attempt: 1,
      id: 'permission-tab-1',
      input: { command: 'make build' },
      spec: { bash: { command: 'make build' } },
      toolName: 'Bash',
    })
    const second = permissions.request({
      display: { approvable: true, spec: '{"fs":{"write":["dist/out.js"]}}', toolName: 'Write' },
      attempt: 1,
      id: 'permission-tab-2',
      input: {},
      spec: { fs: { write: ['dist/out.js'] } },
      toolName: 'Write',
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
    expect(stdout.output).toContain('1:Bash')
    expect(stdout.output).toContain('2:Write')
    expect(stdout.output).toContain('make build')

    // → switches to the second tab; its details replace the first request's.
    stdin.write('\u001B[C')
    await app.waitUntilRenderFlush()
    expect(stdout.output).toContain('dist/out.js')

    // ↑/↓ pick "Allow for this session", Enter confirms — and only this tab's
    // request settles; the other stays pending.
    stdin.write('\u001B[B')
    await app.waitUntilRenderFlush()
    stdin.write('\r')
    await expect(second).resolves.toEqual({ kind: 'allow-session' })
    expect(permissions.requests().map((request) => request.id)).toEqual(['permission-tab-1'])

    // Focus advanced to the remaining tab; esc denies it.
    stdin.write('\u001B')
    await expect(first).resolves.toEqual({ kind: 'deny' })
    expect(permissions.requests()).toEqual([])

    await app.unmount()
    await app.waitUntilExit()
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
    expect(stdout.output).not.toContain('Allow once')
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
        mechanism: 'volund-sandbox',
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

  it('renders plugin-contributed contract tabs (rows/table/heatmap) and error placeholders', async () => {
    const stdout = new MemoryWriteStream()
    stdout.columns = 100
    const stdin = new MemoryReadStream()
    const panel = render(
      createElement(StatusPanel, {
        data: {
          settings: [],
          status: [{ label: 'Version', value: '1.0.0' }],
          config: [],
          pluginTabs: [
            {
              schemaVersion: 1,
              id: 'demo-rows',
              label: 'Test',
              body: {
                kind: 'rows',
                sections: [{ title: 'Demo section', rows: [['Engine', 'kimi-k2.5']] }],
              },
            },
            {
              schemaVersion: 1,
              id: 'demo-table',
              label: 'Grid',
              body: { kind: 'table', columns: ['Day', 'Events'], rows: [['2026-08-25', '7']] },
            },
            {
              schemaVersion: 1,
              id: 'demo-heat',
              label: 'Pulse',
              body: {
                kind: 'heatmap',
                heatmap: { start: '2026-08-23', days: [1, 2, 3] },
              },
            },
            // 凭据模式命中 → 降级为 section error 占位
            {
              schemaVersion: 1,
              id: 'demo-leak',
              label: 'Leak',
              body: {
                kind: 'rows',
                sections: [{ rows: [['note', 'api_key = sk-live']] }],
              },
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
    // 页签栏出现全部四个插件页签
    for (const label of ['Test', 'Grid', 'Pulse', 'Leak']) expect(stdout.output).toContain(label)
    // → Config → Usage → Stats → Test
    for (let i = 0; i < 4; i += 1) {
      stdin.write('\u001B[C')
      await panel.waitUntilRenderFlush()
    }
    expect(stdout.output).toContain('Demo section')
    expect(stdout.output).toContain('kimi-k2.5')
    stdin.write('\u001B[C') // → Grid
    await panel.waitUntilRenderFlush()
    expect(stdout.output).toContain('Events')
    expect(stdout.output).toContain('2026-08-25')
    stdin.write('\u001B[C') // → Pulse
    await panel.waitUntilRenderFlush()
    expect(stdout.output).toContain('Less')
    stdin.write('\u001B[C') // → Leak（降级行）
    await panel.waitUntilRenderFlush()
    expect(stdout.output).toContain('section error: Leak')
    expect(stdout.output).not.toContain('sk-live')
    panel.unmount()
    await panel.waitUntilExit()
  })
})
