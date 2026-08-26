import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { probeSandbox, resolveBinary } from '@apollo-code/native-bridge'
import { PluginError } from '@apollo-code/plugin-runtime'
import { afterEach, describe, expect, it } from 'vitest'

import { createProductionPorts } from './runtime'
import {
  fetchMarketIndex,
  installFromMarket,
  isTrustedMarketSource,
  marketInstallRoot,
  normalizePluginName,
  parseMarketIndex,
  readMarketIntegrity,
  readMarketSource,
  uninstallMarketDir,
  type MarketPluginEntry,
} from './plugin-market'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const dirs: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolveClose) => server.close(resolveClose))
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixtureHome() {
  const home = await mkdtemp(join(tmpdir(), 'apollo-market-'))
  dirs.push(home)
  return home
}

async function sandboxAvailable(): Promise<boolean> {
  // 本地 cargo 构建兜底（开发机）；CI 无沙箱时跳过。
  if (!process.env.APOLLO_NATIVE_SANDBOX_BINARY)
    process.env.APOLLO_NATIVE_SANDBOX_BINARY = join(repoRoot, 'target', 'debug', 'apollo-sandbox')
  try {
    const binary = await resolveBinary('sandbox')
    if (!binary) return false
    return (await probeSandbox()).tier !== 'none'
  } catch {
    return false
  }
}

const helloManifest = {
  name: 'apollo-plugin-hello',
  version: '1.0.0',
  type: 'module',
  main: 'index.mjs',
  engines: { apollo: '^0.1.0' },
  permissions: { apollo: ['commands.register', 'log.write'] },
}
const helloEntry = `export async function activate(apollo) {
  await apollo.commands.register({
    name: 'hello',
    description: 'Say hello from a market plugin',
    handler: async () => 'hello from the market',
  })
  await apollo.log.info('apollo-plugin-hello activated')
}
`
const sha256 = (value: string) => `sha256-${createHash('sha256').update(value).digest('hex')}`

/** 回环 http fixture：索引 + 插件文件。digest 始终按预期内容计算；corrupt 时
 * 伺服被篡改的 index.mjs —— 触发下载校验失败。 */
