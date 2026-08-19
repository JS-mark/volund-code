import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Duplex, PassThrough } from 'node:stream'

import { createSession, DefaultPromptComposer, EventBus, updateSession } from '@apollo-code/core'
import type { Runner, SessionState } from '@apollo-code/core'
import type { PluginHost } from '@apollo-code/native-bridge'
import type { PermissionRequest } from '@apollo-code/permission'
import { DefaultMemoryService, LocalMemoryRepository, MemoryError } from '@apollo-code/storage'
import type { ToolContext } from '@apollo-code/tool-kit'
import { BashTool } from '@apollo-code/tools'
import type { InteractivePermissionRequest } from '@apollo-code/ui'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runCli } from './cli'
import { createMemoryPanelController } from './memory-panel'
import { projectMemoryScope } from './memory-scope'
import { createMemoryTools } from './memory-tools'
import {
  buildStatusViewModel,
  createPluginMemoryHost,
  createProductionPorts,
  ProductionPermissionSessionPolicy,
  createProductionToolPermissionChain,
  createStatusSnapshotAdapter,
  FileInputHistoryStore,
  registerRuntimeMemoryPrompts,
  requestPermission,
  RuntimeSessionPort,
} from './runtime'

const fixtures: string[] = []
afterEach(async () =>
  Promise.all(fixtures.splice(0).map((path) => rm(path, { force: true, recursive: true }))),
)

function fakeFactory(
  observe: (state: SessionState, events: EventBus) => void = () => {},
): (state: SessionState, events: EventBus) => Runner {
  return (initial, events) => {
    let state = initial
    let runs = 0
    const fake = {
      get state() {
        return state
      },
      events,
      interrupt: vi.fn(() => {
        state = updateSession(state, (draft) => {
          draft.pendingInterrupt = true
        })
      }),
      run: vi.fn(async (text: string) => {
        runs += 1
        const turnId = `turn-${runs}`
        const messageId = `user-${runs}`
        // 与真实 Runner 对齐的附录 D 事件（r13-I8）：JSONL 只落事件，
        // resume 由 replaySessionState 重建（§8.2 D1-1；session.snapshot 已移除）。
        await events.emit({
          type: 'turn.started',
          version: state.version,
          sessionId: state.id,
          turnId,
          payload: { turnId },
        })
        await events.emit({
          type: 'message.appended',
          version: state.version,
          sessionId: state.id,
          turnId,
          payload: { messageId, role: 'user', content: [{ type: 'text', text }] },
        })
        state = updateSession(state, (draft) => {
          draft.messages = [
            ...draft.messages,
            { id: messageId, role: 'user', content: [{ type: 'text', text }], createdAt: 1 },
          ]
          draft.turns = [
            ...draft.turns,
            { id: turnId, startMessageId: messageId, status: 'streaming', parentDepth: 0 },
          ]
          draft.activeTurn = turnId
        })
        return state
      }),
    } as unknown as Runner
    observe(state, events)
    return fake
  }
}

type RpcFrame = {
  jsonrpc: '2.0'
  bridgeVersion: 1
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { message: string }
}

function memoryPolicyPluginHost(events: Array<{ event: string; payload: any }>) {
  const clients: Array<{ request(method: string, params: unknown): Promise<unknown> }> = []
  const start = async (): Promise<PluginHost> => {
    const childToParent = new PassThrough()
    const parentToChild = new PassThrough()
    const transport = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        parentToChild.write(chunk, callback)
      },
      final(callback) {
        parentToChild.end(callback)
      },
    })
    childToParent.on('data', (chunk) => transport.push(chunk))
    childToParent.on('end', () => transport.push(null))
    parentToChild.setEncoding('utf8')
    let buffer = ''
    let nextId = 100
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
    const send = (frame: RpcFrame) => childToParent.write(`${JSON.stringify(frame)}\n`)
    const request = (method: string, params: unknown) => {
      const id = nextId++
      const result = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }))
      send({ jsonrpc: '2.0', bridgeVersion: 1, id, method, params })
      return result
    }
    clients.push({ request })
    parentToChild.on('data', (chunk: string) => {
      buffer += chunk
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const frame = JSON.parse(buffer.slice(0, newline)) as RpcFrame
        buffer = buffer.slice(newline + 1)
        if (frame.method === 'callback.invoke' && frame.id !== undefined) {
          const params = frame.params as { callbackId: string; args: any[] }
          const payload = params.args[0]
          const responseId = frame.id
          events.push({ event: params.callbackId, payload })
          if (params.callbackId === 'memory-pre-write' && payload?.id === 'recursive-policy') {
            void request('apollo.memory.create', {
              scope: payload.scope,
              id: 'recursive-child',
              content: 'safe nested write',
            }).then(
              () => send({ jsonrpc: '2.0', bridgeVersion: 1, id: responseId, result: undefined }),
              (error: Error) =>
                send({
                  jsonrpc: '2.0',
                  bridgeVersion: 1,
                  id: responseId,
                  error: { message: error.message },
                }),
            )
            continue
          }
          const veto =
            params.callbackId === 'memory-pre-write' &&
            (String(payload?.id).startsWith('blocked-') || payload?.content === 'blocked')
          send({
            jsonrpc: '2.0',
            bridgeVersion: 1,
            id: frame.id,
            result: veto ? { veto: true, reason: 'fixture policy veto' } : undefined,
          })
          continue
        }
        if (frame.id === undefined) continue
        const waiter = pending.get(frame.id)
        if (!waiter) continue
        pending.delete(frame.id)
        if (frame.error) waiter.reject(new Error(frame.error.message))
        else waiter.resolve(frame.result)
      }
    })
    queueMicrotask(() => {
      send({
        jsonrpc: '2.0',
        bridgeVersion: 1,
        id: 1,
        method: 'apollo.hooks.on',
        params: ['memory.preWrite', { $callback: 'memory-pre-write' }, { priority: 50 }],
      })
      send({
        jsonrpc: '2.0',
        bridgeVersion: 1,
        id: 2,
        method: 'apollo.hooks.on',
        params: ['memory.postWrite', { $callback: 'memory-post-write' }],
      })
      send({
        jsonrpc: '2.0',
        bridgeVersion: 1,
        id: 3,
        method: 'apollo.hooks.on',
        params: ['memory.deleted', { $callback: 'memory-deleted' }],
      })
      send({ jsonrpc: '2.0', bridgeVersion: 1, method: 'host.activated', params: {} })
    })
    return {
      pid: clients.length,
      bridge: transport,
      terminate: () => {
        transport.destroy()
        childToParent.destroy()
        parentToChild.destroy()
      },
      exited: new Promise(() => {}),
    }
  }
  return { clients, start }
}

