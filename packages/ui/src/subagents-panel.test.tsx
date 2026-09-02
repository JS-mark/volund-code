import { PassThrough, Writable } from 'node:stream'

import { render } from 'ink'
import { describe, expect, it } from 'vitest'

import { SubagentsPanel } from './components/SubagentsPanel'
import type { SubagentPanelEntry, SubagentsPanelController } from './index'
import { subagentDuration, subagentListCommandView } from './subagents-panel'

class MemoryWriteStream extends Writable {
  columns = 100
  rows = 30
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

function entry(overrides: Partial<SubagentPanelEntry> = {}): SubagentPanelEntry {
  return {
    sessionId: 'session-1',
    agentType: 'code-explainer',
    depth: 1,
    status: 'running',
    startedAt: Date.now() - 30_000,
    prompt: 'Explain the dispatcher module',
    ...overrides,
  }
}

function fakeController(entries: SubagentPanelEntry[]) {
  const calls: string[] = []
  const controller: SubagentsPanelController = {
    async list() {
      return entries
    },
    async cancel(sessionId) {
      calls.push(`cancel:${sessionId}`)
      const live = entries.find((item) => item.sessionId === sessionId && item.status === 'running')
      if (!live) throw new Error(`Subagent ${sessionId} is not running`)
      return 'Subagent cancelled'
    },
    async cancelAll() {
      calls.push('cancelAll')
      return entries.filter((item) => item.status === 'running').length
    },
  }
  return { controller, calls }
}

describe('SubagentsPanel (SUBAGENTS-UI-r1)', () => {
  it('renders run rows with agent, depth, duration and prompt', async () => {
    const stdout = new MemoryWriteStream()
    const { controller } = fakeController([entry()])
    const app = render(
      <SubagentsPanel
        controller={controller}
        terminalColumns={120}
        terminalRows={30}
        onNotice={() => {}}
        onClose={() => {}}
      />,
      {
        debug: true,
        patchConsole: false,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: new MemoryReadStream() as unknown as NodeJS.ReadStream,
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(stdout.output).toContain('code-explainer')
    expect(stdout.output).toContain('Explain the dispatcher module')
    expect(stdout.output).toContain('00:30')
    app.unmount()
  })

  it('cancels the selected running run with x and stops all with a', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const { controller, calls } = fakeController([
      entry(),
      entry({ sessionId: 'session-2', agentType: 'reviewer', status: 'completed' }),
    ])
    const app = render(
      <SubagentsPanel
        controller={controller}
        terminalColumns={120}
        terminalRows={30}
        onNotice={() => {}}
        onClose={() => {}}
      />,
      {
        debug: true,
        patchConsole: false,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    stdin.write('x')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls).toEqual(['cancel:session-1'])
    stdin.write('a')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls).toEqual(['cancel:session-1', 'cancelAll'])
    app.unmount()
  })

  it('shows run detail on Enter', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const { controller } = fakeController([
      entry({
        status: 'completed',
        endedAt: Date.now() - 1000,
        usage: { input: 1200, output: 300, costUSD: 0.02 },
        toolCalls: 4,
      }),
    ])
    const app = render(
      <SubagentsPanel
        controller={controller}
        terminalColumns={120}
        terminalRows={30}
        onNotice={() => {}}
        onClose={() => {}}
      />,
      {
        debug: true,
        patchConsole: false,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    stdin.write('\r')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(stdout.output).toContain('usage: 1200 in / 300 out')
    expect(stdout.output).toContain('tool calls: 4')
    app.unmount()
  })
})

describe('subagents list command view', () => {
  it('renders a filterable list with usage and detail lines', () => {
    const view = subagentListCommandView([
      entry({
        status: 'failed',
        detail: 'provider 429',
        usage: { input: 10, output: 2, costUSD: 0.01 },
      }),
    ])
    expect(view.kind).toBe('list')
    expect(view.entries[0]!.label).toBe('code-explainer')
    expect(view.entries[0]!.status).toBe('failed')
    expect(view.entries[0]!.detail).toContain('provider 429')
  })
})

describe('subagentDuration', () => {
  it('formats under and over an hour', () => {
    const start = 0
    expect(subagentDuration(start, start + 65_000, start + 65_000)).toBe('01:05')
    expect(subagentDuration(start, start + 3_600_000, start + 3_600_000)).toBe('1:00:00')
  })
})
