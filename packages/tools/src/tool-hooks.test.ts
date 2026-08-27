import { PermissionManager } from '@volund/permission'
import type { Tool, ToolContext } from '@volund/tool-kit'
import { describe, expect, it, vi } from 'vitest'

import { ToolExecutor, type ToolHookDispatcher, type ToolHookOutcome } from './index'

const bashSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { command: { type: 'string', minLength: 1 } },
  required: ['command'],
} as never

function bashStub(invokeCalls: unknown[]) {
  return {
    name: 'Bash',
    description: 'stub bash tool',
    inputSchema: bashSchema,
    permissionSpec: () => ({}),
    async invoke(input: { command: string }) {
      invokeCalls.push(input)
      return {
        content: [{ type: 'text' as const, text: `ran: ${input.command}` }],
        meta: { durationMs: 1 },
      }
    },
  } satisfies Tool<{ command: string }>
}

function context(): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    session: { id: 's', cwd: process.cwd(), turnId: 'turn-1' },
    native: { execute: async () => '' },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ui: { requestInput: async () => '' },
  }
}

function hookedExecutor(
  dispatch: ToolHookDispatcher | undefined,
  _invokeCalls: unknown[],
): { executor: ToolExecutor; prompts: ReturnType<typeof vi.fn> } {
  const manager = new PermissionManager()
  const prompts = vi.fn(async () => ({ kind: 'allow-once' as const }))
  manager.setPromptHandler(prompts)
  return {
    executor: new ToolExecutor(manager, () => context(), dispatch),
    prompts,
  }
}

const signal = () => new AbortController().signal