describe('RuntimeSessionPort', () => {
  it('runs through a real session port and persists appendix D events (no session.snapshot)', async () => {
    const root = await mkdtemp(join(process.cwd(), '.runtime-'))
    fixtures.push(root)
    const runtime = new RuntimeSessionPort(root, fakeFactory())
    const { id } = await runtime.start({ cwd: process.cwd(), prompt: 'hello' })
    const lines = (await readFile(join(root, `${id}.jsonl`), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; payload: any })
    const types = lines.map((line) => line.type)
    // REM-74（§8.2 D1-1）：JSONL 只落事件——session.started 开场、message.appended
    // 携带 ★messageId ★role ★content 可 replay 重建，session.snapshot 快照行被移除。
    expect(types).toContain('session.started')
    expect(types).not.toContain('session.snapshot')
    expect(types).toContain('turn.started')
    const appended = lines.find((line) => line.type === 'message.appended')
    expect(appended?.payload).toEqual({
      messageId: 'user-1',
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    })
  })

  it('resumes via event replay, aborts an incomplete turn, and emits session.resumed', async () => {
    const root = await mkdtemp(join(process.cwd(), '.runtime-'))
    fixtures.push(root)
    const first = new RuntimeSessionPort(root, fakeFactory())
    const { id } = await first.start({ cwd: process.cwd(), prompt: 'unfinished' })
    let restored: SessionState | undefined
    const second = new RuntimeSessionPort(
      root,
      fakeFactory((state) => {
        restored = state
      }),
    )
    await second.resume(id)
    expect(restored?.activeTurn).toBeNull()
    expect(restored?.turns[0]?.status).toBe('aborted')
    expect(await readFile(join(root, `${id}.jsonl`), 'utf8')).toContain('session.resumed')
  })

  it('returns an interactive handle for the restored session', async () => {
    const root = await mkdtemp(join(process.cwd(), '.runtime-'))
    fixtures.push(root)
    const first = new RuntimeSessionPort(root, fakeFactory())
    const { id } = await first.start({ cwd: process.cwd(), prompt: 'before resume' })
    const second = new RuntimeSessionPort(root, fakeFactory())

    const interactive = await second.resumeInteractive(id)
    await interactive.submit('after resume')

    expect(interactive.id).toBe(id)
    expect(await readFile(join(root, `${id}.jsonl`), 'utf8')).toContain('after resume')
  })

  it('keeps the current session active when a resumed runner cannot be constructed', async () => {
    const root = await mkdtemp(join(process.cwd(), '.runtime-'))
    fixtures.push(root)
    const targetRuntime = new RuntimeSessionPort(root, fakeFactory())
    const target = await targetRuntime.start({ cwd: process.cwd(), prompt: 'target' })
    let creations = 0
    const runtime = new RuntimeSessionPort(root, (state, events) => {
      creations += 1
      if (creations > 1) throw new Error('runner construction failed')
      return fakeFactory()(state, events)
    })
    const current = await runtime.startInteractive({ cwd: process.cwd() })

    await expect(runtime.resumeInteractive(target.id)).rejects.toThrow('runner construction failed')
    await current.submit('still current')

    expect(await readFile(join(root, `${current.id}.jsonl`), 'utf8')).toContain('still current')
    expect(await readFile(join(root, `${target.id}.jsonl`), 'utf8')).not.toContain('still current')
  })
})

