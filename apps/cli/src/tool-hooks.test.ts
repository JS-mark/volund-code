import { PermissionManager } from '@apollo-code/permission'
import {
  BridgeRuntime,
  BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES,
  createToolHookDispatcher,
  type BridgeHost,
  type HookPipelineSignal,
} from '@apollo-code/plugin-runtime'
import type { PluginManifest } from '@apollo-code/plugin-sdk'
import type { Tool, ToolContext } from '@apollo-code/tool-kit'
import { ToolExecutor } from '@apollo-code/tools'
import { describe, expect, it, vi } from 'vitest'

const gitHelperManifest: PluginManifest = {
  name: 'apollo-plugin-git-helper',
  version: '1.2.0',
  engines: { apollo: '0.1.0' },
  main: 'index.js',
  type: 'module',
  permissions: { apollo: ['hooks.on'] },
}

function stubHost(): BridgeHost {
  return {
    session: {
      id: 's',
      cwd: process.cwd(),
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    register: () => ({ dispose() {} }),
    fs: {
      readFile: async () => '',
      writeFile: async () => {},
      exists: async () => false,
      glob: async () => [],
      stat: async () => ({}),
    },
    exec: async () => ({}),
    fetch: async () => ({}),
    ui: () => undefined,
    storage: async () => undefined,
    config: () => undefined,
    log: () => {},
  }
}

function bashStub(invokeCalls: Array<{ command: string }>): Tool<{ command: string }> {
  return {
    name: 'Bash',
    description: 'stub bash tool',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { command: { type: 'string', minLength: 1 } },
      required: ['command'],
    } as never,
    permissionSpec: () => ({}),
    async invoke(input: { command: string }) {
      invokeCalls.push(input)
      return {
        content: [{ type: 'text', text: `ran: ${input.command}` }],
        meta: { durationMs: 0 },
      }
    },
  }
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

describe('tool hook dispatch composition (REM-52, r11-REM5 acceptance)', () => {
  it('replicates the 06a §6.4.2 git-helper veto end-to-end', async () => {
    const runtime = new BridgeRuntime(stubHost())
    const bridge = runtime.create(gitHelperManifest, process.cwd(), 'tool-1')
    bridge.hooks.on('preToolUse', (payload) => {
      const event = payload as { tool: string; input: { command?: string } }
      if (event.tool === 'Bash' && /\brm\s+-rf\b/.test(event.input.command ?? ''))
        return { veto: true, reason: 'blocked by git-helper: rm -rf detected' }
      return undefined
    })
    const manager = new PermissionManager()
    manager.setPromptHandler(async () => ({ kind: 'allow-once' }))
    const executor = new ToolExecutor(manager, () => context(), createToolHookDispatcher(runtime))
    const invokeCalls: Array<{ command: string }> = []
    const tool = bashStub(invokeCalls)

    const blocked = await executor.execute(
      tool,
      { command: 'rm -rf /tmp/apollo-rem-52-e2e' },
      new AbortController().signal,
      'toolu_blocked',
    )
    expect(blocked.isError).toBe(true)
    expect(blocked.content).toEqual([
      { type: 'text', text: 'blocked by hook: blocked by git-helper: rm -rf detected' },
    ])
    expect(invokeCalls).toEqual([])

    const allowed = await executor.execute(tool, { command: 'ls' }, new AbortController().signal)
    expect(allowed.isError).toBeUndefined()
    expect(invokeCalls).toEqual([{ command: 'ls' }])
  })

  it('fail-closes the tool when a builtin hook times out (5s per handler)', async () => {
    vi.useFakeTimers()
    const runtime = new BridgeRuntime(stubHost())
    runtime.registerHostHook('builtin', 'preToolUse', () => new Promise(() => {}))
    const reports: HookPipelineSignal[] = []
    const manager = new PermissionManager()
    manager.setPromptHandler(async () => ({ kind: 'allow-once' }))
    const executor = new ToolExecutor(
      manager,
      () => context(),
      createToolHookDispatcher(runtime, { report: (signal) => reports.push(signal) }),
    )
    const invokeCalls: Array<{ command: string }> = []
    const pending = executor.execute(
      bashStub(invokeCalls),
      { command: 'ls' },
      new AbortController().signal,
      'toolu_timeout',
    )
    await vi.advanceTimersByTimeAsync(6_000)
    const result = await pending
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('blocked by hook')
    expect((result.content[0] as { text: string }).text).toContain('fail-closed')
    expect(invokeCalls).toEqual([])
    expect(reports.map((report) => report.code)).toEqual(['builtin_hook_timeout'])
    vi.useRealTimers()
  })

  it('lets the tool proceed when a plugin hook times out, reporting a warning', async () => {
    vi.useFakeTimers()
    const runtime = new BridgeRuntime(stubHost())
    const bridge = runtime.create(gitHelperManifest, process.cwd(), 'tool-1')
    bridge.hooks.on('preToolUse', () => new Promise(() => {}))
    const reports: HookPipelineSignal[] = []
    const manager = new PermissionManager()
    manager.setPromptHandler(async () => ({ kind: 'allow-once' }))
    const executor = new ToolExecutor(
      manager,
      () => context(),
      createToolHookDispatcher(runtime, { report: (signal) => reports.push(signal) }),
    )
    const invokeCalls: Array<{ command: string }> = []
    const pending = executor.execute(
      bashStub(invokeCalls),
      { command: 'ls' },
      new AbortController().signal,
      'toolu_slow',
    )
    await vi.advanceTimersByTimeAsync(6_000)
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([{ type: 'text', text: 'ran: ls' }])
    expect(invokeCalls).toEqual([{ command: 'ls' }])
    expect(reports.map((report) => report.kind)).toEqual(['hook_skipped'])
    vi.useRealTimers()
  })

  it('vetoes an oversized builtin preToolUse payload before native tool invocation', async () => {
    const runtime = new BridgeRuntime(stubHost())
    const handler = vi.fn()
    runtime.registerHostHook('builtin', 'preToolUse', handler, { name: 'apollo.secret-scan' })
    const reports: HookPipelineSignal[] = []
    const manager = new PermissionManager()
    const prompt = vi.fn(async () => ({ kind: 'allow-once' as const }))
    manager.setPromptHandler(prompt)
    const executor = new ToolExecutor(
      manager,
      () => context(),
      createToolHookDispatcher(runtime, { report: (signal) => reports.push(signal) }),
    )
    const invokeCalls: Array<{ command: string }> = []
    const dangerousTail = '; api_key=top-secret; rm -rf /'
    const result = await executor.execute(
      bashStub(invokeCalls),
      { command: `${'x'.repeat(BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES)}${dangerousTail}` },
      new AbortController().signal,
      'toolu_oversized',
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('blocked by hook')
    expect((result.content[0] as { text: string }).text).toContain('fail-closed')
    expect(handler).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
    expect(invokeCalls).toEqual([])
    expect(reports).toEqual([
      expect.objectContaining({
        kind: 'builtin_hook_payload_too_large',
        code: 'builtin_hook_payload_too_large',
        event: 'preToolUse',
        scanStatus: 'not_started',
        scannedBytes: 0,
        scannedDigest: null,
      }),
    ])
  })

  it('blocks an oversized postToolUse result without claiming to roll back the tool side effect', async () => {
    const runtime = new BridgeRuntime(stubHost())
    const postHandler = vi.fn()
    runtime.registerHostHook('builtin', 'postToolUse', postHandler, { name: 'apollo.output-scan' })
    const reports: HookPipelineSignal[] = []
    const manager = new PermissionManager()
    manager.setPromptHandler(async () => ({ kind: 'allow-once' }))
    const executor = new ToolExecutor(
      manager,
      () => context(),
      createToolHookDispatcher(runtime, { report: (signal) => reports.push(signal) }),
    )
    const invokeCalls: Array<{ command: string }> = []
    const tool = bashStub(invokeCalls)
    tool.invoke = async (input: { command: string }) => {
      invokeCalls.push(input)
      return {
        content: [
          {
            type: 'text' as const,
            text: `created artifact\n${'x'.repeat(BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES)}`,
          },
        ],
        meta: { durationMs: 0 },
      }
    }
    const result = await executor.execute(
      tool,
      { command: 'create-artifact' },
      new AbortController().signal,
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('blocked by hook')
    expect((result.content[0] as { text: string }).text).not.toContain('created artifact')
    expect((result.content[0] as { text: string }).text).not.toContain('rolled back')
    expect(invokeCalls).toEqual([{ command: 'create-artifact' }])
    expect(postHandler).not.toHaveBeenCalled()
    expect(reports).toEqual([
      expect.objectContaining({
        kind: 'builtin_hook_payload_too_large',
        event: 'postToolUse',
        scanStatus: 'not_started',
      }),
    ])
  })
})
