import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { probeSandbox, resolveBinary } from '@volund/native-bridge'
import { PermissionManager } from '@volund/permission'
import { activateLocalPlugin, type ActivatedLocalPlugin } from '@volund/plugin-runtime'
import type { Tool } from '@volund/tool-kit'
import { ToolExecutor } from '@volund/tools'
import { afterEach, describe, expect, it } from 'vitest'

import {
  builtinPluginRoot,
  createPluginHookDispatcher,
  createProductionPorts,
  readEffectiveEnv,
} from './runtime'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const envPluginDir = join(repoRoot, 'apps', 'cli', 'plugins', 'volund-plugin-env')

const dirs: string[] = []
const handles: ActivatedLocalPlugin[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.deactivate()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function sandboxAvailable(): Promise<boolean> {
  // 本地 cargo 构建兜底（开发机）；CI 无沙箱时跳过。
  if (!process.env.VOLUND_NATIVE_SANDBOX_BINARY)
    process.env.VOLUND_NATIVE_SANDBOX_BINARY = join(repoRoot, 'target', 'debug', 'volund-sandbox')
  try {
    const binary = await resolveBinary('sandbox')
    if (!binary) return false
    return (await probeSandbox()).tier !== 'none'
  } catch {
    return false
  }
}

const execFileAsync = promisify(execFile)

/** 当前（vitest worker）进程的直接子进程数——插件宿主存活的可观测代理。 */
async function childProcessCount(): Promise<number> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-P', String(process.pid)])
    return stdout.trim().split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

describe('builtinPluginRoot（内置插件目录解析）', () => {
  it('resolves apps/cli/plugins from the source layout', () => {
    const previous = process.env.VOLUND_STANDALONE_ASSET_DIR
    delete process.env.VOLUND_STANDALONE_ASSET_DIR
    try {
      expect(builtinPluginRoot()).toBe(join(repoRoot, 'apps', 'cli', 'plugins'))
    } finally {
      if (previous !== undefined) process.env.VOLUND_STANDALONE_ASSET_DIR = previous
    }
  })

  it('prefers VOLUND_STANDALONE_ASSET_DIR/plugins when it exists', async () => {
    const assets = await mkdtemp(join(tmpdir(), 'volund-standalone-assets-'))
    dirs.push(assets)
    await mkdir(join(assets, 'plugins'), { recursive: true })
    const previous = process.env.VOLUND_STANDALONE_ASSET_DIR
    process.env.VOLUND_STANDALONE_ASSET_DIR = assets
    try {
      expect(builtinPluginRoot()).toBe(join(assets, 'plugins'))
    } finally {
      if (previous === undefined) delete process.env.VOLUND_STANDALONE_ASSET_DIR
      else process.env.VOLUND_STANDALONE_ASSET_DIR = previous
    }
  })
})

describe('volund-plugin-env（内置 /env，沙箱端到端）', () => {
  it('activates through loadBuiltinPlugins and answers /env across the bridge', async () => {
    if (!(await sandboxAvailable())) {
      console.warn('sandbox unavailable; skipping builtin plugin e2e')
      return
    }
    const home = await mkdtemp(join(tmpdir(), 'volund-builtin-env-'))
    dirs.push(home)
    await writeFile(
      join(home, 'config.toml'),
      '[env]\nVOLUND_E2E_ENV = "wired-through-config"\n[tools]\npass_through_env = ["VOLUND_E2E_ENV"]\n',
    )
    const ports = createProductionPorts({ volundHome: home, identity: { version: '0.1.0' } })
    const { loaded, failed } = await ports.localPlugins!.loadBuiltinPlugins()
    try {
      expect(failed).toEqual([])
      // 目录发现顺序依文件系统而定，按名排序断言
      expect(loaded.map((item) => item.name).sort()).toEqual([
        'volund-plugin-env',
        'volund-plugin-manager',
      ])
    } finally {
      await ports.localPlugins!.deactivateAll()
    }
  }, 30_000)
  it('formats effective / pending / passthrough states as a list view for the /env panel', async () => {
    if (!(await sandboxAvailable())) return
    const home = await mkdtemp(join(tmpdir(), 'volund-builtin-env-output-'))
    dirs.push(home)
    await writeFile(
      join(home, 'config.toml'),
      '[env]\nVOLUND_E2E_EFFECTIVE = "yes"\nVOLUND_E2E_PENDING = "later"\n[tools]\npass_through_env = ["VOLUND_E2E_EFFECTIVE"]\n',
    )
    const previousEffective = process.env.VOLUND_E2E_EFFECTIVE
    const previousPending = process.env.VOLUND_E2E_PENDING
    process.env.VOLUND_E2E_EFFECTIVE = 'yes'
    delete process.env.VOLUND_E2E_PENDING
    const dataDir = await mkdtemp(join(tmpdir(), 'volund-plugin-data-'))
    dirs.push(dataDir)
    try {
      const activated = await activateLocalPlugin({
        dir: envPluginDir,
        volundVersion: '0.1.0',
        dataDirRoot: dataDir,
        services: { getEffectiveEnv: () => readEffectiveEnv(home) },
      })
      handles.push(activated)
      expect(activated.manifest.name).toBe('volund-plugin-env')
      const command = activated.commands.find((candidate) => candidate.name === 'env')
      expect(command).toBeDefined()
      const output = await command!.run([])
      // 面板输出是纯数据描述符：UI 渲染成可搜索列表（resume 风格）
      expect(output).toMatchObject({ kind: 'list', title: expect.stringContaining('[env]') })
      const view = output as {
        entries: { id: string; value?: string; status?: string; detail?: string }[]
      }
      const effective = view.entries.find((entry) => entry.id === 'VOLUND_E2E_EFFECTIVE')
      expect(effective).toMatchObject({
        value: 'yes',
        status: 'effective · sandbox: passed through',
      })
      expect(effective?.detail).toContain('VOLUND_E2E_EFFECTIVE = "yes"')
      const pending = view.entries.find((entry) => entry.id === 'VOLUND_E2E_PENDING')
      expect(pending?.status).toContain('pending')
      expect(pending?.detail).toContain('not present in process.env')
    } finally {
      if (previousEffective === undefined) delete process.env.VOLUND_E2E_EFFECTIVE
      else process.env.VOLUND_E2E_EFFECTIVE = previousEffective
      if (previousPending !== undefined) process.env.VOLUND_E2E_PENDING = previousPending
    }
  })

  it('exposes the effective-env tool contribution across the bridge (G 插件一等公民)', async () => {
    if (!(await sandboxAvailable())) return
    const home = await mkdtemp(join(tmpdir(), 'volund-builtin-env-tool-'))
    dirs.push(home)
    await writeFile(join(home, 'config.toml'), '[env]\nVOLUND_E2E_TOOL = "structured"\n')
    process.env.VOLUND_E2E_TOOL = 'structured'
    const dataDir = await mkdtemp(join(tmpdir(), 'volund-plugin-data-'))
    dirs.push(dataDir)
    try {
      const activated = await activateLocalPlugin({
        dir: envPluginDir,
        volundVersion: '0.1.0',
        dataDirRoot: dataDir,
        services: { getEffectiveEnv: () => readEffectiveEnv(home) },
      })
      handles.push(activated)
      const tool = activated.tools.find(
        (candidate) => candidate.name === 'plugin:volund-plugin-env:effective-env',
      )
      expect(tool).toBeDefined()
      expect(tool!.inputSchema).toMatchObject({ type: 'object' })
      const raw = (await tool!.invoke({})) as {
        count: number
        variables: { name: string; configured: string; status: string }[]
      }
      const entry = raw.variables.find((variable) => variable.name === 'VOLUND_E2E_TOOL')
      expect(entry).toMatchObject({ configured: 'structured', status: 'effective' })
    } finally {
      delete process.env.VOLUND_E2E_TOOL
    }
  }, 30_000)

  it('prints setup guidance when no [env] section is configured', async () => {
    if (!(await sandboxAvailable())) return
    const home = await mkdtemp(join(tmpdir(), 'volund-builtin-env-empty-'))
    dirs.push(home)
    const dataDir = await mkdtemp(join(tmpdir(), 'volund-plugin-data-'))
    dirs.push(dataDir)
    const activated = await activateLocalPlugin({
      dir: envPluginDir,
      volundVersion: '0.1.0',
      dataDirRoot: dataDir,
      services: { getEffectiveEnv: () => readEffectiveEnv(home) },
    })
    handles.push(activated)
    const output = (await activated.commands[0]!.run([])) as string
    expect(output).toContain('No [env] variables configured')
    expect(output).toContain('pass_through_env')
  }, 30_000)
})

describe('volund-plugin-manager（内置 /plugins，沙箱端到端）', () => {
  const managerDir = join(repoRoot, 'apps', 'cli', 'plugins', 'volund-plugin-manager')

  async function activateManager(
    home: string,
    services: Parameters<typeof activateLocalPlugin>[0]['services'],
  ) {
    const activated = await activateLocalPlugin({
      dir: managerDir,
      volundVersion: '0.1.0',
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
    const home = await mkdtemp(join(tmpdir(), 'volund-manager-tabs-'))
    dirs.push(home)
    const command = await activateManager(home, {
      listPlugins: async () => ({
        builtin: [
          {
            name: 'volund-plugin-env',
            version: '0.1.0',
            dir: '/opt/volund/plugins/volund-plugin-env',
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
    expect(view.tabs[0]!.entries.map((entry) => entry.id)).toEqual(['volund-plugin-env'])
    // dev 空态给指引条目；market 未配置给配置指引
    expect(view.tabs[1]!.entries[0]!.id).toBe('__dev_empty')
    expect(view.tabs[2]!.entries[0]!.id).toBe('__market_unavailable')
  }, 30_000)

  it('reports guidance when installing without a configured market', async () => {
    if (!(await sandboxAvailable())) return
    const home = await mkdtemp(join(tmpdir(), 'volund-manager-install-'))
    dirs.push(home)
    const command = await activateManager(home, {
      installMarketPlugin: async () => {
        throw new Error('no market configured — set [plugins] market in ~/.volund/config.toml')
      },
    })
    const output = (await command.run(['install', 'hello'])) as string
    expect(output).toContain('/plugins install failed')
    expect(output).toContain('no market configured')
  }, 30_000)

  it('keeps installs inactive and requires the exact inspect/approve/enable sequence', async () => {
    if (!(await sandboxAvailable())) return
    const home = await mkdtemp(join(tmpdir(), 'volund-manager-lifecycle-'))
    dirs.push(home)
    const hash = 'a'.repeat(64)
    const calls: string[] = []
    const entry = {
      name: 'volund-plugin-hello',
      version: '1.0.0',
      dir: join(home, 'plugins', 'volund-plugin-hello'),
      source: 'market' as const,
      commands: 0,
      statusTabs: 0,
      lifecycle: { permissionHash: hash, approved: false, enabled: false, loaded: false },
      permissions: { volund: ['log.write'] },
    }
    const command = await activateManager(home, {
      installMarketPlugin: async () => ({
        name: entry.name,
        version: entry.version,
        dir: entry.dir,
        permissionHash: hash,
        approvalRequired: true,
        permissions: entry.permissions,
      }),
      inspectPlugin: async () => entry,
      approvePlugin: async (name, permissionHash) => {
        calls.push(`approve:${name}:${permissionHash}`)
        return { ...entry, lifecycle: { ...entry.lifecycle, approved: true } }
      },
      enablePlugin: async (name) => {
        calls.push(`enable:${name}`)
        return {
          ...entry,
          lifecycle: { ...entry.lifecycle, approved: true, enabled: true, loaded: true },
        }
      },
    })
    const installed = (await command.run(['install', 'hello'])) as string
    expect(installed).toContain('The plugin is not active')
    expect(installed).toContain(hash)
    expect(await command.run(['approve', 'hello'])).toContain('Approval requires')
    expect(await command.run(['approve', 'hello', hash])).toContain('remains disabled')
    expect(await command.run(['enable', 'hello'])).toContain('now active')
    expect(calls).toEqual([`approve:hello:${hash}`, 'enable:hello'])
  }, 30_000)

  it('hot-uninstall reports success, and builtin/dev rejections carry explicit reasons', async () => {
    if (!(await sandboxAvailable())) return
    const home = await mkdtemp(join(tmpdir(), 'volund-manager-uninstall-'))
    dirs.push(home)
    const uninstall = await activateManager(home, {
      uninstallMarketPlugin: async () => ({ name: 'volund-plugin-hello' }),
    })
    expect(await uninstall.run(['uninstall', 'hello'])).toContain('Uninstalled volund-plugin-hello')
    const rejecting = await activateManager(home, {
      uninstallMarketPlugin: async () => {
        throw new Error(
          'volund-plugin-env is a builtin plugin shipped with the Volund artifact; it cannot be uninstalled',
        )
      },
    })
    const output = (await rejecting.run(['uninstall', 'env'])) as string
    expect(output).toContain('/plugins uninstall failed')
    expect(output).toContain('builtin plugin')
    expect(output).toContain('cannot be uninstalled')
  }, 30_000)
})

describe('production ports shutdown（进程收尾）', () => {
  it('resolves cleanly and idempotently with nothing loaded', async () => {
    const home = await mkdtemp(join(tmpdir(), 'volund-shutdown-idle-'))
    dirs.push(home)
    const ports = createProductionPorts({ volundHome: home, identity: { version: '0.1.0' } })
    await ports.shutdown!()
    await ports.shutdown!()
  })

  it('terminates plugin sandbox hosts so the event loop can drain', async () => {
    if (!(await sandboxAvailable())) return
    const home = await mkdtemp(join(tmpdir(), 'volund-shutdown-'))
    dirs.push(home)
    const ports = createProductionPorts({ volundHome: home, identity: { version: '0.1.0' } })
    const { loaded, failed } = await ports.localPlugins!.loadBuiltinPlugins()
    expect(failed).toEqual([])
    expect(loaded.length).toBeGreaterThan(0)
    // 插件宿主的 fd3 管道/子进程 ref 住事件循环；shutdown 必须把它们收掉，
    // 否则 /exit 之后进程悬挂（macOS/Linux 通用，pgrep 退出码 1 = 无子进程）。
    expect(await childProcessCount()).toBeGreaterThan(0)
    await ports.shutdown!()
    expect(await childProcessCount()).toBe(0)
  }, 30_000)
})

describe('plugin hooks e2e（H1：沙箱订阅 preToolUse → veto 真的拦下工具）', () => {
  async function hookPluginFixture() {
    const dir = await mkdtemp(join(tmpdir(), 'volund-plugin-hooktest-'))
    dirs.push(dir)
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({
        name: 'volund-plugin-hooktest',
        version: '0.1.0',
        type: 'module',
        main: 'index.mjs',
        engines: { volund: '^0.1.0' },
        permissions: { volund: ['hooks.on', 'log.write'] },
      }),
    )
    await writeFile(
      join(dir, 'index.mjs'),
      [
        'export async function activate(volund) {',
        "  await volund.hooks.on('preToolUse', (payload) => {",
        "    if (payload?.tool === 'Bash' && payload?.input?.command === 'rm -rf /')",
        "      return { veto: true, reason: 'hooktest: catastrophic command blocked' }",
        '    return undefined',
        '  })',
        '}',
      ].join('\n'),
    )
    const dataDir = await mkdtemp(join(tmpdir(), 'volund-plugin-hookdata-'))
    dirs.push(dataDir)
    const activated = await activateLocalPlugin({
      dir,
      volundVersion: '0.1.0',
      dataDirRoot: dataDir,
      services: {},
    })
    handles.push(activated)
    return activated
  }

  let executed = false
  const probeTool: Tool = {
    name: 'Bash',
    description: 'probe',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
    permissionSpec: () => ({}),
    invoke: async () => {
      executed = true
      return { content: [{ type: 'text', text: 'ran' }] }
    },
  }
  const contextFactory = (signal: AbortSignal) => ({
    abortSignal: signal,
    session: { id: 's', cwd: process.cwd(), turnId: 't' },
    native: { execute: async () => '' },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    ui: { requestInput: async () => '' },
  })
  const executorFor = (activated: ActivatedLocalPlugin) =>
    new ToolExecutor(
      new PermissionManager({ globalAllow: () => true }),
      contextFactory,
      createPluginHookDispatcher([{ name: activated.manifest.name, handle: activated }], {
        warn: () => {},
      }),
    )

  it('veto from the sandbox plugin hook blocks the tool call', async () => {
    executed = false
    if (!(await sandboxAvailable())) return
    const activated = await hookPluginFixture()
    const executor = executorFor(activated)
    const result = await executor.execute(
      probeTool,
      { command: 'rm -rf /' },
      new AbortController().signal,
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain(
      'blocked by hook: hooktest: catastrophic command blocked',
    )
    expect(executed).toBe(false)
  }, 30_000)

  it('lets non-matching calls through (fail-open control)', async () => {
    executed = false
    if (!(await sandboxAvailable())) return
    const activated = await hookPluginFixture()
    const executor = executorFor(activated)
    const result = await executor.execute(
      probeTool,
      { command: 'git status' },
      new AbortController().signal,
    )
    expect(executed).toBe(true)
    expect(result.isError).toBeUndefined()
  }, 30_000)
})