describe('production tool permission composition', () => {
  it('uses explicit none interaction to deny a real BashTool before native execution', async () => {
    const events = new EventBus()
    const state = createSession({
      id: 'session-1',
      cwd: process.cwd(),
      maxTokens: 200_000,
      toolRegistrySnapshot: 'runtime-permission-test',
    })
    const nativeExecute = vi.fn(async () => 'must not run')
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }
    const chain = createProductionToolPermissionChain({
      state,
      events,
      permissionSnapshot: { dangerouslySkip: false, interactionMode: 'none' },
      logger,
      interactivePermissionPrompt: () => undefined,
      terminalIsInteractive: () => false,
    })
    const executor = chain.bindExecutor(
      (signal): ToolContext => ({
        abortSignal: signal,
        session: { id: state.id, cwd: state.cwd, turnId: 'turn-1' },
        native: { execute: nativeExecute },
        logger,
        ui: { requestInput: async () => '' },
      }),
    )

    const result = await executor.execute(
      new BashTool({ platform: 'darwin' }),
      { command: 'git status' },
      new AbortController().signal,
      'toolu_no_prompt',
    )

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Permission denied for Bash' }])
    expect(nativeExecute).not.toHaveBeenCalled()
  })

  it('keeps ordinary Cf raw for native execution and exact session grant keys', async () => {
    const events = new EventBus()
    const permissionEvents: unknown[] = []
    events.subscribe((event) => {
      if (event.type === 'tool.permission_asked') permissionEvents.push(event.payload)
    })
    const state = createSession({
      id: 'session-line',
      cwd: process.cwd(),
      maxTokens: 200_000,
      toolRegistrySnapshot: 'runtime-permission-test',
    })
    const rawCommand = 'printf "safe\u200Btext"'
    const normalizedVariant = 'printf "safetext"'
    const linePrompt = vi.fn().mockResolvedValueOnce('s').mockResolvedValueOnce('d')
    const nativeExecute = vi.fn(async (_program: string, _args: string[]) => 'executed raw input')
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }
    const chain = createProductionToolPermissionChain({
      state,
      events,
      permissionSnapshot: { dangerouslySkip: false, interactionMode: 'line' },
      logger,
      interactivePermissionPrompt: () => undefined,
      linePermissionPrompt: linePrompt,
      terminalIsInteractive: () => true,
    })
    const executor = chain.bindExecutor(
      (signal): ToolContext => ({
        abortSignal: signal,
        session: { id: state.id, cwd: state.cwd, turnId: 'turn-line' },
        native: { execute: nativeExecute },
        logger,
        ui: { requestInput: async () => '' },
      }),
    )

    const firstResult = await executor.execute(
      new BashTool({ platform: 'darwin' }),
      { command: rawCommand },
      new AbortController().signal,
      'toolu_line_unicode',
    )
    const cachedResult = await executor.execute(
      new BashTool({ platform: 'darwin' }),
      { command: rawCommand },
      new AbortController().signal,
      'toolu_line_unicode_cached',
    )
    const variantResult = await executor.execute(
      new BashTool({ platform: 'darwin' }),
      { command: normalizedVariant },
      new AbortController().signal,
      'toolu_line_unicode_variant',
    )

    expect(firstResult.isError).not.toBe(true)
    expect(cachedResult.isError).not.toBe(true)
    expect(variantResult.isError).toBe(true)
    expect(linePrompt).toHaveBeenCalledTimes(2)
    expect(linePrompt.mock.calls[0]![0]).toContain('safe\\u{200B}text')
    expect(linePrompt.mock.calls[0]![0]).not.toContain(rawCommand)
    expect(linePrompt.mock.calls[1]![0]).toContain('safetext')
    expect(nativeExecute).toHaveBeenCalledTimes(2)
    expect(nativeExecute.mock.calls[0]![1].join(' ')).toContain(rawCommand)
    expect(nativeExecute.mock.calls[1]![1].join(' ')).toContain(rawCommand)
    expect(permissionEvents).toMatchObject([
      { spec: { bash: { command: rawCommand } } },
      { spec: { bash: { command: normalizedVariant } } },
    ])
  })

  it('shows a deny-only marker when sanitization would hide part of a raw Bash command', async () => {
    const events = new EventBus()
    const state = createSession({
      id: 'session-sensitive-line',
      cwd: process.cwd(),
      maxTokens: 200_000,
      toolRegistrySnapshot: 'runtime-permission-test',
    })
    const rawCommand = 'printf safe token=top-secret|touch /tmp/side-effect'
    const linePrompt = vi.fn(async (_question: string) => 'a')
    const nativeExecute = vi.fn(async () => 'must not execute')
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }
    const chain = createProductionToolPermissionChain({
      state,
      events,
      permissionSnapshot: { dangerouslySkip: false, interactionMode: 'line' },
      logger,
      interactivePermissionPrompt: () => undefined,
      linePermissionPrompt: linePrompt,
      terminalIsInteractive: () => true,
    })
    const executor = chain.bindExecutor(
      (signal): ToolContext => ({
        abortSignal: signal,
        session: { id: state.id, cwd: state.cwd, turnId: 'turn-sensitive' },
        native: { execute: nativeExecute },
        logger,
        ui: { requestInput: async () => '' },
      }),
    )

    const result = await executor.execute(
      new BashTool({ platform: 'darwin' }),
      { command: rawCommand },
      new AbortController().signal,
      'toolu_sensitive_line',
    )

    expect(result.isError).toBe(true)
    expect(linePrompt).toHaveBeenCalledWith(
      expect.stringContaining('[sensitive permission details hidden - deny only]'),
    )
    expect(linePrompt.mock.calls[0]![0]).not.toContain('top-secret')
    expect(linePrompt.mock.calls[0]![0]).not.toContain('side-effect')
    expect(nativeExecute).not.toHaveBeenCalled()
  })

  it.each([
    ['OpenAI provider', `sk-proj-${'A'.repeat(24)}`],
    ['Anthropic provider', `sk-ant-api03-${'B'.repeat(24)}`],
    ['GitHub', `ghp_${'C'.repeat(24)}`],
    ['AWS', `AKIA${'D'.repeat(16)}`],
    ['JWT', `eyJ${'E'.repeat(8)}.${'F'.repeat(12)}.${'G'.repeat(12)}`],
    ['GitHub with Cf', `ghp_\u200B${'H'.repeat(24)}`],
    ['Bearer grammar with Cf', 'Bea\u200Brer qwerty123456'],
    ['token grammar with Cf', 'tok\u200Ben=abc'],
    ['Bearer grammar with NFKC', 'Ｂｅａｒｅｒ qwerty123456'],
    ['api-key grammar with a Unicode hyphen', 'api‐key=abc'],
  ])('redacts a bare %s secret in line display and the permission event', async (_kind, secret) => {
    const events = new EventBus()
    const state = createSession({
      id: `session-secret-${_kind.replaceAll(' ', '-').toLowerCase()}`,
      cwd: process.cwd(),
      maxTokens: 200_000,
      toolRegistrySnapshot: 'runtime-permission-test',
    })
    const rawCommand = `printf '${secret}'`
    const permissionEvents: unknown[] = []
    events.subscribe((event) => {
      if (event.type === 'tool.permission_asked') permissionEvents.push(event.payload)
    })
    const linePrompt = vi.fn(async (_question: string) => 'a')
    const nativeExecute = vi.fn(async () => 'must not execute')
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }
    const chain = createProductionToolPermissionChain({
      state,
      events,
      permissionSnapshot: { dangerouslySkip: false, interactionMode: 'line' },
      logger,
      interactivePermissionPrompt: () => undefined,
      linePermissionPrompt: linePrompt,
      terminalIsInteractive: () => true,
    })
    const executor = chain.bindExecutor(
      (signal): ToolContext => ({
        abortSignal: signal,
        session: { id: state.id, cwd: state.cwd, turnId: 'turn-secret' },
        native: { execute: nativeExecute },
        logger,
        ui: { requestInput: async () => '' },
      }),
    )

    const result = await executor.execute(
      new BashTool({ platform: 'darwin' }),
      { command: rawCommand },
      new AbortController().signal,
      `toolu_secret_${_kind}`,
    )

    expect(result.isError).toBe(true)
    expect(linePrompt).toHaveBeenCalledWith(
      expect.stringContaining('[sensitive permission details hidden - deny only]'),
    )
    expect(linePrompt.mock.calls[0]![0]).not.toContain(secret)
    expect(permissionEvents).toHaveLength(1)
    expect(permissionEvents[0]).toMatchObject({
      spec: { bash: { command: '[REDACTED]' } },
    })
    expect(JSON.stringify(permissionEvents[0])).not.toContain(secret)
    expect(nativeExecute).not.toHaveBeenCalled()
  })

  it.each([
    { kind: 'Cf Bearer grammar', rawSecret: 'Bea\u200Brer qwerty123456' },
    { kind: 'Cf token grammar', rawSecret: 'tok\u200Ben=abc' },
    { kind: 'NFKC Bearer grammar', rawSecret: 'Ｂｅａｒｅｒ qwerty123456' },
    { kind: 'Unicode-hyphen api-key grammar', rawSecret: 'api‐key=abc' },
  ])(
    'enforces deny after a tui handler tries to approve $kind hidden details',
    async ({ rawSecret }) => {
      const events = new EventBus()
      const state = createSession({
        id: 'session-sensitive-tui',
        cwd: process.cwd(),
        maxTokens: 200_000,
        toolRegistrySnapshot: 'runtime-permission-test',
      })
      const rawCommand = `echo ${rawSecret}|touch /tmp/side-effect`
      const mutation = {
        bashFrozen: false,
        displayFrozen: false,
        displayMutated: false,
        inputFrozen: false,
        requestFrozen: false,
        specFrozen: false,
        specMutated: false,
      }
      const prompt = vi.fn(async (request: InteractivePermissionRequest) => {
        mutation.requestFrozen = Object.isFrozen(request)
        mutation.displayFrozen = Object.isFrozen(request.display)
        mutation.inputFrozen = Object.isFrozen(request.input)
        mutation.specFrozen = Object.isFrozen(request.spec)
        mutation.displayMutated = Reflect.set(request.display, 'approvable', true)
        if (request.spec && typeof request.spec === 'object' && !Array.isArray(request.spec)) {
          const bashDescriptor = Object.getOwnPropertyDescriptor(request.spec, 'bash')
          const bash =
            bashDescriptor && 'value' in bashDescriptor ? bashDescriptor.value : undefined
          if (bash && typeof bash === 'object' && !Array.isArray(bash)) {
            mutation.bashFrozen = Object.isFrozen(bash)
            mutation.specMutated = Reflect.set(bash, 'command', 'safe replacement')
          }
        }
        return { kind: 'allow-once' as const }
      })
      const nativeExecute = vi.fn(async () => 'must not execute')
      const logger = {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      }
      const chain = createProductionToolPermissionChain({
        state,
        events,
        permissionSnapshot: { dangerouslySkip: false, interactionMode: 'tui' },
        logger,
        interactivePermissionPrompt: () => prompt,
      })
      const executor = chain.bindExecutor(
        (signal): ToolContext => ({
          abortSignal: signal,
          session: { id: state.id, cwd: state.cwd, turnId: 'turn-sensitive' },
          native: { execute: nativeExecute },
          logger,
          ui: { requestInput: async () => '' },
        }),
      )

      const result = await executor.execute(
        new BashTool({ platform: 'darwin' }),
        { command: rawCommand },
        new AbortController().signal,
        'toolu_sensitive_tui',
      )

      expect(result.isError).toBe(true)
      expect(prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          display: {
            approvable: false,
            spec: '[sensitive permission details hidden - deny only]',
            toolName: 'Bash',
          },
        }),
      )
      expect(JSON.stringify(prompt.mock.calls[0]![0])).not.toContain(rawSecret)
      expect(mutation).toEqual({
        bashFrozen: true,
        displayFrozen: true,
        displayMutated: false,
        inputFrozen: true,
        requestFrozen: true,
        specFrozen: true,
        specMutated: false,
      })
      expect(nativeExecute).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['Cf token key', 'tok\u200Ben'],
    ['NFKC api-key with a Unicode hyphen', 'ａｐｉ‐ｋｅｙ'],
    ['canonical credential key', 'credential'],
    ['canonical access_key with Cf', 'access\u200B_key'],
    ['canonical private-key with NFKC and a Unicode hyphen', 'ｐｒｉｖａｔｅ‐ｋｅｙ'],
  ])('redacts values behind a normalized %s in line display and events', async (_kind, key) => {
    const events = new EventBus()
    const permissionEvents: unknown[] = []
    events.subscribe((event) => {
      if (event.type === 'tool.permission_asked') permissionEvents.push(event.payload)
    })
    const linePrompt = vi.fn(async () => 'a')
    const request: PermissionRequest = {
      attempt: 1,
      input: {},
      session: { id: 'approval-normalized-key', cwd: process.cwd() },
      spec: { custom: { [key]: 'abc' } },
      toolName: 'PluginTool',
      toolUseId: `toolu_normalized_key_${_kind}`,
    }

    await expect(
      requestPermission({
        events,
        interactionMode: 'line',
        interactivePermissionPrompt: undefined,
        linePermissionPrompt: linePrompt,
        request,
        terminalIsInteractive: () => true,
        version: 1,
      }),
    ).resolves.toEqual({ kind: 'deny' })

    expect(linePrompt).toHaveBeenCalledWith(
      expect.stringContaining('[sensitive permission details hidden - deny only]'),
    )
    expect(permissionEvents).toEqual([
      expect.objectContaining({ spec: { custom: { [key]: '[REDACTED]' } } }),
    ])
    expect(JSON.stringify(permissionEvents)).not.toContain('"abc"')
    expect(request.spec).toEqual({ custom: { [key]: 'abc' } })
  })

  it.each([
    {
      kind: 'accessor',
      fixture: () => {
        const read = vi.fn(() => ({ command: 'must not be read' }))
        return {
          assertSafe: () => expect(read).not.toHaveBeenCalled(),
          spec: Object.defineProperty({}, 'bash', {
            enumerable: true,
            get: read,
          }),
        }
      },
    },
    {
      kind: 'over-budget string',
      fixture: () => ({
        assertSafe: undefined,
        spec: { bash: { command: 'x'.repeat(65_537) } },
      }),
    },
  ] as const)(
    'fails closed for an approval $kind without leaking it to the event',
    async ({ fixture, kind }) => {
      const events = new EventBus()
      const seen: unknown[] = []
      events.subscribe((event) => {
        if (event.type === 'tool.permission_asked') seen.push(event.payload)
      })
      const prompt = vi.fn(async () => ({ kind: 'allow-once' as const }))
      const testFixture = fixture()
      const request: PermissionRequest = {
        attempt: 1,
        input: {},
        session: { id: 'approval-malformed', cwd: process.cwd() },
        spec: testFixture.spec,
        toolName: 'Bash',
        toolUseId: `toolu_${kind}`,
      }

      await expect(
        requestPermission({
          events,
          interactionMode: 'tui',
          interactivePermissionPrompt: prompt,
          request,
          version: 1,
        }),
      ).resolves.toEqual({ kind: 'deny' })

      expect(prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          display: expect.objectContaining({
            approvable: false,
            spec: '[permission details unavailable - deny only]',
          }),
        }),
      )
      expect(seen).toEqual([
        expect.objectContaining({
          spec: {
            custom: { permissionApproval: '[permission details unavailable - deny only]' },
          },
        }),
      ])
      testFixture.assertSafe?.()
    },
  )

  it('never falls back to line input for tui-without-handler or a non-TTY line mode', async () => {
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }
    for (const [id, interactionMode, terminal] of [
      ['tui-no-handler', 'tui', true],
      ['line-non-tty', 'line', false],
    ] as const) {
      const state = createSession({
        id,
        cwd: process.cwd(),
        maxTokens: 200_000,
        toolRegistrySnapshot: 'runtime-permission-test',
      })
      const linePrompt = vi.fn(async () => 'a')
      const nativeExecute = vi.fn(async () => 'must not run')
      const chain = createProductionToolPermissionChain({
        state,
        events: new EventBus(),
        permissionSnapshot: { dangerouslySkip: false, interactionMode },
        logger,
        interactivePermissionPrompt: () => undefined,
        linePermissionPrompt: linePrompt,
        terminalIsInteractive: () => terminal,
      })
      const executor = chain.bindExecutor(
        (signal): ToolContext => ({
          abortSignal: signal,
          session: { id: state.id, cwd: state.cwd, turnId: 'turn-negative' },
          native: { execute: nativeExecute },
          logger,
          ui: { requestInput: async () => '' },
        }),
      )

      const result = await executor.execute(
        new BashTool({ platform: 'darwin' }),
        { command: 'git status' },
        new AbortController().signal,
        `toolu_${id}`,
      )

      expect(result.isError).toBe(true)
      expect(linePrompt).not.toHaveBeenCalled()
      expect(nativeExecute).not.toHaveBeenCalled()
    }
  })

  it('uses the production permission chain for a real BashTool before one native invocation', async () => {
    const events = new EventBus()
    const state = createSession({
      id: 'session-1',
      cwd: process.cwd(),
      maxTokens: 200_000,
      toolRegistrySnapshot: 'runtime-permission-test',
    })
    const timeline: string[] = []
    const seen: Array<{ type: string; payload: unknown }> = []
    events.subscribe((event) => {
      if (event.type === 'tool.permission_asked') timeline.push('permission-event')
      seen.push({ type: event.type, payload: event.payload })
    })
    const prompt = vi.fn(async () => {
      timeline.push('permission-prompt')
      return { kind: 'allow-once' as const }
    })
    const nativeExecute = vi.fn(async () => {
      timeline.push('native-execute')
      return 'clean'
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
      permissionSnapshot: { dangerouslySkip: false, interactionMode: 'tui' },
      logger,
      interactivePermissionPrompt: () => prompt,
    })
    const executor = chain.bindExecutor(
      (signal): ToolContext => ({
        abortSignal: signal,
        session: { id: state.id, cwd: state.cwd, turnId: 'turn-1' },
        native: { execute: nativeExecute },
        logger,
        ui: { requestInput: async () => '' },
      }),
    )

    const result = await executor.execute(
      new BashTool({ platform: 'darwin' }),
      { command: 'git status' },
      new AbortController().signal,
      'toolu_real_bash',
    )

    expect(result.isError).not.toBe(true)
    expect(timeline).toEqual(['permission-event', 'permission-prompt', 'native-execute'])
    expect(prompt).toHaveBeenCalledOnce()
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        input: { command: 'git status' },
        spec: {
          bash: { command: 'git status' },
          fs: { read: ['.'], write: ['.'] },
        },
        toolName: 'Bash',
      }),
    )
    expect(nativeExecute).toHaveBeenCalledOnce()
    expect(seen).toEqual([
      {
        type: 'tool.permission_asked',
        payload: {
          toolUseId: 'toolu_real_bash',
          tool: 'Bash',
          spec: {
            bash: { command: 'git status' },
            fs: { read: ['.'], write: ['.'] },
          },
        },
      },
    ])
  })

  it('opens the Bash bypass only when production security configuration is explicitly enabled', async () => {
    const events = new EventBus()
    const permissionEvents: unknown[] = []
    events.subscribe((event) => {
      if (event.type === 'tool.permission_asked') permissionEvents.push(event.payload)
    })
    const state = createSession({
      id: 'session-1',
      cwd: process.cwd(),
      maxTokens: 200_000,
      toolRegistrySnapshot: 'runtime-permission-test',
    })
    const nativeExecute = vi.fn(async () => 'bypassed')
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }
    const permissionSnapshot = { dangerouslySkip: false, interactionMode: 'none' as const }
    const deniedChain = createProductionToolPermissionChain({
      state,
      events,
      permissionSnapshot,
      logger,
      interactivePermissionPrompt: () => undefined,
      terminalIsInteractive: () => false,
    })
    const deniedExecutor = deniedChain.bindExecutor(
      (signal): ToolContext => ({
        abortSignal: signal,
        session: { id: state.id, cwd: state.cwd, turnId: 'turn-1' },
        native: { execute: nativeExecute },
        logger,
        ui: { requestInput: async () => '' },
      }),
    )
    const bash = new BashTool({ platform: 'darwin' })

    const denied = await deniedExecutor.execute(
      bash,
      { command: 'pwd' },
      new AbortController().signal,
      'toolu_before_bypass',
    )
    expect(denied.isError).toBe(true)
    expect(nativeExecute).not.toHaveBeenCalled()
    expect(permissionEvents).toHaveLength(1)

    ;(permissionSnapshot as { dangerouslySkip: boolean }).dangerouslySkip = true
    const stillDenied = await deniedExecutor.execute(
      bash,
      { command: 'pwd --physical' },
      new AbortController().signal,
      'toolu_existing_executor_after_mutation',
    )
    expect(stillDenied.isError).toBe(true)
    expect(nativeExecute).not.toHaveBeenCalled()

    const allowedChain = createProductionToolPermissionChain({
      state,
      events,
      permissionSnapshot: { dangerouslySkip: true, interactionMode: 'none' },
      logger,
      interactivePermissionPrompt: () => undefined,
    })
    const allowedExecutor = allowedChain.bindExecutor(
      (signal): ToolContext => ({
        abortSignal: signal,
        session: { id: state.id, cwd: state.cwd, turnId: 'turn-2' },
        native: { execute: nativeExecute },
        logger,
        ui: { requestInput: async () => '' },
      }),
    )
    const allowed = await allowedExecutor.execute(
      bash,
      { command: 'pwd' },
      new AbortController().signal,
      'toolu_after_bypass',
    )
    expect(allowed.isError).not.toBe(true)
    expect(nativeExecute).toHaveBeenCalledOnce()
    expect(permissionEvents).toHaveLength(2)
    expect(logger.warn).toHaveBeenCalledWith('permissions bypassed', { toolName: 'Bash' })
  })
})

