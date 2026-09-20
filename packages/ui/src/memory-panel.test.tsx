import { PassThrough, Writable } from 'node:stream'

import { render } from 'ink'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { MemoryPanel } from './components/MemoryPanel'
import type { MemoryPanelController, MemoryPanelRecord } from './memory-panel'
import { truncateTerminal } from './memory-panel'
import { renderInteractiveApp } from './tui'

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
  setRawMode(enabled: boolean) {
    this.isRaw = enabled
    return this
  }
  unref() {
    return this
  }
}

const first: MemoryPanelRecord = {
  id: 'pinned-preference',
  content: '使用 pnpm 🚀 for every workspace package',
  tags: ['tooling', 'package-manager'],
  pinned: true,
  scope: 'project',
  source: 'user',
  actor: 'cli',
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T00:00:02.000Z',
}

const second: MemoryPanelRecord = {
  ...first,
  id: 'architecture-note',
  content: 'Keep business behavior outside the Ink component.',
  tags: ['architecture'],
  pinned: false,
  updatedAt: '2026-08-12T00:00:01.000Z',
}

function controller(overrides: Partial<MemoryPanelController> = {}): MemoryPanelController {
  return {
    scopeLabel: 'project',
    searchAvailable: true,
    list: vi.fn(async () => ({ items: [first, second] })),
    search: vi.fn(async () => [first]),
    get: vi.fn(async (id) => [first, second].find((record) => record.id === id)),
    create: vi.fn(async (input) => ({
      ...first,
      content: input.content,
      tags: input.tags ?? [],
      pinned: input.pinned ?? false,
      updatedAt: 'next',
    })),
    update: vi.fn(async (_id, patch) => ({ ...first, ...patch, updatedAt: 'next' })),
    delete: vi.fn(async () => {}),
    pin: vi.fn(async () => ({ ...first, pinned: true, updatedAt: 'next' })),
    unpin: vi.fn(async () => ({ ...first, pinned: false, updatedAt: 'next' })),
    exportAll: vi.fn(async () => ({
      schemaVersion: 'volund.memory.export.v1',
      exportedAt: '',
      records: [],
    })),
    importDocs: vi.fn(async () => ({
      schemaVersion: 1,
      dryRun: false,
      strategy: 'skip',
      total: 0,
      applied: 0,
      conflicts: [],
      rolledBack: false,
      recoveredInterruptedImport: false,
    })),
    ...overrides,
  }
}

async function renderPanel(
  value: MemoryPanelController,
  options: { columns?: number; noColor?: boolean; rows?: number } = {},
) {
  const stdout = new MemoryWriteStream()
  const stdin = new MemoryReadStream()
  stdout.columns = options.columns ?? 80
  stdout.rows = options.rows ?? 24
  const panel = render(
    createElement(MemoryPanel, {
      controller: value,
      ...(options.noColor === undefined ? {} : { noColor: options.noColor }),
      onClose: vi.fn(),
      terminalColumns: stdout.columns,
      terminalRows: stdout.rows,
    }),
    {
      debug: true,
      interactive: true,
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    },
  )
  await vi.waitFor(() => expect(stdout.output).toContain('使用 pnpm'))
  return { panel, stdin, stdout }
}