describe('ToolExecutor hook wiring (REM-52: pre/postToolUse dispatch)', () => {
  it('blocks the tool with an isError result when preToolUse vetoes', async () => {
    const invokeCalls: unknown[] = []
    const { executor, prompts } = hookedExecutor(
      async () => ({ veto: true, reason: 'blocked by git-helper: rm -rf detected' }),
      invokeCalls,
    )
    const result = await executor.execute(bashStub(invokeCalls), { command: 'rm -rf /' }, signal())
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      { type: 'text', text: 'blocked by hook: blocked by git-helper: rm -rf detected' },
    ])
    expect(invokeCalls).toEqual([])
    expect(prompts).not.toHaveBeenCalled()
  })

  it('does not affect other tool calls when one is vetoed', async () => {
    const invokeCalls: unknown[] = []
    let vetoNext = true
    const { executor } = hookedExecutor(
      async (): Promise<ToolHookOutcome | undefined> =>
        vetoNext ? { veto: true, reason: 'first blocked' } : undefined,
      invokeCalls,
    )
    const tool = bashStub(invokeCalls)
    const blocked = await executor.execute(tool, { command: 'rm -rf /' }, signal())
    vetoNext = false
    const allowed = await executor.execute(tool, { command: 'ls' }, signal())
    expect(blocked.isError).toBe(true)
    expect(allowed.isError).toBeUndefined()
    expect(invokeCalls).toEqual([{ command: 'ls' }])
  })

  it('adopts input rewritten by a preToolUse handler', async () => {
    const invokeCalls: unknown[] = []
    const { executor } = hookedExecutor(
      async (_event, payload) => ({
        value: { ...(payload as { input: unknown }), input: { command: 'ls rewritten' } },
      }),
      invokeCalls,
    )
    const result = await executor.execute(bashStub(invokeCalls), { command: 'ls' }, signal())
    expect(invokeCalls).toEqual([{ command: 'ls rewritten' }])
    expect(result.content).toEqual([{ type: 'text', text: 'ran: ls rewritten' }])
  })

  it('rejects a preToolUse rewrite that breaks the input schema', async () => {
    const invokeCalls: unknown[] = []
    const { executor } = hookedExecutor(
      async (): Promise<ToolHookOutcome> => ({ value: { input: { wrong: true } } }),
      invokeCalls,
    )
    const result = await executor.execute(bashStub(invokeCalls), { command: 'ls' }, signal())
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect((result.content[0] as { text: string }).text).toContain('Invalid input after preToolUse')
    expect(invokeCalls).toEqual([])
  })

  it('lets postToolUse handlers rewrite the result', async () => {
    const invokeCalls: unknown[] = []
    const { executor } = hookedExecutor(
      async (event): Promise<ToolHookOutcome | undefined> =>
        event === 'postToolUse'
          ? { value: { result: { content: [{ type: 'text', text: 'redacted output' }] } } }
          : undefined,
      invokeCalls,
    )
    const result = await executor.execute(bashStub(invokeCalls), { command: 'ls' }, signal())
    expect(result.content).toEqual([{ type: 'text', text: 'redacted output' }])
    expect(result.isError).toBeUndefined()
  })

  it('replaces the visible result when postToolUse vetoes', async () => {
    const invokeCalls: unknown[] = []
    const { executor } = hookedExecutor(
      async (event): Promise<ToolHookOutcome | undefined> =>
        event === 'postToolUse' ? { veto: true, reason: 'secret in output' } : undefined,
      invokeCalls,
    )
    const result = await executor.execute(bashStub(invokeCalls), { command: 'ls' }, signal())
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'blocked by hook: secret in output' }])
  })

  it('runs postToolUse for failed tool results too', async () => {
    const seen: string[] = []
    const dispatch: ToolHookDispatcher = async (event, payload) => {
      if (event === 'postToolUse') {
        const { result } = payload as { result: { isError?: boolean } }
        seen.push(`isError=${String(result.isError)}`)
      }
      return undefined
    }
    const invokeCalls: unknown[] = []
    const { executor } = hookedExecutor(dispatch, invokeCalls)
    const tool = bashStub(invokeCalls)
    await executor.execute(tool, { command: 'ls' }, signal())
    // Force a failing tool result through the same hook path.
    const failing = {
      ...tool,
      async invoke() {
        throw new Error('sandbox failure')
      },
    }
    const failed = await executor.execute(failing, { command: 'ls' }, signal())
    expect(failed.isError).toBe(true)
    expect(seen).toEqual(['isError=undefined', 'isError=true'])
  })

  it('passes toolUseId and turnId through the hook payload', async () => {
    const payloads: unknown[] = []
    const dispatch: ToolHookDispatcher = async (_event, payload) => {
      payloads.push(payload)
      return undefined
    }
    const invokeCalls: unknown[] = []
    const { executor } = hookedExecutor(dispatch, invokeCalls)
    await executor.execute(bashStub(invokeCalls), { command: 'ls' }, signal(), 'toolu_01')
    expect(payloads).toEqual([
      expect.objectContaining({ tool: 'Bash', toolUseId: 'toolu_01', turnId: 'turn-1' }),
      expect.objectContaining({ tool: 'Bash', toolUseId: 'toolu_01', turnId: 'turn-1' }),
    ])
    expect((payloads[1] as { result: unknown }).result).toMatchObject({
      content: [{ type: 'text', text: 'ran: ls' }],
    })
  })

  it('returns a failure result when the hook dispatcher itself throws', async () => {
    const invokeCalls: unknown[] = []
    const { executor } = hookedExecutor(async () => {
      throw new Error('hook bus exploded')
    }, invokeCalls)
    const result = await executor.execute(bashStub(invokeCalls), { command: 'ls' }, signal())
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('hook bus exploded')
    expect(invokeCalls).toEqual([])
  })

  it('skips hook dispatch entirely when no dispatcher is configured', async () => {
    const invokeCalls: unknown[] = []
    const { executor, prompts } = hookedExecutor(undefined, invokeCalls)
    const result = await executor.execute(bashStub(invokeCalls), { command: 'ls' }, signal())
    expect(result.isError).toBeUndefined()
    expect(prompts).toHaveBeenCalledTimes(1)
  })
})