describe('production permission session snapshots', () => {
  it('freezes root policy, shares it with children, and fails closed for an orphan child', () => {
    const policy = new ProductionPermissionSessionPolicy()
    policy.configureInteraction({ mode: 'line' })
    const root = createSession({
      id: 'root-off',
      cwd: '/repo',
      maxTokens: 100,
      toolRegistrySnapshot: 'test',
    })
    const first = policy.snapshotFor(root)

    policy.configureSecurity({ skipPermissions: true })
    policy.configureInteraction({ mode: 'tui' })
    expect(policy.snapshotFor(root)).toBe(first)
    const child = createSession({
      id: 'child-off',
      cwd: '/repo',
      maxTokens: 100,
      toolRegistrySnapshot: 'test',
      lineage: { depth: 1, parentSessionId: root.id, parentTurnId: 'turn-1' },
    })
    expect(policy.snapshotFor(child)).toBe(first)
    expect(first).toEqual({ dangerouslySkip: false, interactionMode: 'line' })

    const nextRoot = createSession({
      id: 'root-on',
      cwd: '/repo',
      maxTokens: 100,
      toolRegistrySnapshot: 'test',
    })
    expect(policy.snapshotFor(nextRoot)).toEqual({
      dangerouslySkip: true,
      interactionMode: 'tui',
    })

    const orphan = createSession({
      id: 'orphan',
      cwd: '/repo',
      maxTokens: 100,
      toolRegistrySnapshot: 'test',
      lineage: { depth: 1, parentSessionId: 'missing-parent', parentTurnId: 'turn-x' },
    })
    expect(() => policy.snapshotFor(orphan)).toThrowError(
      expect.objectContaining({ code: 'permission_parent_snapshot_missing' }),
    )

    policy.releaseLineage(root.id)
    expect(policy.snapshotForSession(root.id)).toBeUndefined()
    expect(policy.snapshotForSession(child.id)).toBeUndefined()
    expect(policy.snapshotForSession(nextRoot.id)).toBeDefined()
  })

  it('inherits policy without sharing a parent PermissionManager session cache', async () => {
    const policy = new ProductionPermissionSessionPolicy()
    policy.configureInteraction({ mode: 'tui' })
    const root = createSession({
      id: 'cache-root',
      cwd: process.cwd(),
      maxTokens: 100,
      toolRegistrySnapshot: 'test',
    })
    const child = createSession({
      id: 'cache-child',
      cwd: process.cwd(),
      maxTokens: 100,
      toolRegistrySnapshot: 'test',
      lineage: { depth: 1, parentSessionId: root.id, parentTurnId: 'turn-1' },
    })
    const rootSnapshot = policy.snapshotFor(root)
    const childSnapshot = policy.snapshotFor(child)
    expect(childSnapshot).toBe(rootSnapshot)
    const rootPrompt = vi.fn(async () => ({ kind: 'allow-session' as const }))
    const childPrompt = vi.fn(async () => ({ kind: 'deny' as const }))
    const nativeExecute = vi.fn(async () => 'ok')
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }
    const bind = (
      state: SessionState,
      snapshot: typeof rootSnapshot,
      prompt: typeof rootPrompt | typeof childPrompt,
    ) =>
      createProductionToolPermissionChain({
        state,
        events: new EventBus(),
        permissionSnapshot: snapshot,
        logger,
        interactivePermissionPrompt: () => prompt,
      }).bindExecutor(
        (signal): ToolContext => ({
          abortSignal: signal,
          session: { id: state.id, cwd: state.cwd, turnId: 'turn-cache' },
          native: { execute: nativeExecute },
          logger,
          ui: { requestInput: async () => '' },
        }),
      )
    const rootExecutor = bind(root, rootSnapshot, rootPrompt)
    const childExecutor = bind(child, childSnapshot, childPrompt)
    const bash = new BashTool({ platform: 'darwin' })
    const execute = (executor: typeof rootExecutor, toolUseId: string) =>
      executor.execute(bash, { command: 'git status' }, new AbortController().signal, toolUseId)

    await execute(rootExecutor, 'toolu_root_first')
    await execute(rootExecutor, 'toolu_root_cached')
    const childResult = await execute(childExecutor, 'toolu_child_not_cached')

    expect(rootPrompt).toHaveBeenCalledOnce()
    expect(childPrompt).toHaveBeenCalledOnce()
    expect(childResult.isError).toBe(true)
    expect(nativeExecute).toHaveBeenCalledTimes(2)
  })
})

