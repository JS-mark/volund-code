import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'

import type { PluginManifest } from '@apollo-code/plugin-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BridgeRuntime,
  BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES,
  HOOK_HANDLER_TIMEOUT_MS,
  type BridgeHost,
  type HookPipelineSignal,
} from './index'

const manifest: PluginManifest = {
  name: 'apollo-plugin-git-helper',
  version: '1.0.0',
  engines: { apollo: '0.1.0' },
  main: 'index.js',
  type: 'module',
  permissions: { apollo: ['hooks.on'] },
}

function stubHost(log: (level: string, message: string) => void = () => {}): BridgeHost {
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
    log,
  }
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value)
  if (typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value !== 'object') throw new TypeError('test canonical JSON only accepts objects')
  return `{${Object.keys(value)
    .toSorted()
    .map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) throw new TypeError('test data must be plain')
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value)}`
    })
    .join(',')}}`
}
const jsonBytes = (value: unknown) => Buffer.from(canonicalJson(value), 'utf8')
const jsonDigest = (value: unknown) =>
  `sha256:${createHash('sha256').update(jsonBytes(value)).digest('hex')}`
const taggedBytesPayload = (bytes: Buffer) =>
  Buffer.from(`{"bytes":{"$apollo.bytes.v1":"${bytes.toString('base64')}"}}`, 'utf8')
const sha256Digest = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const payloadAtSerializedBytes = (bytes: number, suffix = '') => {
  const emptyBytes = jsonBytes({ data: '' }).byteLength
  if (bytes < emptyBytes + Buffer.byteLength(suffix)) throw new Error('payload target too small')
  return { data: `${'x'.repeat(bytes - emptyBytes - Buffer.byteLength(suffix))}${suffix}` }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('domain-aware hook dispatch (r13-I10, REM-52)', () => {
  it('fail-closes when a builtin hook exceeds the handler timeout', async () => {
    vi.useFakeTimers()
    const runtime = new BridgeRuntime(stubHost())
    runtime.registerHostHook('builtin', 'preToolUse', () => new Promise(() => {}))
    const signals: HookPipelineSignal[] = []
    const pending = runtime.runDomainHooks(
      'preToolUse',
      { tool: 'Bash', input: { command: 'ls' } },
      { report: (signal) => signals.push(signal) },
    )
    await vi.advanceTimersByTimeAsync(HOOK_HANDLER_TIMEOUT_MS)
    const outcome = await pending
    expect(outcome?.veto).toBe(true)
    expect(outcome?.reason).toContain('builtin')
    expect(outcome?.reason).toContain('fail-closed')
    expect(signals.map((signal) => signal.code)).toEqual(['builtin_hook_timeout'])
    expect(signals[0]).toMatchObject({
      kind: 'builtin_hook_timeout',
      domain: 'builtin',
      hook: 'apollo.builtin',
      event: 'preToolUse',
      timeoutMs: HOOK_HANDLER_TIMEOUT_MS,
    })
  })

  it('skips a timed-out plugin hook, warns, and continues the pipeline (fail-open)', async () => {
    vi.useFakeTimers()
    const warnings: string[] = []
    const runtime = new BridgeRuntime(
      stubHost((level, message) => {
        if (level === 'warn') warnings.push(message)
      }),
    )
    const seen: string[] = []
    const bridge = runtime.create(manifest, process.cwd(), 'tool-1')
    bridge.hooks.on('preToolUse', () => new Promise(() => {}), { priority: 5 })
    runtime.registerHostHook('builtin', 'preToolUse', () => {
      seen.push('builtin')
    })
    const signals: HookPipelineSignal[] = []
    const pending = runtime.runDomainHooks(
      'preToolUse',
      { tool: 'Bash', input: { command: 'ls' } },
      { report: (signal) => signals.push(signal) },
    )
    await vi.advanceTimersByTimeAsync(HOOK_HANDLER_TIMEOUT_MS + 1_000)
    const outcome = await pending
    expect(outcome?.veto).toBeUndefined()
    expect(seen).toEqual(['builtin'])
    expect(signals.map((signal) => signal.code)).toEqual(['hook_skipped'])
    expect(signals[0]).toMatchObject({
      kind: 'hook_skipped',
      domain: 'plugin',
      hook: manifest.name,
      cause: 'timeout',
    })
  })

  it('fail-closes when a builtin hook throws', async () => {
    const runtime = new BridgeRuntime(stubHost())
    runtime.registerHostHook('builtin', 'postToolUse', () => {
      throw new Error('scanner crashed')
    })
    const signals: HookPipelineSignal[] = []
    const outcome = await runtime.runDomainHooks(
      'postToolUse',
      { tool: 'Read' },
      { report: (signal) => signals.push(signal) },
    )
    expect(outcome?.veto).toBe(true)
    expect(outcome?.reason).toContain('fail-closed')
    expect(signals).toEqual([
      expect.objectContaining({
        kind: 'builtin_hook_error',
        code: 'builtin_hook_error',
        hook: 'apollo.builtin',
        message: 'scanner crashed',
      }),
    ])
  })

  it('skips a throwing plugin hook and lets later handlers decide', async () => {
    const runtime = new BridgeRuntime(stubHost())
    const bridge = runtime.create(manifest, process.cwd(), 'tool-1')
    bridge.hooks.on(
      'preToolUse',
      () => {
        throw new Error('boom')
      },
      { priority: 5 },
    )
    bridge.hooks.on('preToolUse', () => ({ veto: true, reason: 'later hook wins' }), {
      priority: 1,
    })
    const signals: HookPipelineSignal[] = []
    const outcome = await runtime.runDomainHooks(
      'preToolUse',
      { tool: 'Bash' },
      { report: (signal) => signals.push(signal) },
    )
    expect(outcome).toEqual({ veto: true, reason: 'later hook wins' })
    expect(signals).toEqual([
      expect.objectContaining({ kind: 'hook_skipped', domain: 'plugin', cause: 'error' }),
    ])
  })

  it('runs the builtin domain before plugin hooks regardless of registration order', async () => {
    const runtime = new BridgeRuntime(stubHost())
    const calls: string[] = []
    const bridge = runtime.create(manifest, process.cwd(), 'tool-1')
    bridge.hooks.on('preToolUse', () => {
      calls.push('plugin')
    })
    runtime.registerHostHook('builtin', 'preToolUse', () => {
      calls.push('builtin')
      return { veto: true, reason: 'blocked by apollo.secret-scan' }
    })
    const outcome = await runtime.runDomainHooks('preToolUse', { tool: 'Bash' })
    expect(outcome).toEqual({ veto: true, reason: 'blocked by apollo.secret-scan' })
    expect(calls).toEqual(['builtin'])
  })

  it('keeps builtin, project, plugin, user domain order and stable equal-priority order', async () => {
    const runtime = new BridgeRuntime(stubHost())
    const calls: string[] = []
    runtime.registerHostHook('user', 'preToolUse', () => {
      calls.push('user')
    })
    const bridge = runtime.create(manifest, process.cwd(), 'tool-1')
    bridge.hooks.on('preToolUse', () => {
      calls.push('plugin-first')
    })
    bridge.hooks.on('preToolUse', () => {
      calls.push('plugin-second')
    })
    runtime.registerHostHook('project', 'preToolUse', () => {
      calls.push('project')
    })
    runtime.registerHostHook('builtin', 'preToolUse', () => {
      calls.push('builtin')
    })
    await runtime.runDomainHooks('preToolUse', { small: true })
    expect(calls).toEqual(['builtin', 'project', 'plugin-first', 'plugin-second', 'user'])
  })

  it('feeds each handler the previous handler output (serial pipeline, 06b §6.11.1)', async () => {
    const runtime = new BridgeRuntime(stubHost())
    const bridge = runtime.create(manifest, process.cwd(), 'tool-1')
    const seen: unknown[] = []
    bridge.hooks.on(
      'preToolUse',
      (payload) => {
        const current = payload as { tool: string; input: unknown }
        return { value: { ...current, input: { command: 'echo one' } } }
      },
      { priority: 10 },
    )
    bridge.hooks.on(
      'preToolUse',
      (payload) => {
        seen.push(payload)
        const current = payload as { tool: string; input: unknown }
        return { value: { ...current, input: { command: 'echo two' } } }
      },
      { priority: 5 },
    )
    const outcome = await runtime.runDomainHooks('preToolUse', {
      tool: 'Bash',
      input: { command: 'rm -rf /' },
    })
    expect(seen).toEqual([{ tool: 'Bash', input: { command: 'echo one' } }])
    expect(outcome).toEqual({ value: { tool: 'Bash', input: { command: 'echo two' } } })
  })

  it('enforces per-domain priority bands for host hooks', () => {
    const runtime = new BridgeRuntime(stubHost())
    expect(() =>
      runtime.registerHostHook('builtin', 'preToolUse', () => {}, { priority: 899 }),
    ).toThrow('plugin_hook_priority_invalid')
    expect(() =>
      runtime.registerHostHook('builtin', 'preToolUse', () => {}, { priority: 1001 }),
    ).toThrow('plugin_hook_priority_invalid')
    expect(() =>
      runtime.registerHostHook('project', 'preToolUse', () => {}, { priority: 900 }),
    ).toThrow('plugin_hook_priority_invalid')
    expect(() => runtime.registerHostHook('user', 'preToolUse', () => {}, { priority: 0 })).toThrow(
      'plugin_hook_priority_invalid',
    )
    runtime.registerHostHook('builtin', 'preToolUse', () => {}, { priority: 1000 })
    runtime.registerHostHook('project', 'preToolUse', () => {}, { priority: 500 })
    runtime.registerHostHook('user', 'preToolUse', () => {}, { priority: -1000 })
    runtime.registerHostHook('builtin', 'preToolUse', () => {})
  })

  it('vetoes an oversized builtin payload before a dangerous tail can bypass the scanner', async () => {
    const runtime = new BridgeRuntime(stubHost())
    const handler = vi.fn()
    runtime.registerHostHook('builtin', 'preToolUse', handler, { name: 'apollo.secret-scan' })
    const signals: HookPipelineSignal[] = []
    const dangerousTail = ' api_key=top-secret; rm -rf /'
    const payload = {
      tool: 'Bash',
      input: { command: `${'x'.repeat(BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES)}${dangerousTail}` },
    }
    const outcome = await runtime.runDomainHooks('preToolUse', payload, {
      report: (signal) => signals.push(signal),
    })
    expect(outcome?.veto).toBe(true)
    expect(outcome?.reason).toContain('payload')
    expect(outcome?.reason).toContain('fail-closed')
    expect(handler).not.toHaveBeenCalled()
    expect(signals).toEqual([
      {
        kind: 'builtin_hook_payload_too_large',
        code: 'builtin_hook_payload_too_large',
        domain: 'builtin',
        hook: 'apollo.secret-scan',
        event: 'preToolUse',
        limitBytes: BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES,
        rawBytes: jsonBytes(payload).byteLength,
        rawDigest: jsonDigest(payload),
        scanStatus: 'not_started',
        scannedBytes: 0,
        scannedDigest: null,
        decision: 'veto',
      },
    ])
  })

  it('dispatches the complete payload at the exact byte limit and vetoes limit + 1', async () => {
    const atLimit = payloadAtSerializedBytes(BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES)
    const overLimit = payloadAtSerializedBytes(BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES + 1)
    const runtime = new BridgeRuntime(stubHost())
    const handler = vi.fn()
    const signals: HookPipelineSignal[] = []
    runtime.registerHostHook('builtin', 'preToolUse', handler)

    const allowed = await runtime.runDomainHooks('preToolUse', atLimit, {
      report: (signal) => signals.push(signal),
    })
    expect(allowed).toEqual({ value: atLimit })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenLastCalledWith(atLimit)
    expect(signals).toEqual([])

    const blocked = await runtime.runDomainHooks('preToolUse', overLimit, {
      report: (signal) => signals.push(signal),
    })
    expect(blocked?.veto).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(signals).toEqual([
      expect.objectContaining({
        kind: 'builtin_hook_payload_too_large',
        rawBytes: BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES + 1,
        rawDigest: jsonDigest(overLimit),
        scanStatus: 'not_started',
        scannedBytes: 0,
        scannedDigest: null,
      }),
    ])
  })

  it('measures UTF-8 bytes without splitting a multibyte boundary', async () => {
    const targetBytes = BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES + 1
    const emptyBytes = jsonBytes({ data: '' }).byteLength
    const boundaryPrefix = 'x'.repeat(8_191)
    const emoji = '😀'
    const remaining =
      targetBytes - emptyBytes - Buffer.byteLength(boundaryPrefix) - Buffer.byteLength(emoji)
    const payload = { data: `${boundaryPrefix}${emoji}${'x'.repeat(remaining)}` }
    const runtime = new BridgeRuntime(stubHost())
    const handler = vi.fn()
    const signals: HookPipelineSignal[] = []
    runtime.registerHostHook('builtin', 'preToolUse', handler)
    const outcome = await runtime.runDomainHooks('preToolUse', payload, {
      report: (signal) => signals.push(signal),
    })
    expect(jsonBytes(payload).byteLength).toBe(targetBytes)
    expect(outcome?.veto).toBe(true)
    expect(handler).not.toHaveBeenCalled()
    expect(signals[0]).toMatchObject({
      rawBytes: targetBytes,
      rawDigest: jsonDigest(payload),
      scannedBytes: 0,
      scannedDigest: null,
    })
  })

  it('keeps a valid surrogate pair intact after a lone high surrogate at a chunk boundary', async () => {
    const boundaryValue = `${'x'.repeat(8_191)}\ud800\udbff\udc00${'x'.repeat(BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES)}`
    const payload = { data: boundaryValue }
    const runtime = new BridgeRuntime(stubHost())
    const handler = vi.fn()
    const signals: HookPipelineSignal[] = []
    runtime.registerHostHook('builtin', 'preToolUse', handler)

    const outcome = await runtime.runDomainHooks('preToolUse', payload, {
      report: (signal) => signals.push(signal),
    })

    expect(outcome?.veto).toBe(true)
    expect(handler).not.toHaveBeenCalled()
    expect(signals).toEqual([
      expect.objectContaining({
        kind: 'builtin_hook_payload_too_large',
        rawBytes: jsonBytes(payload).byteLength,
        rawDigest: jsonDigest(payload),
      }),
    ])
  })

  it('handles deeply nested and many-field JSON payloads without truncation semantics', async () => {
    let deep: Record<string, unknown> = {
      content: 'x'.repeat(BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES),
    }
    for (let index = 0; index < 256; index++) deep = { nested: deep }
    const manyFields = Object.fromEntries(
      Array.from({ length: 100_000 }, (_, index) => [`field_${index}`, 'x']),
    )
    const runtime = new BridgeRuntime(stubHost())
    const handler = vi.fn()
    runtime.registerHostHook('builtin', 'preToolUse', handler)

    for (const payload of [deep, manyFields]) {
      const signals: HookPipelineSignal[] = []
      const outcome = await runtime.runDomainHooks('preToolUse', payload, {
        report: (signal) => signals.push(signal),
      })
      expect(jsonBytes(payload).byteLength).toBeGreaterThan(BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES)
      expect(outcome?.veto).toBe(true)
      expect(signals).toEqual([
        expect.objectContaining({
          kind: 'builtin_hook_payload_too_large',
          rawBytes: jsonBytes(payload).byteLength,
          rawDigest: jsonDigest(payload),
          scanStatus: 'not_started',
        }),
      ])
    }
    expect(handler).not.toHaveBeenCalled()
  })

  it.each([
    [
      'cyclic object',
      () => {
        const value: { self?: unknown } = {}
        value.self = value
        return value
      },
    ],
    ['BigInt', () => ({ value: 1n })],
    ['Map', () => ({ value: new Map([['hidden', 'x'.repeat(2_000_000)]]) })],
    [
      'prototype-spoofed Map',
      () => {
        const value = new Map([['hidden', 'x'.repeat(2_000_000)]])
        Object.setPrototypeOf(value, Object.prototype)
        return { value }
      },
    ],
    ['Set', () => ({ value: new Set(['x'.repeat(2_000_000)]) })],
    ['ArrayBuffer', () => ({ value: new ArrayBuffer(2_000_000) })],
    ['own toJSON', () => ({ hidden: 'x'.repeat(2_000_000), toJSON: () => ({ ok: true }) })],
    ['accessor', () => Object.defineProperty({}, 'secret', { enumerable: true, get: () => 'x' })],
    ['array accessor', () => Object.defineProperty([0], '0', { enumerable: true, get: () => 1 })],
    ['negative zero', () => ({ value: -0 })],
    ['SharedArrayBuffer view', () => ({ value: new Uint8Array(new SharedArrayBuffer(8)) })],
    [
      'cross-realm SharedArrayBuffer view',
      () => ({
        value: new Uint8Array(runInNewContext('new SharedArrayBuffer(8)') as SharedArrayBuffer),
      }),
    ],
    [
      'SharedArrayBuffer spoofing subclass',
      () => {
        class SpoofedBytes extends Uint8Array {
          override get buffer(): ArrayBuffer {
            return new ArrayBuffer(0)
          }
        }
        return {
          value: new SpoofedBytes(new SharedArrayBuffer(8) as unknown as ArrayBuffer),
        }
      },
    ],
    [
      'SharedArrayBuffer own-shadowed view',
      () => {
        const value = new Uint8Array(new SharedArrayBuffer(8))
        Object.defineProperties(value, {
          buffer: { value: new ArrayBuffer(0) },
          byteOffset: { value: 0 },
          byteLength: { value: 0 },
        })
        return { value }
      },
    ],
    [
      'throwing Proxy',
      () =>
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error('proxy trap')
            },
          },
        ),
    ],
  ])('fail-closes a builtin hook when JSON-v1 serialization fails: %s', async (_name, make) => {
    const runtime = new BridgeRuntime(stubHost())
    const handler = vi.fn()
    const signals: HookPipelineSignal[] = []
    runtime.registerHostHook('builtin', 'preToolUse', handler, { name: 'apollo.secret-scan' })
    const outcome = await runtime.runDomainHooks('preToolUse', make(), {
      report: (signal) => signals.push(signal),
    })
    expect(outcome?.veto).toBe(true)
    expect(outcome?.reason).toContain('fail-closed')
    expect(outcome?.reason).not.toContain('proxy trap')
    expect(handler).not.toHaveBeenCalled()
    expect(signals).toEqual([
      expect.objectContaining({
        kind: 'builtin_hook_error',
        code: 'builtin_hook_error',
        hook: 'apollo.secret-scan',
        event: 'preToolUse',
      }),
    ])
  })

  it('uses deterministic JSON-v1 bytes and digest independent of object insertion order', async () => {
    const first = { z: 'x'.repeat(BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES), a: 1 }
    const second = { a: 1, z: 'x'.repeat(BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES) }
    const runtime = new BridgeRuntime(stubHost())
    runtime.registerHostHook('builtin', 'preToolUse', vi.fn())
    const signals: HookPipelineSignal[] = []
    await runtime.runDomainHooks('preToolUse', first, {
      report: (signal) => signals.push(signal),
    })
    await runtime.runDomainHooks('preToolUse', second, {
      report: (signal) => signals.push(signal),
    })
    expect(signals).toHaveLength(2)
    const firstSignal = signals[0]
    const secondSignal = signals[1]
    if (
      firstSignal?.kind !== 'builtin_hook_payload_too_large' ||
      secondSignal?.kind !== 'builtin_hook_payload_too_large'
    )
      throw new Error('missing deterministic size signals')
    expect(firstSignal.rawBytes).toBe(secondSignal.rawBytes)
    expect(firstSignal.rawDigest).toBe(secondSignal.rawDigest)
  })

  it.each([
    ['Uint8Array', () => new Uint8Array([0, 1, 2, 254, 255])],
    ['Buffer', () => Buffer.from([0, 1, 2, 254, 255])],
  ])(
    'supports a small %s inline attachment in the strict JSON-v1 boundary',
    async (_name, make) => {
      const runtime = new BridgeRuntime(stubHost())
      const handler = vi.fn()
      runtime.registerHostHook('builtin', 'postToolUse', handler)
      const payload = {
        result: {
          content: [
            {
              type: 'image',
              mime: 'image/png',
              source: { kind: 'inline', bytes: make() },
            },
          ],
        },
      }
      const outcome = await runtime.runDomainHooks('postToolUse', payload)
      expect(outcome?.veto).toBeUndefined()
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler.mock.calls[0]?.[0]).toEqual({
        result: {
          content: [
            {
              type: 'image',
              mime: 'image/png',
              source: {
                kind: 'inline',
                // The strict clone normalizes Node Buffer to its Uint8Array data model.
                bytes: new Uint8Array([0, 1, 2, 254, 255]),
              },
            },
          ],
        },
      })
    },
  )

  it('tight-copies a small byte subview without cloning or exposing its oversized backing', async () => {
    const backing = new ArrayBuffer(16 * BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES)
    new Uint8Array(backing)[0] = 0x61
    const view = new Uint8Array(backing, 8 * BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES, 1)
    view[0] = 0x7f
    const runtime = new BridgeRuntime(stubHost())
    const builtin = vi.fn()
    const project = vi.fn()
    runtime.registerHostHook('builtin', 'postToolUse', builtin)
    runtime.registerHostHook('project', 'postToolUse', project)

    const outcome = await runtime.runDomainHooks('postToolUse', { bytes: view })

    for (const observed of [
      builtin.mock.calls[0]?.[0],
      project.mock.calls[0]?.[0],
      outcome?.value,
    ]) {
      const bytes = (observed as { bytes: Uint8Array }).bytes
      expect([...bytes]).toEqual([0x7f])
      expect(bytes.byteLength).toBe(1)
      expect(bytes.buffer.byteLength).toBe(1)
    }
  })

  it.each([
    ['Uint8Array', () => new Uint8Array(BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES)],
    ['Buffer', () => Buffer.alloc(BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES)],
  ])('vetoes an oversized canonical %s attachment before the handler', async (_name, make) => {
    const runtime = new BridgeRuntime(stubHost())
    const handler = vi.fn()
    const signals: HookPipelineSignal[] = []
    runtime.registerHostHook('builtin', 'postToolUse', handler)
    const outcome = await runtime.runDomainHooks(
      'postToolUse',
      { bytes: make() },
      { report: (signal) => signals.push(signal) },
    )
    expect(outcome?.veto).toBe(true)
    expect(handler).not.toHaveBeenCalled()
    expect(signals).toHaveLength(1)
    const signal = signals[0]
    expect(signal?.kind).toBe('builtin_hook_payload_too_large')
    if (signal?.kind !== 'builtin_hook_payload_too_large') throw new Error('missing size signal')
    expect(signal.rawBytes).toBeGreaterThan(BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES)
    expect(signal.scanStatus).toBe('not_started')
    expect(signal.decision).toBe('veto')
  })

  it.each([
    [
      'subclass getters',
      (bytes: Uint8Array) => {
        class SpoofedBytes extends Uint8Array {
          override get buffer(): ArrayBuffer {
            return new ArrayBuffer(0)
          }
          override get byteOffset(): number {
            return 0
          }
          override get byteLength(): number {
            return 0
          }
        }
        return new SpoofedBytes(bytes)
      },
    ],
    [
      'own properties',
      (bytes: Uint8Array) =>
        Object.defineProperties(new Uint8Array(bytes), {
          buffer: { value: new ArrayBuffer(0) },
          byteOffset: { value: 0 },
          byteLength: { value: 0 },
        }),
    ],
  ] as const)(
    'uses intrinsic TypedArray slots when %s spoof the public view',
    async (_name, makeSpoofed) => {
      const logicalBytes = Buffer.alloc(2 * BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES, 0xa5)
      const payload = { bytes: makeSpoofed(logicalBytes) }
      const expectedPreimage = taggedBytesPayload(logicalBytes)
      const runtime = new BridgeRuntime(stubHost())
      const handler = vi.fn()
      const signals: HookPipelineSignal[] = []
      runtime.registerHostHook('builtin', 'postToolUse', handler)

      const outcome = await runtime.runDomainHooks('postToolUse', payload, {
        report: (signal) => signals.push(signal),
      })

      expect(outcome?.veto).toBe(true)
      expect(handler).not.toHaveBeenCalled()
      expect(signals).toEqual([
        expect.objectContaining({
          kind: 'builtin_hook_payload_too_large',
          rawBytes: expectedPreimage.byteLength,
          rawDigest: sha256Digest(expectedPreimage),
        }),
      ])
    },
  )

  it('binds a spoofing TypedArray subclass digest to its real offset and length', async () => {
    class SpoofedBytes extends Uint8Array {
      override get buffer(): ArrayBuffer {
        return new ArrayBuffer(BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES)
      }
      override get byteOffset(): number {
        return 0
      }
      override get byteLength(): number {
        return 1
      }
    }
    const viewLength = BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES
    const prefixLength = 17
    const backing = new ArrayBuffer(prefixLength + viewLength + 13)
    new Uint8Array(backing).fill(0x11)
    new Uint8Array(backing, prefixLength, viewLength).fill(0x5a)
    const payload = { bytes: new SpoofedBytes(backing, prefixLength, viewLength) }
    const expectedPreimage = taggedBytesPayload(Buffer.alloc(viewLength, 0x5a))
    const runtime = new BridgeRuntime(stubHost())
    const handler = vi.fn()
    const signals: HookPipelineSignal[] = []
    runtime.registerHostHook('builtin', 'postToolUse', handler)

    const outcome = await runtime.runDomainHooks('postToolUse', payload, {
      report: (signal) => signals.push(signal),
    })

    expect(outcome?.veto).toBe(true)
    expect(handler).not.toHaveBeenCalled()
    expect(signals).toEqual([
      expect.objectContaining({
        kind: 'builtin_hook_payload_too_large',
        rawBytes: expectedPreimage.byteLength,
        rawDigest: sha256Digest(expectedPreimage),
      }),
    ])
  })

  it('continues with the measured clone so hidden internal slots cannot reappear downstream', async () => {
    class HiddenState {
      #secret = 'not JSON-v1 data'

      reveal() {
        return this.#secret
      }
    }
    const hidden = new HiddenState()
    Object.setPrototypeOf(hidden, Object.prototype)
    const runtime = new BridgeRuntime(stubHost())
    const builtin = vi.fn()
    const project = vi.fn()
    runtime.registerHostHook('builtin', 'preToolUse', builtin)
    runtime.registerHostHook('project', 'preToolUse', project)

    const outcome = await runtime.runDomainHooks('preToolUse', { hidden })

    expect(builtin).toHaveBeenCalledWith({ hidden: {} })
    expect(project).toHaveBeenCalledWith({ hidden: {} })
    expect(outcome).toEqual({ value: { hidden: {} } })
  })

  it('rechecks a builtin rewrite and blocks oversized output before another hook sees it', async () => {
    const runtime = new BridgeRuntime(stubHost())
    const second = vi.fn()
    runtime.registerHostHook(
      'builtin',
      'preToolUse',
      () => ({ value: payloadAtSerializedBytes(BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES + 1) }),
      { name: 'apollo.first', priority: 1000 },
    )
    runtime.registerHostHook('builtin', 'preToolUse', second, {
      name: 'apollo.second',
      priority: 999,
    })
    const signals: HookPipelineSignal[] = []
    const outcome = await runtime.runDomainHooks(
      'preToolUse',
      { small: true },
      {
        report: (signal) => signals.push(signal),
      },
    )
    expect(outcome?.veto).toBe(true)
    expect(second).not.toHaveBeenCalled()
    expect(signals).toEqual([
      expect.objectContaining({
        kind: 'builtin_hook_payload_too_large',
        hook: 'apollo.first',
        scanStatus: 'not_started',
        decision: 'veto',
      }),
    ])
  })

  it('blocks an oversized rewrite from the final builtin handler', async () => {
    const runtime = new BridgeRuntime(stubHost())
    runtime.registerHostHook('builtin', 'preToolUse', () => ({
      value: payloadAtSerializedBytes(BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES + 1),
    }))
    const outcome = await runtime.runDomainHooks('preToolUse', { small: true })
    expect(outcome?.veto).toBe(true)
    expect(outcome?.reason).toContain('oversized payload')
  })

  it('rechecks an in-place mutation from the final builtin before any downstream handler', async () => {
    const runtime = new BridgeRuntime(stubHost())
    const project = vi.fn()
    runtime.registerHostHook('builtin', 'preToolUse', (payload) => {
      const mutable = payload as { data: string }
      mutable.data = 'x'.repeat(BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES + 1)
    })
    runtime.registerHostHook('project', 'preToolUse', project)
    const signals: HookPipelineSignal[] = []

    const outcome = await runtime.runDomainHooks(
      'preToolUse',
      { data: 'safe' },
      { report: (signal) => signals.push(signal) },
    )

    expect(outcome?.veto).toBe(true)
    expect(project).not.toHaveBeenCalled()
    expect(signals).toEqual([
      expect.objectContaining({
        kind: 'builtin_hook_payload_too_large',
        hook: 'apollo.builtin',
        scanStatus: 'not_started',
        decision: 'veto',
      }),
    ])
  })

  it('fails closed at the JSON-v1 depth and node resource limits', async () => {
    let tooDeep: Record<string, unknown> = { leaf: true }
    for (let index = 0; index < 600; index++) tooDeep = { nested: tooDeep }
    const tooMany = Array.from({ length: 200_001 }, () => null)
    const runtime = new BridgeRuntime(stubHost())
    const handler = vi.fn()
    runtime.registerHostHook('builtin', 'preToolUse', handler)
    for (const payload of [tooDeep, tooMany]) {
      const signals: HookPipelineSignal[] = []
      const outcome = await runtime.runDomainHooks('preToolUse', payload, {
        report: (signal) => signals.push(signal),
      })
      expect(outcome?.veto).toBe(true)
      expect(outcome?.reason).toBe(
        'builtin hook apollo.builtin on preToolUse payload serialization failed (fail-closed)',
      )
      expect(signals).toEqual([
        expect.objectContaining({
          kind: 'builtin_hook_error',
          message: 'hook JSON-v1 serialization failed',
        }),
      ])
    }
    expect(handler).not.toHaveBeenCalled()
  })

  it('fails closed before aliased values amplify canonical hashing past its work budget', async () => {
    const shared = 'x'.repeat(BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES)
    const payload = { chunks: Array.from({ length: 17 }, () => shared) }
    const runtime = new BridgeRuntime(stubHost())
    const handler = vi.fn()
    const signals: HookPipelineSignal[] = []
    runtime.registerHostHook('builtin', 'preToolUse', handler)

    const outcome = await runtime.runDomainHooks('preToolUse', payload, {
      report: (signal) => signals.push(signal),
    })

    expect(outcome?.veto).toBe(true)
    expect(handler).not.toHaveBeenCalled()
    expect(signals).toEqual([
      expect.objectContaining({
        kind: 'builtin_hook_error',
        message: 'hook JSON-v1 serialization failed',
      }),
    ])
    expect(signals[0]).not.toHaveProperty('rawDigest')
  })

  it.each(['plugin', 'project', 'user'] as const)(
    'preserves oversized %s hook dispatch and rewrite semantics',
    async (domain) => {
      const runtime = new BridgeRuntime(stubHost())
      const payload = payloadAtSerializedBytes(BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES + 1)
      const seen: unknown[] = []
      if (domain === 'plugin') {
        runtime.create(manifest, process.cwd(), 'tool-1').hooks.on('preToolUse', (value) => {
          seen.push(value)
          return { value: { rewrittenBy: domain, original: value } }
        })
      } else {
        runtime.registerHostHook(domain, 'preToolUse', (value) => {
          seen.push(value)
          return { value: { rewrittenBy: domain, original: value } }
        })
      }
      const signals: HookPipelineSignal[] = []
      const outcome = await runtime.runDomainHooks('preToolUse', payload, {
        report: (signal) => signals.push(signal),
      })
      expect(seen).toEqual([payload])
      expect(outcome).toEqual({ value: { rewrittenBy: domain, original: payload } })
      expect(signals).toEqual([])
    },
  )

  it('passes a small builtin payload to the handler in full', async () => {
    const runtime = new BridgeRuntime(stubHost())
    const handler = vi.fn()
    const signals: HookPipelineSignal[] = []
    runtime.registerHostHook('builtin', 'preToolUse', handler)
    const payload = { tool: 'Bash', input: { command: 'ls' } }
    await runtime.runDomainHooks('preToolUse', payload, {
      report: (signal) => signals.push(signal),
    })
    expect(handler).toHaveBeenCalledWith(payload)
    expect(signals).toEqual([])
  })

  it('removes host hooks on dispose', async () => {
    const runtime = new BridgeRuntime(stubHost())
    const disposable = runtime.registerHostHook('builtin', 'preToolUse', () => ({
      veto: true,
      reason: 'gone soon',
    }))
    await disposable.dispose()
    expect(await runtime.runDomainHooks('preToolUse', {})).toBeUndefined()
  })

  it('funnels memory events through runMemoryHooks instead of the domain pipeline', async () => {
    const runtime = new BridgeRuntime(stubHost())
    runtime.registerHostHook('builtin', 'memory.preWrite', () => {})
    await expect(runtime.runDomainHooks('memory.preWrite', {})).rejects.toThrow(
      'plugin_memory_hook_dispatch_required',
    )
  })
})