async function marketServer(options?: { corrupt?: boolean; manifest?: object }) {
  const manifestJson = `${JSON.stringify(options?.manifest ?? helloManifest, null, 2)}\n`
  const servedEntry = options?.corrupt ? '// tampered payload\n' : helloEntry
  const index = {
    schemaVersion: 1,
    plugins: [
      {
        name: 'apollo-plugin-hello',
        version: '1.0.0',
        description: 'Demo market plugin',
        publisher: 'apollo fixtures',
        files: [
          { path: 'manifest.json', digest: sha256(manifestJson) },
          { path: 'index.mjs', digest: sha256(helloEntry) },
        ],
      },
    ],
  }
  const server = createServer((request, response) => {
    const send = (body: string, type = 'application/json') => {
      response.writeHead(200, { 'content-type': type })
      response.end(body)
    }
    if (request.url === '/index.json') return send(`${JSON.stringify(index, null, 2)}\n`)
    if (request.url === '/apollo-plugin-hello/manifest.json')
      return send(manifestJson, 'application/json')
    if (request.url === '/apollo-plugin-hello/index.mjs')
      return send(servedEntry, 'text/javascript')
    response.writeHead(404)
    response.end('not found')
  })
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
  servers.push(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no fixture port')
  return `http://127.0.0.1:${address.port}/index.json`
}

async function marketEntry(source: string): Promise<MarketPluginEntry> {
  const index = await fetchMarketIndex(source)
  const entry = index.plugins.find((plugin) => plugin.name === 'apollo-plugin-hello')
  if (!entry) throw new Error('fixture entry missing')
  return entry
}

describe('isTrustedMarketSource（市场源信任）', () => {
  it('accepts canonical https and loopback http, rejects everything else', () => {
    expect(isTrustedMarketSource('https://registry.example/index.json')).toBe(true)
    expect(isTrustedMarketSource('http://127.0.0.1:8080/index.json')).toBe(true)
    expect(isTrustedMarketSource('http://localhost:8080/index.json')).toBe(true)
    expect(isTrustedMarketSource('http://192.168.1.5/index.json')).toBe(false)
    expect(isTrustedMarketSource('https://user:pass@registry.example/index.json')).toBe(false)
    expect(isTrustedMarketSource('https://registry.example/index.json?x=1')).toBe(false)
    expect(isTrustedMarketSource('not a url')).toBe(false)
  })
})

describe('readMarketSource（[plugins] market 配置）', () => {
  it('returns undefined without config and the URL when configured', async () => {
    const home = await fixtureHome()
    await expect(readMarketSource(home)).resolves.toBeUndefined()
    await writeFile(
      join(home, 'config.toml'),
      '[plugins]\nmarket = "https://registry.example/index.json"\n',
    )
    await expect(readMarketSource(home)).resolves.toBe('https://registry.example/index.json')
  })
  it('throws config_invalid for malformed values', async () => {
    const home = await fixtureHome()
    await writeFile(join(home, 'config.toml'), '[plugins]\nmarket = "ftp://bad"\n')
    await expect(readMarketSource(home)).rejects.toThrow('config_invalid')
    await writeFile(join(home, 'config.toml'), '[plugins]\nmarket = 42\n')
    await expect(readMarketSource(home)).rejects.toThrow(/plugins.market/)
  })
})

describe('parseMarketIndex（索引形状校验）', () => {
  it('rejects structural violations', () => {
    expect(() => parseMarketIndex({ schemaVersion: 2, plugins: [] })).toThrow(PluginError)
    expect(() => parseMarketIndex({ schemaVersion: 1 })).toThrow(PluginError)
    expect(() =>
      parseMarketIndex({
        schemaVersion: 1,
        plugins: [{ name: 'not-prefixed', version: '1.0.0', files: [] }],
      }),
    ).toThrow(/unsafe plugin name/)
    expect(() =>
      parseMarketIndex({
        schemaVersion: 1,
        plugins: [
          {
            name: 'apollo-plugin-x',
            version: '1.0.0',
            files: [{ path: '../escape.mjs', digest: sha256('x') }],
          },
        ],
      }),
    ).toThrow(/path\/digest/)
    expect(() =>
      parseMarketIndex({
        schemaVersion: 1,
        plugins: [
          {
            name: 'apollo-plugin-x',
            version: '1.0.0',
            files: [{ path: 'index.mjs', digest: 'md5-abc' }],
          },
        ],
      }),
    ).toThrow(/path\/digest/)
    expect(() =>
      parseMarketIndex({
        schemaVersion: 1,
        plugins: [
          {
            name: 'apollo-plugin-x',
            version: '1.0.0',
            files: [{ path: 'a.mjs', digest: sha256('a') }],
          },
        ],
      }),
    ).toThrow(/no manifest\.json/)
    expect(() =>
      parseMarketIndex({
        schemaVersion: 1,
        plugins: [
          {
            name: 'apollo-plugin-x',
            version: '1.0.0',
            files: [
              { path: 'manifest.json', digest: sha256('m') },
              { path: 'manifest.json', digest: sha256('m') },
            ],
          },
        ],
      }),
    ).toThrow(/duplicate file path/)
  })
})

describe('installFromMarket（安装链路）', () => {
  it('downloads, verifies digests, and lands in ~/.apollo/plugins/<name>/', async () => {
    const home = await fixtureHome()
    const source = await marketServer()
    const entry = await marketEntry(source)
    const installed = await installFromMarket({ home, source, entry, apolloVersion: '0.1.0' })
    expect(installed.name).toBe('apollo-plugin-hello')
    expect(installed.dir).toBe(join(marketInstallRoot(home), 'apollo-plugin-hello'))
    const manifest = JSON.parse(await readFile(join(installed.dir, 'manifest.json'), 'utf8'))
    expect(manifest.name).toBe('apollo-plugin-hello')
    // 安装元数据落盘，装载期完整性映射可读
    const integrity = await readMarketIntegrity(installed.dir)
    expect(Object.keys(integrity).sort()).toEqual(['index.mjs', 'manifest.json'])
    // staging 清理干净
    const leftovers = (await readdir(marketInstallRoot(home))).filter((name) =>
      name.startsWith('.staging-'),
    )
    expect(leftovers).toEqual([])
  })

  it('refuses a digest mismatch, cleans staging, and leaves no target dir', async () => {
    const home = await fixtureHome()
    const source = await marketServer({ corrupt: true })
    const entry = await marketEntry(source)
    await expect(installFromMarket({ home, source, entry, apolloVersion: '0.1.0' })).rejects.toThrow(
      /digest mismatch/,
    )
    const root = marketInstallRoot(home)
    expect((await readdir(root)).filter((name) => name !== 'plugins.json')).toEqual([])
  })

  it('rejects engine-incompatible manifests from the index', async () => {
    const home = await fixtureHome()
    const source = await marketServer({
      manifest: { ...helloManifest, engines: { apollo: '^9.0.0' } },
    })
    const entry = await marketEntry(source)
    await expect(installFromMarket({ home, source, entry, apolloVersion: '0.1.0' })).rejects.toThrow(
      /does not satisfy/,
    )
  })

  it('replaces an existing install and uninstalls market plugins only', async () => {
    const home = await fixtureHome()
    const source = await marketServer()
    const entry = await marketEntry(source)
    await installFromMarket({ home, source, entry, apolloVersion: '0.1.0' })
    // 再装一遍 = 换新（目录重建）
    await installFromMarket({ home, source, entry, apolloVersion: '0.1.0' })
    await uninstallMarketDir(home, 'apollo-plugin-hello')
    await expect(
      readMarketIntegrity(join(marketInstallRoot(home), 'apollo-plugin-hello')),
    ).resolves.toEqual({})
    // 非 market 目录（手放的）不允许 uninstall
    await mkdir(join(marketInstallRoot(home), 'apollo-plugin-plain'), { recursive: true })
    await expect(uninstallMarketDir(home, 'apollo-plugin-plain')).rejects.toThrow(
      'plugin_not_installed',
    )
  })

  it('normalizes bare short names', () => {
    expect(normalizePluginName('hello')).toBe('apollo-plugin-hello')
    expect(normalizePluginName('apollo-plugin-hello')).toBe('apollo-plugin-hello')
  })
})

describe('loadMarketPlugins（启动自动装载）', () => {
  it('skips dot dirs and non-plugin dirs; re-verifies digests on activation', async () => {
    const home = await fixtureHome()
    const root = marketInstallRoot(home)
    // 无 manifest 的目录 + dot 目录：跳过
    await mkdir(join(root, 'not-a-plugin'), { recursive: true })
    await mkdir(join(root, '.staging-leftover'), { recursive: true })
    // 带元数据但被篡改的插件：verifyBundle 在沙箱启动前拒载
    const pluginDir = join(root, 'apollo-plugin-hello')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, 'manifest.json'), `${JSON.stringify(helloManifest, null, 2)}\n`)
    await writeFile(join(pluginDir, 'index.mjs'), helloEntry)
    await writeFile(
      join(pluginDir, 'apollo-market.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          name: 'apollo-plugin-hello',
          version: '1.0.0',
          source: 'https://registry.example/index.json',
          installedAt: '2026-08-25T00:00:00.000Z',
          files: [
            { path: 'manifest.json', digest: sha256('tampered') },
            { path: 'index.mjs', digest: sha256('tampered') },
          ],
        },
        null,
        2,
      )}\n`,
    )
    const ports = createProductionPorts({ apolloHome: home, identity: { version: '0.1.0' } })
    const { loaded, failed } = await ports.localPlugins!.loadMarketPlugins()
    expect(loaded).toEqual([])
    expect(failed).toHaveLength(1)
    expect(failed[0]!.dir).toContain('apollo-plugin-hello')
    expect(failed[0]!.error).toContain('integrity mismatch')
    await ports.localPlugins!.deactivateAll()
  })

  it('loads an intact market plugin through the sandbox chain (e2e)', async () => {
    if (!(await sandboxAvailable())) {
      console.warn('sandbox unavailable; skipping market load e2e')
      return
    }
    const home = await fixtureHome()
    const source = await marketServer()
    const entry = await marketEntry(source)
    await installFromMarket({ home, source, entry, apolloVersion: '0.1.0' })
    const ports = createProductionPorts({ apolloHome: home, identity: { version: '0.1.0' } })
    try {
      const { loaded, failed } = await ports.localPlugins!.loadMarketPlugins()
      expect(failed).toEqual([])
      expect(loaded).toEqual([{ name: 'apollo-plugin-hello', statusTabs: 0 }])
    } finally {
      await ports.localPlugins!.deactivateAll()
    }
  }, 30_000)

  it('hot-uninstalls a loaded market plugin: deactivates, removes the dir, and skips on reload', async () => {
    if (!(await sandboxAvailable())) {
      console.warn('sandbox unavailable; skipping hot uninstall e2e')
      return
    }
    const home = await fixtureHome()
    const source = await marketServer()
    const entry = await marketEntry(source)
    await installFromMarket({ home, source, entry, apolloVersion: '0.1.0' })
    const ports = createProductionPorts({ apolloHome: home, identity: { version: '0.1.0' } })
    try {
      const first = await ports.localPlugins!.loadMarketPlugins()
      expect(first.loaded).toEqual([{ name: 'apollo-plugin-hello', statusTabs: 0 }])
      // 热：已装载（沙箱进程活着）状态下卸载——停用 + 删目录，同会话生效
      await expect(ports.localPlugins!.uninstallMarketPlugin('hello')).resolves.toEqual({
        name: 'apollo-plugin-hello',
      })
      await expect(readdir(join(marketInstallRoot(home), 'apollo-plugin-hello'))).rejects.toMatchObject(
        { code: 'ENOENT' },
      )
      const second = await ports.localPlugins!.loadMarketPlugins()
      expect(second.loaded).toEqual([])
      expect(second.failed).toEqual([])
    } finally {
      await ports.localPlugins!.deactivateAll()
    }
  }, 30_000)

  it('rejects uninstalling builtin and dev plugins with explicit reasons', async () => {
    if (!(await sandboxAvailable())) {
      console.warn('sandbox unavailable; skipping uninstall rejection e2e')
      return
    }
    const home = await fixtureHome()
    // dev 插件：plugins-dev 约定目录放一个最小插件
    const devDir = join(home, 'plugins-dev', 'apollo-plugin-hello')
    await mkdir(devDir, { recursive: true })
    await writeFile(join(devDir, 'manifest.json'), `${JSON.stringify(helloManifest, null, 2)}\n`)
    await writeFile(join(devDir, 'index.mjs'), helloEntry)
    const ports = createProductionPorts({ apolloHome: home, identity: { version: '0.1.0' } })
    try {
      const builtin = await ports.localPlugins!.loadBuiltinPlugins()
      expect(builtin.failed).toEqual([])
      await expect(ports.localPlugins!.uninstallMarketPlugin('apollo-plugin-env')).rejects.toThrow(
        /builtin plugin.*cannot be uninstalled/,
      )
      const dev = await ports.localPlugins!.loadDevPlugins()
      expect(dev.loaded.map((item) => item.name)).toEqual(['apollo-plugin-hello'])
      await expect(ports.localPlugins!.uninstallMarketPlugin('hello')).rejects.toThrow(
        /dev plugin.*remove its directory and restart/,
      )
      // 目录原样保留（卸载不碰 dev 目录）
      await expect(readFile(join(devDir, 'manifest.json'), 'utf8')).resolves.toContain(
        'apollo-plugin-hello',
      )
    } finally {
      await ports.localPlugins!.deactivateAll()
    }
  }, 30_000)
})