describe('buildStatusViewModel', () => {
  it('aggregates complete confirmed session and runtime data', () => {
    const state = updateSession(
      createSession({
        id: 'session-1',
        cwd: '/repo',
        maxTokens: 200_000,
        toolRegistrySnapshot: 'x',
      }),
      (draft) => {
        draft.createdAt = Date.parse('2026-08-09T00:00:00.000Z')
        draft.cumulativeUsage = { input: 12, output: 8, cacheRead: 2, costUSD: 0.25 }
        draft.contextBudget = { currentTokens: 20, maxTokens: 200_000 }
      },
    )

    const view = buildStatusViewModel({
      state,
      version: '1.2.3',
      workspace: '/workspace',
      project: 'apollo-code',
      model: {
        provider: 'anthropic',
        model: 'claude',
        liteModel: 'haiku',
        reasoningModel: null,
        source: 'router',
      },
      sandbox: {
        tier: 'full',
        mechanism: 'sandbox-exec',
        features: { filesystem: true, network: false },
        degradationReasons: [],
      },
      dangerousPermissions: false,
      authConfigured: true,
      authMethod: 'keychain',
      memoryMode: 'auto',
      settings: [
        {
          key: 'language',
          effectiveValue: 'zh-CN',
          source: 'user',
          readonly: false,
          locked: false,
        },
      ],
      configSources: ['default', 'user'],
      mcpServers: ['local'],
      skills: ['review'],
      plugins: ['git'],
    })

    expect(view.identity).toMatchObject({
      version: '1.2.3',
      sessionId: 'session-1',
      cwd: '/repo',
      createdAt: '2026-08-09T00:00:00.000Z',
    })
    expect(view.model).toEqual({
      status: 'available',
      provider: 'anthropic',
      model: 'claude',
      liteModel: { status: 'available', value: 'haiku' },
      reasoningModel: { status: 'disabled' },
      source: 'router',
    })
    expect(view.runtime).toMatchObject({
      filesystem: { status: 'available', value: 'isolated' },
      network: { status: 'blocked', reason: { code: 'sandbox_network_blocked' } },
      permission: { status: 'available', value: { mode: 'ask', source: 'default' } },
    })
    expect(view.auth).toEqual({
      configured: { status: 'available', value: true },
      method: { status: 'available', value: 'keychain' },
    })
    expect(view.capabilities.mcpServers).toEqual({
      status: 'available',
      value: { count: 1, names: ['local'] },
    })
    expect(view.capabilities.skills).toEqual({
      status: 'available',
      value: { count: 1, names: ['review'] },
    })
    expect(view.capabilities.plugins).toEqual({
      status: 'available',
      value: { count: 1, names: ['git'] },
    })
    expect(view.usage).toMatchObject({
      tokens: { input: 12, output: 8, cacheRead: 2 },
      context: { currentTokens: 20, maxTokens: 200_000 },
      costUSD: 0.25,
    })
  })

  it('never promotes a welcome default into a confirmed current model', () => {
    const state = createSession({
      id: 'session-model',
      cwd: '/repo',
      maxTokens: 100,
      toolRegistrySnapshot: 'x',
    })
    expect(buildStatusViewModel({ state, version: '0.0.0' }).model).toEqual({
      status: 'not_available',
      source: 'derived_unreliable',
      reason: { code: 'current_model_source_unavailable' },
    })
  })

  it('uses explicit missing states and removes secret-like settings and values', () => {
    const state = createSession({
      id: 'session-secret',
      cwd: '/repo?token=top-secret',
      maxTokens: 100,
      toolRegistrySnapshot: 'x',
    })
    const view = buildStatusViewModel({
      state,
      version: '0.0.0',
      settings: [
        {
          key: 'authorization_header',
          effectiveValue: 'Bearer top-secret',
          source: 'env',
          readonly: true,
          locked: true,
        },
        {
          key: 'endpoint',
          effectiveValue: 'https://user:password@example.test?token=top-secret',
          source: 'user',
          readonly: true,
          locked: false,
        },
      ],
    })

    const serialized = JSON.stringify(view)
    expect(view.auth.configured).toEqual({
      status: 'not_available',
      reason: { code: 'auth_configured_adapter_unavailable' },
    })
    expect(view.identity.workspace).toEqual({
      status: 'not_available',
      reason: { code: 'workspace_adapter_unavailable' },
    })
    expect(view.identity.cwd).toBe('/repo?token=[REDACTED]')
    expect(view.identity.workspace).not.toEqual({ status: 'available', value: view.identity.cwd })
    expect(view.config.sources).toMatchObject({ status: 'not_available' })
    expect(view.runtime.memory).toMatchObject({ status: 'not_available' })
    expect(view.capabilities.skills).toMatchObject({ status: 'not_available' })
    expect(view.capabilities.plugins).toMatchObject({ status: 'not_available' })
    expect(view.settings.map((setting) => setting.key)).toEqual(['endpoint'])
    expect(serialized).not.toContain('top-secret')
    expect(serialized).not.toContain('password')
    expect(serialized).not.toContain('authorization_header')
  })

  it('does not call credential-returning APIs while building a production status snapshot', async () => {
    const getCredential = vi.fn(async () => 'must-not-be-read')
    const credentialApi = { getCredential }
    const adapter = createStatusSnapshotAdapter({
      ...credentialApi,
      version: '0.0.0',
      dangerousPermissions: () => false,
      sandbox: async () => undefined,
      configAvailable: async () => false,
    })
    const state = createSession({
      id: 'session-auth',
      cwd: '/repo',
      maxTokens: 100,
      toolRegistrySnapshot: 'x',
    })

    const view = await adapter(state)

    expect(getCredential).not.toHaveBeenCalled()
    expect(view.auth).toEqual({
      configured: {
        status: 'not_available',
        reason: { code: 'auth_configured_adapter_unavailable' },
      },
      method: { status: 'not_available', reason: { code: 'auth_method_adapter_unavailable' } },
    })
  })
})