describe('MemoryPanel', () => {
  it.each([
    [120, 40],
    [80, 24],
    [50, 20],
  ])('renders stable color-independent affordances at %sx%s', async (columns, rows) => {
    const { panel, stdout } = await renderPanel(controller(), { columns, noColor: true, rows })

    expect(stdout.output).toContain('Memory · project')
    expect(stdout.output).toContain('> [P]')
    expect(stdout.output).toContain('Search: press /')
    expect(stdout.output).not.toContain('\u001B[36m')

    panel.unmount()
    await panel.waitUntilExit()
  })

  it('uses optimistic tokens, defaults deletion to Cancel, and commits only after success', async () => {
    const value = controller()
    const { panel, stdin, stdout } = await renderPanel(value)

    stdin.write('\r')
    await vi.waitFor(() => expect(stdout.output).toContain('Scope: project'))
    stdin.write('p')
    await vi.waitFor(() => expect(value.unpin).toHaveBeenCalledWith(first.id, first.updatedAt))
    await vi.waitFor(() => expect(value.list).toHaveBeenCalledTimes(2))
    await panel.waitUntilRenderFlush()
    stdin.write('\r')
    await vi.waitFor(() => expect(value.get).toHaveBeenCalledTimes(2))
    stdin.write('d')
    await vi.waitFor(() => expect(stdout.output).toContain('Cancel'))
    stdin.write('\r')
    expect(value.delete).not.toHaveBeenCalled()
    stdin.write('d')
    await panel.waitUntilRenderFlush()
    stdin.write('\u001B[C')
    await panel.waitUntilRenderFlush()
    stdin.write('\r')
    await vi.waitFor(() => expect(value.delete).toHaveBeenCalledWith(first.id, first.updatedAt))

    panel.unmount()
    await panel.waitUntilExit()
  })

  it('retains the edit draft and current record when a shared policy rejects the mutation', async () => {
    const update = vi.fn(async () => {
      throw Object.assign(new Error('memory.preWrite rejected the write'), {
        code: 'memory_validation',
      })
    })
    const value = controller({ update })
    const { panel, stdin, stdout } = await renderPanel(value)

    stdin.write('e')
    await vi.waitFor(() => expect(stdout.output).toContain('Ctrl+S save'))
    stdin.write('X')
    await panel.waitUntilRenderFlush()
    stdin.write('\u0013')
    await vi.waitFor(() => expect(stdout.output).toContain('Error: memory.preWrite rejected'))
    expect(update).toHaveBeenCalledWith(
      first.id,
      expect.objectContaining({ content: `${first.content}X` }),
      first.updatedAt,
    )
    expect(stdout.output).toContain(`${first.content}X`)

    panel.unmount()
    await panel.waitUntilExit()
  })

  it('shows a retryable load error without closing the chat', async () => {
    const list = vi
      .fn<MemoryPanelController['list']>()
      .mockRejectedValueOnce(Object.assign(new Error('disk unavailable'), { code: 'memory_io' }))
      .mockResolvedValue({ items: [first] })
    const value = controller({ list })
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const panel = render(
      createElement(MemoryPanel, {
        controller: value,
        onClose: vi.fn(),
        terminalColumns: 80,
        terminalRows: 24,
      }),
      {
        debug: true,
        interactive: true,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )
    await vi.waitFor(() => expect(stdout.output).toContain('Error: disk unavailable'))
    stdin.write('r')
    await vi.waitFor(() => expect(stdout.output).toContain('使用 pnpm'))
    expect(list).toHaveBeenCalledTimes(2)

    panel.unmount()
    await panel.waitUntilExit()
  })

  it('debounces cancellable search and ignores a late stale result', async () => {
    const pending = new Map<string, (items: readonly MemoryPanelRecord[]) => void>()
    const search = vi.fn(
      ({ query }: { query: string }) =>
        new Promise<readonly MemoryPanelRecord[]>((resolve) => pending.set(query, resolve)),
    )
    const value = controller({ search })
    const { panel, stdin, stdout } = await renderPanel(value)

    stdin.write('/')
    await panel.waitUntilRenderFlush()
    stdin.write('a')
    await vi.waitFor(() =>
      expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: 'a' })),
    )
    stdin.write('b')
    await vi.waitFor(() =>
      expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: 'ab' })),
    )
    pending.get('ab')?.([second])
    await vi.waitFor(() =>
      expect(stdout.output.lastIndexOf('Keep business')).toBeGreaterThan(
        stdout.output.lastIndexOf('使用 pnpm'),
      ),
    )
    pending.get('a')?.([first])
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(stdout.output.lastIndexOf('Keep business')).toBeGreaterThan(
      stdout.output.lastIndexOf('使用 pnpm'),
    )

    panel.unmount()
    await panel.waitUntilExit()
  })

  it('isolates /memory from chat history and restores chat input after Esc', async () => {
    const append = vi.fn()
    const submit = vi.fn()
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        history: { append, list: () => [] },
        initialInput: '/memory',
        memory: controller(),
        onSubmit: submit,
      },
      {
        debug: true,
        interactive: true,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    stdin.write('\r')
    await vi.waitFor(() => expect(stdout.output).toContain('Memory · project'))
    expect(append).not.toHaveBeenCalled()
    stdin.write('\u001B')
    await vi.waitFor(() => expect(stdout.output).toContain('memory closed'))
    stdin.write('after panel')
    await app.waitUntilRenderFlush()
    stdin.write('\r')
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith('after panel', undefined))
    expect(append).toHaveBeenCalledWith('after panel')

    app.unmount()
    await app.waitUntilExit()
  })
})

describe('truncateTerminal', () => {
  it('counts CJK and emoji display width without splitting output', () => {
    expect(truncateTerminal('abc中文🚀tail', 9)).toBe('abc中文…')
  })
})
