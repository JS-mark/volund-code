import type { ToolContext } from '@apollo-code/tool-kit'
import { describe, expect, it, vi } from 'vitest'

import { BackgroundShells, MAX_BACKGROUND_BUFFER_BYTES } from './background-shells'
import { BashTool, KillShellTool, ShellOutputTool } from './index'

interface DeferredNative {
  native: {
    execute: (
      command: string,
      args: string[],
      signal: AbortSignal,
      env?: unknown,
    ) => Promise<unknown>
    __deferred: { resolveNow?: (v: unknown) => void }
  }
  aborted: () => boolean
}

function deferredNative(): DeferredNative {
  const state = { aborted: false }
  const holder: { resolveNow?: (v: unknown) => void } = {}
  const execute = vi.fn(
    (_command: string, _args: string[], signal: AbortSignal) =>
      new Promise<unknown>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          state.aborted = true
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        })
        holder.resolveNow = resolve
      }),
  )
  return { native: { execute, __deferred: holder }, aborted: () => state.aborted }
}

function ctx(d: DeferredNative): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    session: { id: 's1', cwd: '/repo', turnId: 't1' },
    native: d.native,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ui: { requestInput: async () => '' },
  } as unknown as ToolContext
}

const runInBackgroundInput = { command: 'npm test -- --watch', runInBackground: true }

describe('BackgroundShells (r13-G2)', () => {
  it('Bash runInBackground returns immediately with shellId without awaiting the command', async () => {
    const background = new BackgroundShells()
    const d = deferredNative()
    const tool = new BashTool({ background, platform: 'darwin' })
    const out = await tool.invoke(runInBackgroundInput, ctx(d))
    expect(out.isError).toBeFalsy()
    const text = JSON.stringify(out.content)
    expect(text).toContain('shellId')
    expect(text).toContain('ShellOutput')
    expect(d.native.execute).toHaveBeenCalled()
  })

  it('view reports still-running; after completion wait returns output + exit code', async () => {
    const background = new BackgroundShells()
    const d = deferredNative()
    const bash = new BashTool({ background, platform: 'darwin' })
    const started = await bash.invoke(runInBackgroundInput, ctx(d))
    const shellId = extractShellId(started.content)
    const shellOutput = new ShellOutputTool(background)
    const mid = await shellOutput.invoke({ shellId, action: 'view' })
    expect(JSON.stringify(mid.content)).toContain('still running')

    d.native.__deferred.resolveNow?.('line-1\nline-2\n')
    const final = await shellOutput.invoke({ shellId, action: 'wait', timeoutMs: 2000 })
    expect(JSON.stringify(final.content)).toContain('line-1')
    expect(JSON.stringify(final.content)).toContain('[exitCode: 0 (exit)]')
  })

  it('kill aborts the sandboxed execution and reports killed semantics', async () => {
    const background = new BackgroundShells()
    const d = deferredNative()
    const bash = new BashTool({ background, platform: 'darwin' })
    const started = await bash.invoke(runInBackgroundInput, ctx(d))
    const shellId = extractShellId(started.content)
    const out = await new KillShellTool(background).invoke({ shellId })
    expect(JSON.stringify(out.content)).toContain(`killed shell ${shellId}`)
    await vi.waitFor(() => expect(background.view(shellId)).toContain('killed'))
    expect(d.aborted()).toBe(true)
  })

  it('killAll terminates every live shell (session.ended contract)', async () => {
    const background = new BackgroundShells()
    const bash = new BashTool({ background, platform: 'darwin' })
    await bash.invoke(runInBackgroundInput, ctx(deferredNative()))
    await bash.invoke({ command: 'cargo build', runInBackground: true }, ctx(deferredNative()))
    expect(background.killAll('session_ended')).toBe(2)
    for (const { shellId } of background.list())
      await vi.waitFor(() => expect(background.view(shellId)).toContain('session_ended'))
  })

  it('caps output at 10MB, drops the head, and reports droppedBytes on exit', async () => {
    const big = 'x'.repeat(MAX_BACKGROUND_BUFFER_BYTES + 4096)
    const background = new BackgroundShells()
    const events: Array<Record<string, unknown>> = []
    background.events.exited = (p) => events.push({ ...p })
    const { shellId } = background.spawn({
      command: 'big',
      cwd: '/repo',
      run: async () => big,
    })
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]?.droppedBytes).toBe(4096)
    const text = background.view(shellId)
    expect(text).toContain('dropped 4096 bytes')
    expect(text.length).toBeLessThan(MAX_BACKGROUND_BUFFER_BYTES + 100) // 截断的是输出体；视图另有 dropped 标注 + exitCode 行
  })

  it('emits started and exited events with the appendix D payload shapes', async () => {
    const background = new BackgroundShells()
    const started: Array<Record<string, unknown>> = []
    const exited: Array<Record<string, unknown>> = []
    background.events.started = (p) => started.push({ ...p })
    background.events.exited = (p) => exited.push({ ...p })
    const { shellId } = background.spawn({
      command: 'echo hi',
      cwd: '/repo',
      run: async () => 'hi',
    })
    await vi.waitFor(() => expect(exited).toHaveLength(1))
    expect(started[0]).toMatchObject({ shellId, command: 'echo hi', cwd: '/repo' })
    expect(exited[0]).toMatchObject({ shellId, exitCode: 0, reason: 'exit' })
  })

  it('background Bash permissionSpec marks background for the permission layer', () => {
    const tool = new BashTool({ platform: 'darwin' })
    expect(tool.permissionSpec(runInBackgroundInput).bash?.background).toBe(true)
    expect(tool.permissionSpec({ command: 'ls' }).bash?.background).toBeUndefined()
  })
})

function extractShellId(content: unknown): string {
  const text = JSON.stringify(content)
  const match = text.match(/shell-([0-9a-f]{8})/)
  if (!match) throw new Error(`no shellId in ${text}`)
  return `shell-${match[1]}`
}