describe('FileInputHistoryStore', () => {
  it('persists only safe bounded inputs and trims old entries', async () => {
    const root = await mkdtemp(join(process.cwd(), '.history-'))
    fixtures.push(root)
    const path = join(root, 'history', 'input.jsonl')
    const history = new FileInputHistoryStore(path, 1024, 3, 20)

    await history.append('')
    await history.append('hello')
    await history.append('token=secret-value')
    await history.append('x'.repeat(21))
    await history.append('one')
    await history.append('two')
    await history.append('three')

    expect(await history.list()).toEqual(['one', 'two', 'three'])
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain('secret-value')
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
  })
})

describe('status configuration adapter', () => {
  it('injects pinned project memory through the production composition helper', async () => {
    const root = await mkdtemp(join(process.cwd(), '.memory-prompt-composition-'))
    fixtures.push(root)
    const cwd = join(root, 'workspace')
    await mkdir(cwd)
    const memory = new DefaultMemoryService(
      new LocalMemoryRepository(join(root, 'memory', 'records.json')),
    )
    const composer = new DefaultPromptComposer()
    registerRuntimeMemoryPrompts(composer, memory, { cwd, id: 'session-1' })
    await memory.create({
      id: 'composition-pinned',
      scope: projectMemoryScope(cwd),
      content: 'Always run the focused tests first.',
      provenance: { source: 'user' },
      pinned: true,
    })
    const context = { cwd, model: 'test-model', provider: 'test-provider' }
    expect(await composer.compose(context)).toContain('Always run the focused tests first.')
    await memory.unpin(projectMemoryScope(cwd), 'composition-pinned')
    expect(await composer.compose(context)).not.toContain('Always run the focused tests first.')
  })

  it('backfills tri-state native availability after parallel probing (r13-P1)', async () => {
    const root = await mkdtemp(join(process.cwd(), '.native-probe-composition-'))
    fixtures.push(root)
    const previousVersion = process.env.APOLLO_VERSION
    // Keep resolution local-only so the test never touches the network.
    process.env.APOLLO_VERSION = '0.0.0'
    try {
      const ports = createProductionPorts({
        apolloHome: root,
        identity: { version: '1.2.3-test' },
      })
      // Reading availability fires the probes lazily and starts in the probing
      // tri-state; the REPL is up long before the probes settle.
      expect(ports.native.available?.()).toEqual({
        sandbox: 'probing',
        search: 'probing',
        fs: 'probing',
      })
      await vi.waitFor(() => {
        const availability = ports.native.available?.()
        expect(availability?.sandbox).not.toBe('probing')
        expect(availability?.search).not.toBe('probing')
        expect(availability?.fs).not.toBe('probing')
      })
      const settled = ports.native.available?.()
      for (const value of [settled?.sandbox, settled?.search, settled?.fs])
        expect(typeof value).toBe('boolean')
      // startProbes is the composition-root parallel trigger and stays idempotent.
      ports.native.startProbes?.()
    } finally {
      if (previousVersion === undefined) delete process.env.APOLLO_VERSION
      else process.env.APOLLO_VERSION = previousVersion
    }
  })

  it('exposes one production memory service and reloads its durable state', async () => {
    const root = await mkdtemp(join(process.cwd(), '.memory-composition-'))
    fixtures.push(root)
    const first = createProductionPorts({
      apolloHome: root,
      identity: { version: '1.2.3-test' },
    })
    const memory = first.memory
    expect(memory).toBe(first.memory)
    await memory?.create({
      id: 'composition-root',
      scope: { kind: 'project', workspaceId: 'local', projectId: 'apollo' },
      content: 'production reachable',
      provenance: { source: 'agent' },
    })
    await memory?.flush()

    const restarted = createProductionPorts({
      apolloHome: root,
      identity: { version: '1.2.3-test' },
    })
    expect(
      await restarted.memory?.get(
        { kind: 'project', workspaceId: 'local', projectId: 'apollo' },
        'composition-root',
      ),
    ).toMatchObject({ content: 'production reachable' })
  })

  it('round trips a local memory archive through production ports without widening scope', async () => {
    const root = await mkdtemp(join(process.cwd(), '.memory-transfer-composition-'))
    fixtures.push(root)
    const scope = { kind: 'project', workspaceId: 'local', projectId: 'apollo' } as const
    const source = createProductionPorts({
      apolloHome: join(root, 'source'),
      identity: { version: '1.2.3-test' },
    })
    await source.memory?.create({
      id: 'portable',
      scope,
      content: 'production transfer',
      provenance: { source: 'user', actorId: 'owner' },
    })
    const archive = source.memoryTransfer?.serialize(await source.memoryTransfer.export([scope]))
    const target = createProductionPorts({
      apolloHome: join(root, 'target'),
      identity: { version: '1.2.3-test' },
    })
    await expect(target.memoryTransfer?.import(archive!, scope)).resolves.toMatchObject({
      applied: 1,
      conflicts: [],
    })
    expect(await target.memory?.get(scope, 'portable')).toMatchObject({
      scope,
      content: 'production transfer',
      provenance: { source: 'import', importedFrom: { source: 'user', actorId: 'owner' } },
    })
    expect(await target.memory?.get({ kind: 'workspace', workspaceId: 'local' }, 'portable')).toBe(
      undefined,
    )
  })

  it('keeps plugin and model secret rejections out of every production memory artifact', async () => {
    const root = await mkdtemp(join(process.cwd(), '.memory-secret-composition-'))
    fixtures.push(root)
    const ports = createProductionPorts({
      apolloHome: root,
      identity: { version: '1.2.3-test' },
    })
    const memory = ports.memory!
    const scope = projectMemoryScope(root)
    const context = {
      abortSignal: new AbortController().signal,
      session: { id: 'session-1', cwd: root, turnId: 'turn-1' },
      native: { execute: async () => undefined },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      ui: { requestInput: async () => '' },
    }
    const tools = new Map(createMemoryTools(memory).map((tool) => [tool.name, tool]))
    await tools
      .get('Memory.create')!
      .invoke({ scope: 'project', id: 'original', content: 'safe original' }, context as never)
    const original = await memory.get(scope, 'original')
    const modelSecret = `sk-proj-${'FAKE'.repeat(6)}`
    await expect(
      tools
        .get('Memory.update')!
        .invoke({ scope: 'project', id: 'original', content: modelSecret }, context as never),
    ).rejects.toMatchObject({ code: 'memory_validation' })

    const pluginSecret = `ghp_${'FAKE'.repeat(8)}`
    const pluginMemory = createPluginMemoryHost({
      home: root,
      cwd: root,
      memory,
      memoryRecall: ports.memoryRecall!,
      memoryTransfer: ports.memoryTransfer!,
    })
    await expect(
      pluginMemory('fixture-plugin', 'create', {
        scope: 'project',
        id: 'plugin-secret',
        content: pluginSecret,
      }),
    ).rejects.toMatchObject({ code: 'memory_validation' })
    await memory.flush()

    expect(await memory.get(scope, 'original')).toEqual(original)
    expect(await memory.get(scope, 'plugin-secret')).toBeUndefined()
    for (const path of [
      join(root, 'memory', 'records.json'),
      join(root, 'memory', 'index.json'),
      join(root, 'memory', 'audit.jsonl'),
      join(root, 'telemetry', 'events.jsonl'),
    ]) {
      const contents = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return ''
        throw error
      })
      expect(contents).not.toContain(modelSecret)
      expect(contents).not.toContain(pluginSecret)
    }
  })

  it('persists whitelisted preferences atomically and rejects readonly state', async () => {
    const root = await mkdtemp(join(process.cwd(), '.status-'))
    fixtures.push(root)
    const ports = createProductionPorts({
      apolloHome: root,
      identity: { version: '1.2.3-test' },
    })
    const input = { cwd: process.cwd(), sessionId: 'session-test' }
    const updated = await ports.config.updatePreference?.('notifications', true, input)
    expect(updated?.config.find((item) => item.id === 'notifications')?.value).toBe(true)
    expect(await readFile(join(root, 'config.toml'), 'utf8')).toContain('notifications = true')
    await expect(ports.config.updatePreference?.('authMethod', 'env', input)).rejects.toThrow(
      'read-only',
    )
    expect(JSON.stringify(updated)).not.toContain('sk-secret-value')
  })

  it('health fails on known-key type errors and warns on unknown keys (r13-I4 §8.3)', async () => {
    const root = await mkdtemp(join(process.cwd(), '.status-health-'))
    fixtures.push(root)
    const ports = createProductionPorts({
      apolloHome: root,
      identity: { version: '1.2.3-test' },
    })
    const configPath = join(root, 'config.toml')

    // 已知 key 类型错 → fail：报错含 文件 + key + 期望类型（附录 C.1）
    await writeFile(configPath, '[context]\nmax_tokens = "180000"\n', 'utf8')
    const invalid = await ports.config.health(process.cwd())
    expect(invalid.valid).toBe(false)
    expect(invalid.detail).toContain(configPath)
    expect(invalid.detail).toContain("key 'context.max_tokens'")
    expect(invalid.detail).toContain('expected number')

    // 未知 key → warn + 忽略：valid 保持 true，detail 携带 key 全名 + 文件
    await writeFile(
      configPath,
      '[contex]\npolicy = "sliding"\n\n[ui]\ntheme = "dark"\ncolour = false\n',
      'utf8',
    )
    const warned = await ports.config.health(process.cwd())
    expect(warned.valid).toBe(true)
    expect(warned.detail).toContain(`unknown config key 'contex' in ${configPath}`)
    expect(warned.detail).toContain(`unknown config key 'ui.colour' in ${configPath}`)

    await rm(configPath, { force: true })
    const clean = await ports.config.health(process.cwd())
    expect(clean).toEqual({ valid: true, detail: 'valid' })
  })
})

