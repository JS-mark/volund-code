import { createHash } from 'node:crypto'
import { access, mkdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  it('keeps production artifacts free of legacy test authority seams', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')
    const packageManifest = await readFile(new URL('../package.json', import.meta.url), 'utf8')

    expect(source).not.toMatch(
      /legacyPluginTestAuthority|legacyPluginTestManagers|startPluginHost|PluginConnection/,
    )
    expect(source).toMatch(
      /fsConstants\.O_RDONLY\s*\|\s*fsConstants\.O_NOFOLLOW\s*\|\s*fsConstants\.O_NONBLOCK/,
    )
    expect(packageManifest).not.toMatch(/^\s*"dist",?$/m)
    await expect(
      access(new URL('./internal/legacy-test-authority.ts', import.meta.url)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      access(new URL('./test-only/legacy-harness.ts', import.meta.url)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

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
      'env.getEffective',
      'plugins.list',
      'plugins.install',
      'plugins.uninstall',
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
    await expect(manager.setEnabled('apollo-plugin-missing', true)).rejects.toMatchObject({
      code: 'plugin_legacy_activation_unavailable',
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(manager.list()).toEqual({})

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
      { dataRoot },
    )
    await expect(runtime.loadEnabled()).resolves.toEqual([])
    await expect(runtime.load(manifest.name)).rejects.toMatchObject({
      code: 'plugin_legacy_activation_unavailable',
    })
    await manager.uninstall(manifest.name)
    expect(manager.list()).toEqual({})
  })
  it('rejects inherited and invalid approval keys before any mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-approval-keys-'))
    await writeFile(
      join(root, 'plugins.json'),
      JSON.stringify({
        approvals: {
          [manifest.name]: {
            version: manifest.version,
            permissionHash: 'legacy-hash',
            enabled: true,
            failures: 7,
          },
        },
      }),
    )
    const manager = new PluginManager(root, '1.0.0', async () => true)
    await manager.init()
    const objectPrototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype)
    const objectConstructorBefore = Object.getOwnPropertyDescriptors(Object)

    try {
      for (const name of [
        '__proto__',
        'constructor',
        'prototype',
        '',
        '../outside',
        'apollo-plugin-',
        String.raw`apollo-plugin-a\outside`,
      ]) {
        await expect(manager.setEnabled(name, false)).rejects.toMatchObject({
          code: 'plugin_path_escape',
        })
        await expect(manager.setEnabled(name, true)).rejects.toMatchObject({
          code: 'plugin_path_escape',
        })
        await expect(manager.recordFailure(name)).rejects.toMatchObject({
          code: 'plugin_path_escape',
        })
      }

      await expect(manager.setEnabled('apollo-plugin-missing', false)).rejects.toMatchObject({
        code: 'plugin_not_installed',
      })
      await expect(manager.recordFailure('apollo-plugin-missing')).resolves.toBe(false)
      await manager.setEnabled(manifest.name, false)
      expect(manager.list()[manifest.name]).toMatchObject({ enabled: false, failures: 0 })
      expect(Object.getPrototypeOf(manager.list())).toBeNull()
      expect(Reflect.get(manager.list(), '__proto__')).toBeUndefined()
    } finally {
      for (const property of ['enabled', 'failures']) {
        const prototypeDescriptor = objectPrototypeBefore[property]
        const constructorDescriptor = objectConstructorBefore[property]
        if (prototypeDescriptor)
          Reflect.defineProperty(Object.prototype, property, prototypeDescriptor)
        else Reflect.deleteProperty(Object.prototype, property)
        if (constructorDescriptor) Object.defineProperty(Object, property, constructorDescriptor)
        else Reflect.deleteProperty(Object, property)
      }
    }

    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(objectPrototypeBefore)
    expect(Object.getOwnPropertyDescriptors(Object)).toEqual(objectConstructorBefore)
  })
  it('rejects symlinked and oversized legacy state before parsing', async () => {
    const symlinkRoot = await mkdtemp(join(tmpdir(), 'apollo-state-symlink-'))
    const outside = join(symlinkRoot, 'outside.json')
    await writeFile(outside, JSON.stringify({ approvals: {} }))
    await symlink(outside, join(symlinkRoot, 'plugins.json'))
    const symlinkManager = new PluginManager(symlinkRoot, '1.0.0', async () => true)
    await expect(symlinkManager.init()).rejects.toMatchObject({
      code: 'plugin_legacy_activation_unavailable',
    })

    const oversizedRoot = await mkdtemp(join(tmpdir(), 'apollo-state-oversized-'))
    await writeFile(join(oversizedRoot, 'plugins.json'), 'x'.repeat(1024 * 1024 + 1))
    const oversizedManager = new PluginManager(oversizedRoot, '1.0.0', async () => true)
    await expect(oversizedManager.init()).rejects.toMatchObject({
      code: 'plugin_legacy_activation_unavailable',
    })
  })
  it.each([
    [
      'too many approvals',
      JSON.stringify({
        approvals: Object.fromEntries(
          Array.from({ length: 1025 }, (_, index) => [
            `apollo-plugin-state-${index}`,
            { version: '1.0.0', permissionHash: 'hash', enabled: true, failures: 0 },
          ]),
        ),
      }),
    ],
    [
      'an invalid approval key',
      JSON.stringify({
        approvals: {
          constructor: { version: '1.0.0', permissionHash: 'hash', enabled: true, failures: 0 },
        },
      }),
    ],
    [
      'an oversized version',
      JSON.stringify({
        approvals: {
          [manifest.name]: {
            version: 'v'.repeat(129),
            permissionHash: 'hash',
            enabled: true,
            failures: 0,
          },
        },
      }),
    ],
    [
      'a terminal-control version',
      JSON.stringify({
        approvals: {
          [manifest.name]: {
            version: '1.0.0\n\u001B[31m',
            permissionHash: 'hash',
            enabled: true,
            failures: 0,
          },
        },
      }),
    ],
    [
      'an oversized permission hash',
      JSON.stringify({
        approvals: {
          [manifest.name]: {
            version: '1.0.0',
            permissionHash: 'h'.repeat(513),
            enabled: true,
            failures: 0,
          },
        },
      }),
    ],
    [
      'a non-finite failure count',
      `{"approvals":{"${manifest.name}":{"version":"1.0.0","permissionHash":"hash","enabled":true,"failures":1e309}}}`,
    ],
    [
      'a negative failure count',
      JSON.stringify({
        approvals: {
          [manifest.name]: {
            version: '1.0.0',
            permissionHash: 'hash',
            enabled: true,
            failures: -1,
          },
        },
      }),
    ],
    [
      'a fractional failure count',
      JSON.stringify({
        approvals: {
          [manifest.name]: {
            version: '1.0.0',
            permissionHash: 'hash',
            enabled: true,
            failures: 1.5,
          },
        },
      }),
    ],
  ])('rejects legacy state containing %s', async (_reason, serialized) => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-state-bounds-'))
    await writeFile(join(root, 'plugins.json'), serialized)
    const manager = new PluginManager(root, '1.0.0', async () => true)

    await expect(manager.init()).rejects.toMatchObject({
      code: 'plugin_legacy_activation_unavailable',
    })
    expect(Object.keys(manager.list())).toEqual([])
  })
  it('rejects invalid failure thresholds and never overflows persisted failure counts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-failure-threshold-'))
    await writeFile(
      join(root, 'plugins.json'),
      JSON.stringify({
        approvals: {
          [manifest.name]: {
            version: manifest.version,
            permissionHash: 'legacy-hash',
            enabled: true,
            failures: 1_000_000,
          },
        },
      }),
    )
    const manager = new PluginManager(root, '1.0.0', async () => true)
    await manager.init()

    for (const threshold of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_000_001])
      await expect(manager.recordFailure(manifest.name, threshold)).rejects.toMatchObject({
        code: 'plugin_legacy_activation_unavailable',
      })

    await expect(manager.recordFailure(manifest.name, 1_000_000)).resolves.toBe(true)
    expect(manager.list()[manifest.name]?.failures).toBe(1_000_000)
    const reloaded = new PluginManager(root, '1.0.0', async () => true)
    await expect(reloaded.init()).resolves.toBeUndefined()
    expect(reloaded.list()[manifest.name]?.failures).toBe(1_000_000)
  })
  it('projects stale enabled legacy records disabled without rewriting state', async () => {
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
    const sentinelTime = new Date('2001-02-03T04:05:06.000Z')
    await utimes(statePath, sentinelTime, sentinelTime)
    const beforeInit = await stat(statePath)
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
    expect(await readFile(statePath, 'utf8')).toBe(initialSerialized)
    expect((await stat(statePath)).mtimeMs).toBe(beforeInit.mtimeMs)
    await manager.init()
    expect(await readFile(statePath, 'utf8')).toBe(initialSerialized)
    expect((await stat(statePath)).mtimeMs).toBe(beforeInit.mtimeMs)
  })
  it('fails malformed production state closed with a stable diagnostic and zero activation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-malformed-state-')),
      dataRoot = await mkdtemp(join(tmpdir(), 'apollo-malformed-state-data-')),
      manager = new PluginManager(root, '1.0.0', async () => true)
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
      { dataRoot },
    )
    await expect(runtime.loadEnabled()).resolves.toEqual([])
  })
  it('does not touch a migration temp path while projecting legacy state disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-no-migration-write-'))
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

    await expect(manager.init()).resolves.toBeUndefined()
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
