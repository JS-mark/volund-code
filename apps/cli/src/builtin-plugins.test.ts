import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { probeSandbox, resolveBinary } from '@apollo-code/native-bridge'
import { activateLocalPlugin, type ActivatedLocalPlugin } from '@apollo-code/plugin-runtime'
import { afterEach, describe, expect, it } from 'vitest'

import { builtinPluginRoot, createProductionPorts, readEffectiveEnv } from './runtime'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const envPluginDir = join(repoRoot, 'apps', 'cli', 'plugins', 'apollo-plugin-env')

const dirs: string[] = []
const handles: ActivatedLocalPlugin[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.deactivate()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

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

describe('builtinPluginRoot（内置插件目录解析）', () => {
  it('resolves apps/cli/plugins from the source layout', () => {
    const previous = process.env.APOLLO_STANDALONE_ASSET_DIR
    delete process.env.APOLLO_STANDALONE_ASSET_DIR
    try {
      expect(builtinPluginRoot()).toBe(join(repoRoot, 'apps', 'cli', 'plugins'))
    } finally {
      if (previous !== undefined) process.env.APOLLO_STANDALONE_ASSET_DIR = previous
    }
  })

  it('prefers APOLLO_STANDALONE_ASSET_DIR/plugins when it exists', async () => {
    const assets = await mkdtemp(join(tmpdir(), 'apollo-standalone-assets-'))
    dirs.push(assets)
    await mkdir(join(assets, 'plugins'), { recursive: true })
    const previous = process.env.APOLLO_STANDALONE_ASSET_DIR
    process.env.APOLLO_STANDALONE_ASSET_DIR = assets
    try {
      expect(builtinPluginRoot()).toBe(join(assets, 'plugins'))
    } finally {
      if (previous === undefined) delete process.env.APOLLO_STANDALONE_ASSET_DIR
      else process.env.APOLLO_STANDALONE_ASSET_DIR = previous
    }
  })
})

describe('apollo-plugin-env（内置 /env，沙箱端到端）', () => {
  it('activates through loadBuiltinPlugins and answers /env across the bridge', async () => {
    if (!(await sandboxAvailable())) {
      console.warn('sandbox unavailable; skipping builtin plugin e2e')
      return
    }
    const home = await mkdtemp(join(tmpdir(), 'apollo-builtin-env-'))
    dirs.push(home)
    await writeFile(
      join(home, 'config.toml'),
      '[env]\nAPOLLO_E2E_ENV = "wired-through-config"\n[tools]\npass_through_env = ["APOLLO_E2E_ENV"]\n',
    )
    const ports = createProductionPorts({ apolloHome: home, identity: { version: '0.1.0' } })
    const { loaded, failed } = await ports.localPlugins!.loadBuiltinPlugins()
    try {
      expect(failed).toEqual([])
      // 目录发现顺序依文件系统而定，按名排序断言
      expect(loaded.map((item) => item.name).sort()).toEqual([
        'apollo-plugin-env',
        'apollo-plugin-manager',
      ])
    } finally {
      await ports.localPlugins!.deactivateAll()
    }
  }, 30_000)
  it('formats effective / pending / passthrough states as a list view for the /env panel', async () => {
    if (!(await sandboxAvailable())) return
    const home = await mkdtemp(join(tmpdir(), 'apollo-builtin-env-output-'))
    dirs.push(home)
    await writeFile(
      join(home, 'config.toml'),
      '[env]\nAPOLLO_E2E_EFFECTIVE = "yes"\nAPOLLO_E2E_PENDING = "later"\n[tools]\npass_through_env = ["APOLLO_E2E_EFFECTIVE"]\n',
    )
    const previousEffective = process.env.APOLLO_E2E_EFFECTIVE
    const previousPending = process.env.APOLLO_E2E_PENDING
    process.env.APOLLO_E2E_EFFECTIVE = 'yes'
    delete process.env.APOLLO_E2E_PENDING
    const dataDir = await mkdtemp(join(tmpdir(), 'apollo-plugin-data-'))
    dirs.push(dataDir)
    try {
      const activated = await activateLocalPlugin({
        dir: envPluginDir,
        apolloVersion: '0.1.0',
        dataDirRoot: dataDir,
        services: { getEffectiveEnv: () => readEffectiveEnv(home) },
      })
      handles.push(activated)
      expect(activated.manifest.name).toBe('apollo-plugin-env')
      const command = activated.commands.find((candidate) => candidate.name === 'env')
      expect(command).toBeDefined()
      const output = await command!.run([])
      // 面板输出是纯数据描述符：UI 渲染成可搜索列表（resume 风格）
      expect(output).toMatchObject({ kind: 'list', title: expect.stringContaining('[env]') })
      const view = output as {
        entries: { id: string; value?: string; status?: string; detail?: string }[]
      }
      const effective = view.entries.find((entry) => entry.id === 'APOLLO_E2E_EFFECTIVE')
      expect(effective).toMatchObject({
        value: 'yes',
        status: 'effective · sandbox: passed through',
      })
      expect(effective?.detail).toContain('APOLLO_E2E_EFFECTIVE = "yes"')
      const pending = view.entries.find((entry) => entry.id === 'APOLLO_E2E_PENDING')
      expect(pending?.status).toContain('pending')
      expect(pending?.detail).toContain('not present in process.env')
    } finally {
      if (previousEffective === undefined) delete process.env.APOLLO_E2E_EFFECTIVE
      else process.env.APOLLO_E2E_EFFECTIVE = previousEffective
      if (previousPending !== undefined) process.env.APOLLO_E2E_PENDING = previousPending
    }
  }, 30_000)

  it('prints setup guidance when no [env] section is configured', async () => {
    if (!(await sandboxAvailable())) return
    const home = await mkdtemp(join(tmpdir(), 'apollo-builtin-env-empty-'))
    dirs.push(home)
    const dataDir = await mkdtemp(join(tmpdir(), 'apollo-plugin-data-'))
    dirs.push(dataDir)
    const activated = await activateLocalPlugin({
      dir: envPluginDir,
      apolloVersion: '0.1.0',
      dataDirRoot: dataDir,
      services: { getEffectiveEnv: () => readEffectiveEnv(home) },
    })
    handles.push(activated)
    const output = (await activated.commands[0]!.run([])) as string
    expect(output).toContain('No [env] variables configured')
    expect(output).toContain('pass_through_env')
  }, 30_000)
})

describe('apollo-plugin-manager（内置 /plugins，沙箱端到端）', () => {
  const managerDir = join(repoRoot, 'apps', 'cli', 'plugins', 'apollo-plugin-manager')

  async function activateManager(
    home: string,
    services: Parameters<typeof activateLocalPlugin>[0]['services'],
  ) {
    const activated = await activateLocalPlugin({
      dir: managerDir,
      apolloVersion: '0.1.0',
      dataDirRoot: join(home, 'plugins-dev-data'),
      services,
    })
    handles.push(activated)
    const command = activated.commands.find((candidate) => candidate.name === 'plugins')
    expect(command).toBeDefined()
    return command!
  }

  it('answers /plugins with a three-tab view of the loaded inventory', async () => {
    if (!(await sandboxAvailable())) {
      console.warn('sandbox unavailable; skipping /plugins e2e')
      return
    }
    const home = await mkdtemp(join(tmpdir(), 'apollo-manager-tabs-'))
    dirs.push(home)
    const command = await activateManager(home, {
      listPlugins: async () => ({
        builtin: [
          {
            name: 'apollo-plugin-env',
            version: '0.1.0',
            dir: '/opt/apollo/plugins/apollo-plugin-env',
            source: 'builtin',
            commands: 1,
            statusTabs: 0,
          },
        ],
        dev: [],
        market: {
          installed: [],
          registry: { error: 'no market configured — add `[plugins] market = "…"`' },
        },
      }),
    })
    const view = (await command.run([])) as {
      kind: string
      title: string
      tabs: { id: string; entries: { id: string }[] }[]
    }
    expect(view.kind).toBe('tabs')
    expect(view.title).toContain('Plugins')
    expect(view.tabs.map((tab) => tab.id)).toEqual(['builtin', 'dev', 'market'])
    expect(view.tabs[0]!.entries.map((entry) => entry.id)).toEqual(['apollo-plugin-env'])
    // dev 空态给指引条目；market 未配置给配置指引
    expect(view.tabs[1]!.entries[0]!.id).toBe('__dev_empty')
    expect(view.tabs[2]!.entries[0]!.id).toBe('__market_unavailable')
  }, 30_000)

  it('reports guidance when installing without a configured market', async () => {
    if (!(await sandboxAvailable())) return
    const home = await mkdtemp(join(tmpdir(), 'apollo-manager-install-'))
    dirs.push(home)
    const command = await activateManager(home, {
      installMarketPlugin: async () => {
        throw new Error('no market configured — set [plugins] market in ~/.apollo/config.toml')
      },
    })
    const output = (await command.run(['install', 'hello'])) as string
    expect(output).toContain('/plugins install failed')
    expect(output).toContain('no market configured')
  }, 30_000)

  it('hot-uninstall reports success, and builtin/dev rejections carry explicit reasons', async () => {
    if (!(await sandboxAvailable())) return
    const home = await mkdtemp(join(tmpdir(), 'apollo-manager-uninstall-'))
    dirs.push(home)
    const uninstall = await activateManager(home, {
      uninstallMarketPlugin: async () => ({ name: 'apollo-plugin-hello' }),
    })
    expect(await uninstall.run(['uninstall', 'hello'])).toContain(
      'Uninstalled apollo-plugin-hello',
    )
    const rejecting = await activateManager(home, {
      uninstallMarketPlugin: async () => {
        throw new Error(
          'apollo-plugin-env is a builtin plugin shipped with the Apollo artifact; it cannot be uninstalled',
        )
      },
    })
    const output = (await rejecting.run(['uninstall', 'env'])) as string
    expect(output).toContain('/plugins uninstall failed')
    expect(output).toContain('builtin plugin')
    expect(output).toContain('cannot be uninstalled')
  }, 30_000)
})