describe('production memory plugin policy composition', () => {
  it('applies one veto policy to CLI, TUI, model, import, and Plugin writes', async () => {
    const root = await mkdtemp(join(process.cwd(), '.memory-policy-composition-'))
    fixtures.push(root)
    const source = join(root, 'plugin-source')
    await mkdir(source)
    await writeFile(
      join(source, 'manifest.json'),
      JSON.stringify({
        name: 'apollo-plugin-memory-policy-test',
        version: '1.2.3',
        type: 'module',
        main: 'index.js',
        engines: { apollo: '^1.2.3' },
        permissions: {
          apollo: ['hooks.on', 'memory.write'],
          memory: { read: ['workspace', 'project', 'session'], write: true },
        },
      }),
    )
    await writeFile(join(source, 'index.js'), 'export async function activate() {}\n')
    const hookEvents: Array<{ event: string; payload: any }> = []
    const host = memoryPolicyPluginHost(hookEvents)
    const home = join(root, 'home')
    const ports = createProductionPorts({
      apolloHome: home,
      identity: { version: '1.2.3' },
      pluginApproval: async () => true,
      pluginHostStart: host.start,
    })
    await ports.plugin!.install(source)
    expect(host.clients).toHaveLength(1)
    const project = projectMemoryScope(root)

    const cli = await runCli(
      [
        'memory',
        'add',
        '--scope',
        'project',
        '--id',
        'blocked-cli',
        '--content',
        'blocked',
        '--cwd',
        root,
        '--json',
      ],
      ports,
      { readStdin: async () => '', isInteractiveTerminal: () => false },
    )
    expect(cli.exitCode).toBe(2)
    expect(JSON.parse(cli.stdout).error.code).toBe('memory_hook_veto')
    expect(JSON.parse(cli.stdout).error.message).toBe('fixture policy veto')
    expect(await ports.memory!.get(project, 'blocked-cli')).toBeUndefined()

    const target = await ports.memory!.create({
      id: 'tui-target',
      scope: project,
      content: 'safe',
      provenance: { source: 'user' },
    })
    const panel = createMemoryPanelController(ports.memory!, ports.memoryRecall, project)
    await expect(
      panel.update('tui-target', { content: 'blocked', tags: [] }, target.updatedAt),
    ).rejects.toBeInstanceOf(MemoryError)
    expect(await ports.memory!.get(project, 'tui-target')).toMatchObject({ content: 'safe' })

    const tools = new Map(createMemoryTools(ports.memory!).map((tool) => [tool.name, tool]))
    const toolContext = {
      abortSignal: new AbortController().signal,
      session: { id: 'model-session', cwd: root, turnId: 'turn-1' },
      native: { execute: async () => undefined },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      ui: { requestInput: async () => '' },
    } as ToolContext
    await expect(
      tools
        .get('Memory.create')!
        .invoke({ scope: 'session', id: 'blocked-model', content: 'blocked' }, toolContext),
    ).rejects.toMatchObject({ code: 'memory_hook_veto' })

    const archive = JSON.stringify({
      schemaVersion: 'apollo.memory.export.v1',
      exportedAt: '2026-08-13T00:00:00.000Z',
      records: [
        {
          schemaVersion: 1,
          id: 'blocked-import',
          scope: project,
          content: 'blocked',
          provenance: { source: 'user' },
          attachments: [],
          tags: [],
          pinned: false,
          createdAt: '2026-08-13T00:00:00.000Z',
          updatedAt: '2026-08-13T00:00:00.000Z',
          deletedAt: null,
        },
      ],
    })
    const factsBeforeImport = await readFile(join(home, 'memory', 'records.json'), 'utf8')
    const indexBeforeImport = await readFile(join(home, 'memory', 'index.json'), 'utf8')
    await expect(ports.memoryTransfer!.import(archive, project)).rejects.toMatchObject({
      code: 'memory_hook_veto',
    })
    expect(await readFile(join(home, 'memory', 'records.json'), 'utf8')).toBe(factsBeforeImport)
    expect(await readFile(join(home, 'memory', 'index.json'), 'utf8')).toBe(indexBeforeImport)
    await expect(stat(join(home, 'memory', 'import-journal.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })

    const interactive = await ports.session.startInteractive!({ cwd: root })
    expect(host.clients).toHaveLength(2)
    const sessionPlugin = host.clients[1]!
    await expect(
      sessionPlugin.request('apollo.memory.create', {
        scope: 'project',
        id: 'blocked-plugin',
        content: 'blocked',
      }),
    ).rejects.toThrow('memory_hook_veto')
    await expect(
      sessionPlugin.request('apollo.memory.get', ['project', 'tui-target']),
    ).rejects.toThrow('plugin_rpc_method_denied')
    await expect(
      sessionPlugin.request('apollo.memory.search', ['project', 'safe']),
    ).rejects.toThrow('plugin_rpc_method_denied')

    const beforeSecret = hookEvents.length
    await expect(
      ports.memory!.create({
        id: 'secret-candidate',
        scope: project,
        content: 'api_key=FAKE-policy-secret-value',
        provenance: { source: 'user' },
      }),
    ).rejects.toMatchObject({ code: 'memory_validation' })
    expect(hookEvents).toHaveLength(beforeSecret)

    await expect(
      ports.memory!.create({
        id: 'recursive-policy',
        scope: project,
        content: 'safe parent write',
        provenance: { source: 'user' },
      }),
    ).rejects.toMatchObject({ code: 'memory_hook_failed' })
    expect(await ports.memory!.get(project, 'recursive-policy')).toBeUndefined()
    expect(await ports.memory!.get(project, 'recursive-child')).toBeUndefined()

    await ports.memory!.create({
      id: 'allowed-lifecycle',
      scope: project,
      content: 'safe lifecycle',
      provenance: { source: 'user' },
    })
    await ports.memory!.delete(project, 'allowed-lifecycle')
    const lifecycle = hookEvents.filter(({ payload }) => payload?.id === 'allowed-lifecycle')
    expect(lifecycle.map(({ event }) => event)).toEqual([
      'memory-pre-write',
      'memory-post-write',
      'memory-pre-write',
      'memory-post-write',
      'memory-deleted',
    ])
    expect(lifecycle[0]?.payload).toMatchObject({ content: 'safe lifecycle', scope: 'project' })
    expect(lifecycle[1]?.payload).not.toHaveProperty('content')
    expect(lifecycle.at(-1)?.payload).not.toHaveProperty('content')

    const auditPath = join(home, 'memory', 'hook-audit.jsonl')
    const audit = await readFile(auditPath, 'utf8')
    expect(audit).toContain('memory.preWrite')
    expect(audit).toContain('"result":"veto"')
    expect(audit).not.toContain('FAKE-policy-secret-value')
    if (process.platform !== 'win32') expect((await stat(auditPath)).mode & 0o777).toBe(0o600)

    await ports.plugin!.setEnabled('apollo-plugin-memory-policy-test', false)
    await expect(
      ports.memory!.create({
        id: 'blocked-disabled-plugin',
        scope: project,
        content: 'blocked',
        provenance: { source: 'user' },
      }),
    ).resolves.toMatchObject({ id: 'blocked-disabled-plugin' })
    await interactive.end()
  })
})

describe.skipIf(process.env.APOLLO_RUN_PLUGIN_E2E !== '1')(
  'production plugin composition root (requires a supported native sandbox binary)',
  () => {
    it('routes real host tool and command registrations into production registries', async () => {
      const root = await mkdtemp(join(process.cwd(), '.plugin-composition-'))
      fixtures.push(root)
      const source = join(root, 'source')
      await mkdir(source)
      await writeFile(
        join(source, 'manifest.json'),
        JSON.stringify({
          name: 'apollo-plugin-composition-test',
          version: '1.2.3',
          type: 'module',
          main: 'index.js',
          engines: { apollo: '^1.2.3' },
          permissions: { apollo: ['tools.register', 'commands.register'] },
        }),
      )
      await writeFile(
        join(source, 'index.js'),
        `export async function activate(apollo) {
          await apollo.tools.register({ name: 'plugin:apollo-plugin-composition-test:composition.tool', description: 'test', inputSchema: {}, async handler() { return 'ok' } })
          await apollo.commands.register({ name: 'composition-command', async handler() {} })
        }`,
      )
      const contributions: Array<{ kind: 'tool' | 'command'; name: string; plugin: string }> = []
      const ports = createProductionPorts({
        apolloHome: join(root, 'home'),
        identity: { version: '1.2.3' },
        pluginApproval: async () => true,
        onPluginContribution: (value) => contributions.push(value),
      })
      await ports.plugin?.install(source)
      const session = await ports.session.startInteractive!({ cwd: root })
      expect(contributions).toEqual([
        {
          kind: 'tool',
          name: 'plugin:apollo-plugin-composition-test:composition.tool',
          plugin: 'apollo-plugin-composition-test',
        },
        {
          kind: 'command',
          name: 'composition-command',
          plugin: 'apollo-plugin-composition-test',
        },
      ])
      await session.end()
    })
  },
)
