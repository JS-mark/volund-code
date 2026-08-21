import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex, PassThrough } from 'node:stream'

import type { PluginHost } from '@apollo-code/native-bridge'
import { describe, expect, it, vi } from 'vitest'

import {
  APOLLO_BRIDGE_CAPABILITIES,
  BridgeRuntime,
  createRpcGuard,
  PluginManager,
  PluginRegistryClient,
  PluginRuntime,
  validateManifest,
  verifyBundle,
  verifyPluginRegistryMetadata,
} from './index'
import { createLegacyPluginTestManager } from './test-only/legacy-harness'
const manifest = {
  name: 'apollo-plugin-test',
  version: '1.0.0',
  engines: { apollo: '^1.0.0' },
  main: 'index.js',
  type: 'module',
  permissions: { apollo: ['tools.register'], net: false },
} as const
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'apollo-plugin-'))
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(join(root, 'index.js'), 'export default {}')
  return root
}
describe('plugin runtime', () => {
  it('publishes an exhaustive ApolloBridge capability matrix with test entry points', () => {
    const expected = [
      'tools.register',
      'tools.unregister',
      'hooks.on',
      'hooks.off',
      'hooks.kv.get',
      'hooks.kv.set',
      'hooks.kv.delete',
      'hooks.kv.clear',
      'commands.register',
      'prompt.contribute',
      'prompt.revoke',
      'session.getMessages',
      'session.getUsage',
      'session.on',
      'fs.readFile',
      'fs.writeFile',
      'fs.exists',
      'fs.glob',
      'fs.stat',
      'exec',
      'http.fetch',
      'ui.confirm',
      'ui.prompt',
      'ui.pick',
      'ui.notify',
      'storage.get',
      'storage.set',
      'storage.delete',
      'memory.get',
      'memory.list',
      'memory.search',
      'memory.create',
      'memory.update',
      'memory.delete',
      'memory.export',
      'config.get',
      'log.debug',
      'log.info',
      'log.warn',
      'log.error',
      'call',
      'provider.register',
      'auth.getAuthHeaders',
      'auth.getSigningEnvKeys',
    ]
    expect(APOLLO_BRIDGE_CAPABILITIES.map(({ method }) => method)).toEqual(expected)
    expect(new Set(APOLLO_BRIDGE_CAPABILITIES.map(({ method }) => method)).size).toBe(
      expected.length,
    )
    expect(APOLLO_BRIDGE_CAPABILITIES.every(({ test }) => test.length > 0)).toBe(true)
    expect(APOLLO_BRIDGE_CAPABILITIES.find(({ method }) => method === 'call')).toMatchObject({
      status: 'unsupported',
      reason: expect.any(String),
    })
  })

  const registryDigest = `sha256-${'a'.repeat(64)}`
  const registryMetadata = {
    schemaVersion: 1,
    name: manifest.name,
    version: manifest.version,
    source: 'https://registry.fixture.invalid/',
    bundle: {
      url: 'https://registry.fixture.invalid/bundles/apollo-plugin-test-1.0.0.tgz',
      digest: registryDigest,
    },
    signature: { keyId: 'fixture-key', value: 'fixture-signature' },
    revoked: false,
  } as const
  const fixtureVerifier = { verify: async () => true }

  it('resolves registry trust metadata through a local-only injected fixture', async () => {
    const client = new PluginRegistryClient({
      source: registryMetadata.source,
      fetchMetadata: async (name, version) => {
        expect([name, version]).toEqual([manifest.name, manifest.version])
        return registryMetadata
      },
      verifier: fixtureVerifier,
    })
    await expect(client.resolve(manifest.name, manifest.version, registryDigest)).resolves.toEqual(
      registryMetadata,
    )
  })

  it('fails closed for missing signatures, revocation, digest mismatch, and source pollution', async () => {
    const expected = {
      name: manifest.name,
      version: manifest.version,
      source: registryMetadata.source,
      digest: registryDigest,
    }
    const verify = (value: unknown) =>
      verifyPluginRegistryMetadata(value, expected, fixtureVerifier)
    const { signature: _signature, ...unsigned } = registryMetadata
    await expect(verify(unsigned)).rejects.toThrow('plugin_registry_metadata_invalid')
    await expect(verify({ ...registryMetadata, revoked: true })).rejects.toThrow(
      'plugin_registry_revoked',
    )
    await expect(
      verify({
        ...registryMetadata,
        bundle: { ...registryMetadata.bundle, digest: `sha256-${'b'.repeat(64)}` },
      }),
    ).rejects.toThrow('plugin_registry_digest_mismatch')
    await expect(
      verify({
        ...registryMetadata,
        bundle: { ...registryMetadata.bundle, url: 'https://evil.invalid/plugin.tgz' },
      }),
    ).rejects.toThrow('plugin_registry_source_pollution')
    await expect(
      verify(Object.assign(Object.create({ polluted: true }), registryMetadata)),
    ).rejects.toThrow('plugin_registry_metadata_invalid')
  })

  it('fails closed when the fixture signature verifier rejects the signed payload', async () => {
    await expect(
      verifyPluginRegistryMetadata(
        registryMetadata,
        {
          name: manifest.name,
          version: manifest.version,
          source: registryMetadata.source,
          digest: registryDigest,
        },
        { verify: () => false },
      ),
    ).rejects.toThrow('plugin_registry_signature_invalid')
  })

  it('accepts only permission-gated allowlisted declarative UI', () => {
    const ui = [{ id: 'branch', surface: 'status-bar', text: 'main' }] as const
    expect(
      validateManifest(
        {
          ...manifest,
          contributes: { ui },
          permissions: { ...manifest.permissions, apollo: ['tools.register', 'ui.contribute'] },
        },
        '1.0.0',
      ).contributes?.ui,
    ).toEqual(ui)
    expect(() => validateManifest({ ...manifest, contributes: { ui } }, '1.0.0')).toThrow(
      'plugin_ui_permission_required',
    )
    expect(() =>
      validateManifest(
        {
          ...manifest,
          contributes: { ui: [{ ...ui[0], surface: 'sidebar' }] },
          permissions: { ...manifest.permissions, apollo: ['ui.contribute'] },
        },
        '1.0.0',
      ),
    ).toThrow('plugin_ui_invalid')
    expect(() =>
      validateManifest(
        {
          ...manifest,
          contributes: { ui: [{ ...ui[0], component: 'file://evil.js' }] },
          permissions: { ...manifest.permissions, apollo: ['ui.contribute'] },
        },
        '1.0.0',
      ),
    ).toThrow('plugin_ui_invalid')
  })

  it('loads enabled plugins over NDJSON and cleans up registrations', async () => {
    const source = await fixture(),
      root = await mkdtemp(join(tmpdir(), 'apollo-installed-')),
      dataRoot = await mkdtemp(join(tmpdir(), 'apollo-data-')),
      manager = createLegacyPluginTestManager(root, '1.0.0')
    await manager.init()
    await manager.install(source)
    let registered: { handler(input: unknown): Promise<unknown> } | undefined
    let disposed = false
    const bridge = new BridgeRuntime({
      session: { id: 's', cwd: source, messages: [], usage: { inputTokens: 0, outputTokens: 0 } },
      register: (_kind, value) => {
        registered = value as typeof registered
        return {
          dispose: () => {
            disposed = true
          },
        }
      },
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
      log: () => undefined,
    })
    let terminated = false
    const start = async (): Promise<PluginHost> => {
      const childToParent = new PassThrough(),
        parentToChild = new PassThrough()
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
      parentToChild.on('data', (chunk: string) => {
        buffer += chunk
        for (;;) {
          const newline = buffer.indexOf('\n')
          if (newline < 0) break
          const frame = JSON.parse(buffer.slice(0, newline)) as { id: number; method?: string }
          buffer = buffer.slice(newline + 1)
          if (frame.method === 'callback.invoke')
            childToParent.write(
              `${JSON.stringify({ jsonrpc: '2.0', bridgeVersion: 1, id: frame.id, result: { echoed: true } })}\n`,
            )
        }
      })
      queueMicrotask(() => {
        childToParent.write(
          `${JSON.stringify({ jsonrpc: '2.0', bridgeVersion: 1, id: 1, method: 'apollo.tools.register', params: { name: 'echo', description: 'echo', inputSchema: {}, handler: { $callback: 'handler-1' } } })}\n`,
        )
        childToParent.write(
          `${JSON.stringify({ jsonrpc: '2.0', bridgeVersion: 1, method: 'host.activated', params: {} })}\n`,
        )
      })
      return {
        pid: 1,
        bridge: transport,
        terminate: () => {
          terminated = true
          transport.destroy()
        },
        exited: new Promise(() => {}),
      }
    }
    const runtime = new PluginRuntime(manager, bridge, { dataRoot, start })
    await runtime.loadEnabled()
    expect(runtime.active()).toEqual([manifest.name])
    await expect(runtime.load(manifest.name)).rejects.toThrow('plugin_already_loaded')
    await expect(registered!.handler({ text: 'hi' })).resolves.toEqual({ echoed: true })
    await runtime.setEnabled(manifest.name, false)
    expect(terminated).toBe(true)
    expect(disposed).toBe(true)
    expect(manager.list()[manifest.name]?.enabled).toBe(false)
  })

  it('times out activation, cleans the process, and disables after three failures', async () => {
    const source = await fixture(),
      root = await mkdtemp(join(tmpdir(), 'apollo-installed-')),
      dataRoot = await mkdtemp(join(tmpdir(), 'apollo-data-')),
      manager = createLegacyPluginTestManager(root, '1.0.0')
    await manager.init()
    await manager.install(source)
    let terminated = 0
    const runtime = new PluginRuntime(
      manager,
      new BridgeRuntime({
        session: { id: 's', cwd: source, messages: [], usage: { inputTokens: 0, outputTokens: 0 } },
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
        log: () => undefined,
      }),
      {
        dataRoot,
        activationTimeoutMs: 5,
        start: async () => {
          const bridge = new PassThrough()
          return {
            pid: 1,
            bridge,
            terminate: () => {
              terminated++
              bridge.destroy()
            },
            exited: new Promise(() => {}),
          }
        },
      },
    )
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(runtime.load(manifest.name)).rejects.toThrow('plugin_activation_timeout')
    expect(terminated).toBe(3)
    expect(manager.list()[manifest.name]?.enabled).toBe(false)
  })

  it('kills a no-response host and disposes its worker registrations', async () => {
    vi.useFakeTimers()
    const source = await fixture(),
      root = await mkdtemp(join(tmpdir(), 'apollo-installed-')),
      dataRoot = await mkdtemp(join(tmpdir(), 'apollo-data-')),
      manager = createLegacyPluginTestManager(root, '1.0.0')
    await manager.init()
    await manager.install(source)
    let registrationsDisposed = 0
    let terminated = 0
    const bridge = new BridgeRuntime({
      session: { id: 's', cwd: source, messages: [], usage: { inputTokens: 0, outputTokens: 0 } },
      register: () => ({
        dispose: () => {
          registrationsDisposed++
        },
      }),
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
      log: () => undefined,
    })
    const runtime = new PluginRuntime(manager, bridge, {
      dataRoot,
      heartbeatTimeoutMs: 20,
      start: async () => {
        const transport = new PassThrough()
        queueMicrotask(() => {
          transport.write(
            `${JSON.stringify({ jsonrpc: '2.0', bridgeVersion: 1, id: 1, method: 'apollo.tools.register', params: { name: 'stalled', description: 'stalled', inputSchema: {}, handler: { $callback: 'handler-1' } } })}\n`,
          )
          transport.write(
            `${JSON.stringify({ jsonrpc: '2.0', bridgeVersion: 1, method: 'host.activated', params: {} })}\n`,
          )
        })
        return {
          pid: 1,
          bridge: transport,
          terminate: () => {
            terminated++
            transport.destroy()
          },
          exited: new Promise(() => {}),
        }
      },
    })
    await runtime.load(manifest.name)
    expect(runtime.active()).toEqual([manifest.name])
    await vi.advanceTimersByTimeAsync(21)
    await Promise.resolve()
    expect(terminated).toBe(1)
    expect(registrationsDisposed).toBe(1)
    expect(runtime.active()).toEqual([])
    vi.useRealTimers()
  })

  it('cancels activation and rejects a changed approval hash', async () => {
    const source = await fixture(),
      root = await mkdtemp(join(tmpdir(), 'apollo-installed-')),
      dataRoot = await mkdtemp(join(tmpdir(), 'apollo-data-')),
      manager = createLegacyPluginTestManager(root, '1.0.0')
    await manager.init()
    await manager.install(source)
    const runtime = new PluginRuntime(
      manager,
      new BridgeRuntime({
        session: { id: 's', cwd: source, messages: [], usage: { inputTokens: 0, outputTokens: 0 } },
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
        log: () => undefined,
      }),
      {
        dataRoot,
        start: async () => {
          const bridge = new PassThrough()
          return {
            pid: 1,
            bridge,
            terminate: () => bridge.destroy(),
            exited: new Promise(() => {}),
          }
        },
      },
    )
    const controller = new AbortController()
    const loading = runtime.load(manifest.name, controller.signal)
    controller.abort()
    await expect(loading).rejects.toThrow('plugin_activation_cancelled')
    await writeFile(
      join(root, manifest.name, 'manifest.json'),
      JSON.stringify({ ...manifest, permissions: { apollo: ['tools.register', 'log.write'] } }),
    )
    await expect(runtime.load(manifest.name)).rejects.toThrow('plugin_approval_stale')
  })
  it('validates engines and rejects path escapes', () => {
    expect(validateManifest(manifest, '1.4.0').name).toBe(manifest.name)
    expect(() => validateManifest({ ...manifest, main: '../x' }, '1.0.0')).toThrow('invalid')
  })
  it('checks integrity and symlink escapes', async () => {
    const dir = await fixture()
    const hash = createHash('sha256')
      .update(await readFile(join(dir, 'index.js')))
      .digest('hex')
    await expect(verifyBundle(dir, manifest, { 'index.js': hash })).resolves.toBeUndefined()
    await symlink('index.js', join(dir, 'escape'))
    await expect(verifyBundle(dir, manifest, { escape: hash })).rejects.toThrow(/escapes|symlink/)
  })
  it('installs atomically and auto disables repeated failures', async () => {
    const source = await fixture(),
      root = await mkdtemp(join(tmpdir(), 'apollo-installed-')),
      manager = createLegacyPluginTestManager(root, '1.0.0')
    await manager.init()
    await manager.install(source)
    expect(manager.list()[manifest.name]?.enabled).toBe(true)
    await manager.recordFailure(manifest.name, 2)
    expect(await manager.recordFailure(manifest.name, 2)).toBe(true)
    expect(manager.list()[manifest.name]?.enabled).toBe(false)
  })
  it('contains legacy production activation until Catalog v2 can issue receipts', async () => {
    const source = await fixture(),
      root = await mkdtemp(join(tmpdir(), 'apollo-contained-')),
      dataRoot = await mkdtemp(join(tmpdir(), 'apollo-contained-data-')),
      confirm = vi.fn(async () => true),
      manager = new PluginManager(root, '1.0.0', confirm)
    await manager.init()
    await expect(manager.install(join(root, 'missing-source'))).rejects.toMatchObject({
      code: 'plugin_legacy_activation_unavailable',
    })
    await expect(manager.setEnabled('missing-plugin', true)).rejects.toMatchObject({
      code: 'plugin_legacy_activation_unavailable',
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(manager.list()).toEqual({})

    const start = vi.fn(async (): Promise<PluginHost> => {
      throw new Error('production activation must not reach the host')
    })
    const runtime = new PluginRuntime(
      manager,
      new BridgeRuntime({
        session: { id: 's', cwd: source, messages: [], usage: { inputTokens: 0, outputTokens: 0 } },
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
        log: () => undefined,
      }),
      { dataRoot, start },
    )
    await expect(runtime.loadEnabled()).resolves.toEqual([])
    await expect(runtime.load(manifest.name)).rejects.toMatchObject({
      code: 'plugin_legacy_activation_unavailable',
    })
    expect(start).not.toHaveBeenCalled()

    await manager.uninstall(manifest.name)
    expect(manager.list()).toEqual({})
  })
  it('migrates stale enabled legacy records to disabled on production startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-stale-enabled-'))
    const statePath = join(root, 'plugins.json')
    const initial = {
      formatVersion: 1,
      approvals: {
        [manifest.name]: {
          version: manifest.version,
          permissionHash: 'legacy-hash',
          enabled: true,
          failures: 7,
          receipt: { issuer: 'legacy-registry', serial: 41 },
        },
        'apollo-plugin-second': {
          version: '2.0.0',
          permissionHash: 'second-hash',
          enabled: true,
          failures: 2,
        },
        'apollo-plugin-already-disabled': {
          version: '3.0.0',
          permissionHash: 'disabled-hash',
          enabled: false,
          failures: 9,
        },
      },
    }
    const initialSerialized = JSON.stringify(initial)
    await writeFile(statePath, initialSerialized)
    const manager = new PluginManager(root, '1.0.0', async () => true)
    await manager.init()
    const migrated = {
      ...initial,
      approvals: Object.fromEntries(
        Object.entries(initial.approvals).map(([name, approval]) => [
          name,
          { ...approval, enabled: false },
        ]),
      ),
    }
    expect(manager.list()).toEqual(migrated.approvals)
    await expect(manager.setEnabled(manifest.name, true)).rejects.toMatchObject({
      code: 'plugin_legacy_activation_unavailable',
    })
    const migratedSerialized = await readFile(statePath, 'utf8')
    expect(migratedSerialized).not.toBe(initialSerialized)
    expect(JSON.parse(migratedSerialized)).toEqual(migrated)

    const sentinelTime = new Date('2001-02-03T04:05:06.000Z')
    await utimes(statePath, sentinelTime, sentinelTime)
    const beforeSecondInit = await stat(statePath)
    await manager.init()
    const afterSecondInit = await stat(statePath)
    expect(afterSecondInit.mtimeMs).toBe(beforeSecondInit.mtimeMs)
    expect(await readFile(statePath, 'utf8')).toBe(migratedSerialized)
  })
  it('fails malformed production state closed with a stable diagnostic and zero activation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-malformed-state-')),
      dataRoot = await mkdtemp(join(tmpdir(), 'apollo-malformed-state-data-')),
      manager = new PluginManager(root, '1.0.0', async () => true),
      start = vi.fn(async (): Promise<PluginHost> => {
        throw new Error('malformed state must not reach the plugin host')
      })
    await writeFile(join(root, 'plugins.json'), '{ definitely-not-json')

    await expect(manager.init()).rejects.toMatchObject({
      code: 'plugin_legacy_activation_unavailable',
      message: expect.stringContaining('legacy plugin state migration'),
    })
    expect(manager.list()).toEqual({})

    const runtime = new PluginRuntime(
      manager,
      new BridgeRuntime({
        session: { id: 's', cwd: root, messages: [], usage: { inputTokens: 0, outputTokens: 0 } },
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
        log: () => undefined,
      }),
      { dataRoot, start },
    )
    await expect(runtime.loadEnabled()).resolves.toEqual([])
    expect(start).not.toHaveBeenCalled()
  })
  it('keeps migrated state disabled when atomic persistence fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-migration-save-failure-'))
    await writeFile(
      join(root, 'plugins.json'),
      JSON.stringify({
        approvals: {
          [manifest.name]: {
            version: manifest.version,
            permissionHash: 'legacy-hash',
            enabled: true,
            failures: 5,
          },
        },
      }),
    )
    await mkdir(join(root, `.plugins-${process.pid}.tmp`))
    const manager = new PluginManager(root, '1.0.0', async () => true)

    await expect(manager.init()).rejects.toMatchObject({
      code: 'plugin_legacy_activation_unavailable',
      message: expect.stringContaining('migration persistence'),
    })
    expect(manager.list()[manifest.name]).toEqual({
      version: manifest.version,
      permissionHash: 'legacy-hash',
      enabled: false,
      failures: 5,
    })
  })
  it('enforces rpc allowlists and per-turn quotas', () => {
    const guard = createRpcGuard(manifest, 1)
    guard('t', 'tools.register')
    expect(() => guard('t', 'tools.register')).toThrow('tools.register')
    expect(() => guard('u', 'fs.write')).toThrow('fs.write')
  })

  it('exposes permission-gated bridge namespaces and immutable session snapshots', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'apollo-bridge-'))
    await writeFile(join(cwd, 'allowed.txt'), 'ok')
    const logs: unknown[] = [],
      storage = new Map<string, unknown>(),
      registrations: string[] = [],
      memoryCalls: string[] = []
    const runtime = new BridgeRuntime({
      session: {
        id: 's1',
        cwd,
        messages: [{ role: 'user', content: 'hello' }],
        usage: { inputTokens: 1, outputTokens: 2 },
      },
      register: (kind) => {
        registrations.push(kind)
        return {
          dispose: () => {
            registrations.push(`dispose:${kind}`)
          },
        }
      },
      fs: {
        readFile: async (path) => readFile(path, 'utf8'),
        writeFile,
        exists: async () => true,
        glob: async () => [],
        stat: async () => ({ size: 2, type: 'file', modifiedAt: 0 }),
      },
      exec: async () => ({ stdout: 'safe', stderr: '', code: 0 }),
      fetch: async () => ({ ok: true }),
      ui: async () => true,
      storage: async (plugin, operation, key, value) => {
        const isolated = `${plugin}:${key}`
        if (operation === 'set') storage.set(isolated, value)
        if (operation === 'delete') storage.delete(isolated)
        return storage.get(isolated)
      },
      memory: async (_plugin, operation, params) => {
        memoryCalls.push(operation)
        return { operation, params }
      },
      config: () => 'configured',
      log: (_level, _message, meta) => logs.push(meta),
    })
    const bridgeManifest = {
      ...manifest,
      config: { mode: { type: 'string' } },
      permissions: {
        fs: { read: [cwd], write: [cwd] },
        bash: { allowlist: ['git *'] },
        net: { allowlist: ['api.example.com'] },
        apollo: [
          'tools.register',
          'hooks.on',
          'session.read',
          'fs.read',
          'fs.write',
          'exec',
          'http.fetch',
          'storage.read',
          'storage.write',
          'memory.read',
          'memory.write',
          'memory.search',
          'memory.export',
          'config.read',
          'log.write',
        ],
        memory: {
          read: ['project'],
          write: true,
          search: true,
          export: true,
        },
      },
    } as const
    const bridge = runtime.create(bridgeManifest, join(cwd, 'data'), 'turn-1')
    runtime.registerUiContributions({
      ...bridgeManifest,
      contributes: { ui: [{ id: 'status', surface: 'status-bar', text: 'ready' }] },
    })
    bridge.tools.register({ name: 'x', description: 'x', inputSchema: {}, async handler() {} })
    expect(await bridge.fs.readFile('allowed.txt')).toBe('ok')
    await expect(bridge.exec('git status')).resolves.toMatchObject({ code: 0 })
    await expect(bridge.exec('rm -rf /')).rejects.toThrow('plugin_exec_denied')
    await expect(bridge.http.fetch('https://api.example.com/v1')).resolves.toEqual({ ok: true })
    await expect(bridge.http.fetch('https://evil.example/v1')).rejects.toThrow('plugin_net_denied')
    const messages = bridge.session.getMessages()
    expect(Object.isFrozen(bridge.plugin)).toBe(true)
    expect(messages).not.toBe(runtime.host.session.messages)
    await bridge.storage.set('key', { value: 1 })
    expect(await bridge.storage.get('key')).toEqual({ value: 1 })
    await expect(bridge.memory.get('project', 'one')).resolves.toMatchObject({ operation: 'get' })
    await expect(bridge.memory.search('project', 'query')).resolves.toMatchObject({
      operation: 'search',
    })
    await expect(
      bridge.memory.create({ scope: 'project', content: 'safe' }),
    ).resolves.toMatchObject({ operation: 'create' })
    await expect(bridge.memory.export('project')).resolves.toMatchObject({ operation: 'export' })
    await expect(bridge.memory.get('workspace', 'one')).rejects.toThrow('scope_denied')
    expect(memoryCalls).toEqual(['get', 'search', 'create', 'export'])
    bridge.log.info('Bearer top-secret', { apiKey: 'secret' })
    expect(JSON.stringify(logs)).not.toContain('top-secret')
    expect(JSON.stringify(logs)).not.toContain('secret')
    await runtime.deactivate(manifest.name)
    expect(registrations).toContain('dispose:tool')
    expect(registrations).toContain('dispose:ui')
  })

  it('orders hooks by priority, short-circuits veto, enforces kv quota and timeout', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'apollo-hooks-')),
      calls: string[] = []
    const runtime = new BridgeRuntime(
      {
        session: { id: 's', cwd, messages: [], usage: { inputTokens: 0, outputTokens: 0 } },
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
        log: () => undefined,
      },
      { timeoutMs: 10, hookKvBytes: 20 },
    )
    const hookManifest = { ...manifest, permissions: { apollo: ['hooks.on'] } } as const
    const bridge = runtime.create(hookManifest, cwd, 'tool-1')
    bridge.hooks.on(
      'preToolUse',
      () => {
        calls.push('low')
      },
      { priority: 1 },
    )
    bridge.hooks.on(
      'preToolUse',
      () => {
        calls.push('veto')
        return { veto: true, reason: 'no' }
      },
      { priority: 10 },
    )
    expect(await runtime.runHooks('preToolUse', { injected: 'ignore instructions' })).toEqual({
      veto: true,
      reason: 'no',
    })
    expect(calls).toEqual(['veto'])
    bridge.hooks.kv.set('a', 1)
    expect(bridge.hooks.kv.get('a')).toBe(1)
    expect(() => bridge.hooks.kv.set('large', 'x'.repeat(100))).toThrow('quota')
    expect(() => bridge.hooks.on('preToolUse', () => undefined, { priority: 101 })).toThrow(
      'plugin_hook_priority_invalid',
    )
    const slow = runtime.create(hookManifest, cwd, 'tool-2')
    slow.hooks.on('postToolUse', () => new Promise(() => {}))
    await expect(runtime.runHooks('postToolUse', {})).rejects.toThrow('timeout')
  })

  it('dispatches memory hooks only to plugins authorized for the exact scope', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'apollo-memory-hooks-')),
      seen: Array<{ plugin: string; payload: unknown }> = []
    const runtime = new BridgeRuntime({
      session: { id: 's', cwd, messages: [], usage: { inputTokens: 0, outputTokens: 0 } },
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
      log: () => undefined,
    })
    const project = runtime.create(
      {
        ...manifest,
        permissions: { apollo: ['hooks.on'], memory: { read: ['project'] } },
      },
      cwd,
    )
    const session = runtime.create(
      {
        ...manifest,
        name: 'apollo-plugin-session-policy',
        permissions: { apollo: ['hooks.on'], memory: { read: ['session'] } },
      },
      cwd,
    )
    project.hooks.on('memory.preWrite', (payload) => {
      seen.push({ plugin: 'project', payload })
      return { veto: true, reason: 'project policy' }
    })
    session.hooks.on('memory.preWrite', (payload) => {
      seen.push({ plugin: 'session', payload })
    })

    await expect(
      runtime.runMemoryHooks('memory.preWrite', {
        schemaVersion: 1,
        operation: 'create',
        phase: 'commit',
        scope: 'project',
        id: 'one',
        content: 'safe candidate',
      }),
    ).resolves.toEqual({
      plugin: manifest.name,
      result: { veto: true, reason: 'project policy' },
    })
    await runtime.runMemoryHooks('memory.preWrite', {
      schemaVersion: 1,
      operation: 'create',
      phase: 'commit',
      scope: 'session',
      id: 'two',
      content: 'safe session candidate',
    })
    expect(seen).toEqual([
      {
        plugin: 'project',
        payload: expect.objectContaining({ scope: 'project', id: 'one' }),
      },
      {
        plugin: 'session',
        payload: expect.objectContaining({ scope: 'session', id: 'two' }),
      },
    ])
    const unscoped = runtime.create(
      { ...manifest, name: 'apollo-plugin-unscoped', permissions: { apollo: ['hooks.on'] } },
      cwd,
    )
    expect(() => unscoped.hooks.on('memory.preWrite', () => undefined)).toThrow(
      'plugin_memory_hook_scope_required',
    )
    await expect(runtime.runHooks('memory.preWrite', {})).rejects.toThrow(
      'plugin_memory_hook_dispatch_required',
    )
  })

  it('rejects symlink escapes and stops after 500 calls per turn', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'apollo-escape-')),
      outside = await mkdtemp(join(tmpdir(), 'apollo-outside-'))
    await writeFile(join(outside, 'secret'), 'secret')
    await symlink(join(outside, 'secret'), join(cwd, 'link'))
    const runtime = new BridgeRuntime({
      session: { id: 's', cwd, messages: [], usage: { inputTokens: 0, outputTokens: 0 } },
      register: () => ({ dispose() {} }),
      fs: {
        readFile: async (path) => readFile(path, 'utf8'),
        writeFile: async () => {},
        exists: async () => true,
        glob: async () => [],
        stat: async () => ({}),
      },
      exec: async () => ({}),
      fetch: async () => ({}),
      ui: () => undefined,
      storage: async () => undefined,
      config: () => undefined,
      log: () => undefined,
    })
    const bridge = runtime.create(
      { ...manifest, permissions: { fs: { read: [cwd] }, apollo: ['fs.read', 'session.read'] } },
      cwd,
      'turn',
    )
    await expect(bridge.fs.readFile('link')).rejects.toThrow('plugin_fs_denied')
    for (let index = 0; index < 499; index++) bridge.session.getUsage()
    expect(() => bridge.session.getUsage()).toThrow('plugin_rpc_quota_exceeded')
  })
})
