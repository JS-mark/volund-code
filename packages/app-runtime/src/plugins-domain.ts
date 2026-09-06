/**
 * PluginController 域辅助（§22.7.1 / P1-04d）：插件诊断、命令贡献注册、
 * 内置/dev 目录解析与 hook 派发器。从 apps/cli/src/runtime.ts 迁入，行为等价。
 */
import { constants as fsConstants } from 'node:fs'
import { existsSync } from 'node:fs'
import { access, open, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import { loadTomlFile } from '@volund/config'
import { standaloneArtifactDir } from '@volund/native-bridge'
import { PluginError, satisfies } from '@volund/plugin-runtime'
import type { ActivatedLocalPlugin, CommandContribution } from '@volund/plugin-runtime'
import type { ToolHookDispatcher, ToolHookOutcome } from '@volund/tools'

import type { SlashCommandRegistryLike } from './contracts'
import { isCommandListView } from './list-picker'
import type { PluginCompatibilityDiagnostic } from './ports'
import { isCommandTabsView } from './tabbed-list'

function diagnosticRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
const LEGACY_PLUGIN_NAME = /^volund-plugin-[a-z0-9][a-z0-9._-]{0,127}$/
export function assertLegacyPluginName(name: string): void {
  if (!LEGACY_PLUGIN_NAME.test(name))
    throw new PluginError('plugin_path_escape', 'invalid plugin target')
}

export async function readContainedPluginDiagnostic(
  pluginRoot: string,
  name: string,
  storedVersion: string,
  volundVersion: string,
): Promise<{
  version: string
  permissions: readonly string[]
  compatibility: PluginCompatibilityDiagnostic
}> {
  const manifestLimit = 1024 * 1024
  const permissionLimit = 64
  const permissionLengthLimit = 128
  const safeStoredVersion =
    storedVersion.length <= 128 && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(storedVersion)
      ? storedVersion
      : 'unknown'
  const invalid = (detail: string) => ({
    version: safeStoredVersion,
    permissions: [] as readonly string[],
    compatibility: { status: 'invalid' as const, detail },
  })
  assertLegacyPluginName(name)
  let manifest: unknown
  try {
    const canonicalRoot = await realpath(pluginRoot)
    const expectedDirectory = join(canonicalRoot, name)
    const canonicalDirectory = await realpath(expectedDirectory)
    if (canonicalDirectory !== expectedDirectory)
      return invalid('Plugin directory is not canonical; legacy activation remains unavailable.')
    const expectedManifest = join(canonicalDirectory, 'manifest.json')
    const canonicalManifest = await realpath(expectedManifest)
    if (canonicalManifest !== expectedManifest)
      return invalid('Manifest path is not canonical; legacy activation remains unavailable.')
    const handle = await open(canonicalManifest, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > manifestLimit)
        return invalid(
          'Manifest metadata exceeds diagnostic limits; legacy activation remains unavailable.',
        )
      const buffer = Buffer.alloc(manifestLimit + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > manifestLimit)
        return invalid(
          'Manifest metadata exceeds diagnostic limits; legacy activation remains unavailable.',
        )
      manifest = JSON.parse(buffer.toString('utf8', 0, bytesRead))
    } finally {
      await handle.close()
    }
  } catch {
    return invalid('Manifest metadata is unreadable; legacy activation remains unavailable.')
  }
  if (!diagnosticRecord(manifest))
    return invalid('Manifest metadata is invalid; legacy activation remains unavailable.')
  const permissionsRecord = diagnosticRecord(manifest.permissions)
    ? manifest.permissions
    : undefined
  const rawPermissions = permissionsRecord?.volund
  if (Array.isArray(rawPermissions) && rawPermissions.length > permissionLimit)
    return invalid(
      'Manifest permissions exceed diagnostic limits; legacy activation remains unavailable.',
    )
  const permissions: string[] = []
  if (Array.isArray(rawPermissions)) {
    for (const permission of rawPermissions) {
      if (
        typeof permission !== 'string' ||
        permission.length > permissionLengthLimit ||
        !/^[a-z][a-z0-9.:-]*$/.test(permission)
      )
        return invalid('Manifest permissions are invalid; legacy activation remains unavailable.')
      permissions.push(permission)
    }
  }
  const engines = diagnosticRecord(manifest.engines) ? manifest.engines : undefined
  const range =
    typeof engines?.volund === 'string' && engines.volund.length <= 256 ? engines.volund : undefined
  const compatibility: PluginCompatibilityDiagnostic = range
    ? satisfies(volundVersion, range)
      ? {
          status: 'compatible',
          detail: `Declared legacy volund engine range is compatible with ${volundVersion}.`,
        }
      : {
          status: 'incompatible',
          detail: `Declared legacy volund engine range is incompatible with ${volundVersion}; legacy activation remains unavailable.`,
        }
    : {
        status: 'invalid',
        detail: 'Manifest engine metadata is invalid; legacy activation remains unavailable.',
      }
  return {
    version:
      typeof manifest.version === 'string' &&
      manifest.version.length <= 128 &&
      /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(manifest.version)
        ? manifest.version
        : safeStoredVersion,
    permissions,
    compatibility,
  }
}

/**
 * Resolve the legacy context-tuning compatibility switch for a production Runner.
 * A missing file is the documented default-off case. Unreadable, invalid, or non-boolean
 * configuration fails closed by propagating the configuration error before tuning is read.
 * Only an own-property boolean `true` is authority; an inherited/prototype value never counts.
 */

export function registerPluginCommands(
  registry: SlashCommandRegistryLike,
  plugin: string,
  commands: readonly CommandContribution[],
  onWarn: (message: string) => void,
): Array<() => void> {
  const unsubscribes: Array<() => void> = []
  for (const command of commands) {
    try {
      unsubscribes.push(
        registry.register(
          {
            name: command.name,
            description: command.description || `/${command.name} (plugin command)`,
            ...(command.order !== undefined ? { order: command.order } : {}),
            run: async ({ args }) => {
              const result = await command.run(args)
              if (typeof result === 'string' && result) return result
              // 列表 / 页签视图（纯数据描述符）原样透传：UI 渲染成可搜索面板
              if (isCommandListView(result)) return result
              if (isCommandTabsView(result)) return result
              return undefined
            },
          },
          { kind: 'plugin', plugin },
        ),
      )
    } catch (error) {
      onWarn(
        `Plugin command /${command.name} from ${plugin} not registered: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  return unsubscribes
}

/**
 * 内置插件根目录（随产物分发的 apps/cli/plugins/<name>/）。与 native 资产同一
 * 解析惯例（resolver.ts standaloneArtifactDir）：standalone 先看
 * VOLUND_STANDALONE_ASSET_DIR，否则取产物旁——bun --compile 后是 execPath 旁，
 * dist 单文件布局是 dist/plugins/，源码布局（vitest）是 apps/cli/plugins/。
 * 取第一个存在的候选，不存在 → undefined（无内置插件）。
 */
/**
 * 内置插件根目录解析的位置无关内核：源码/产物布局的锚点（import.meta.url）由
 * 调用方（宿主包）传入——内置插件随 apps/cli 产物分发，锚点必须是 CLI 包自身。
 */
export function resolveBuiltinPluginRoot(input: {
  readonly importMetaUrl: string
  readonly execPath: string
  readonly envAssetDir?: string | undefined
}): string | undefined {
  const here = standaloneArtifactDir(input.importMetaUrl, input.execPath)
  const candidates = [
    input.envAssetDir ? join(input.envAssetDir, 'plugins') : undefined,
    join(here, 'plugins'),
    join(here, '..', 'plugins'),
  ]
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate
  return undefined
}

/**
 * SM-08b：收集插件捆绑 skills 目录（`<pluginDir>/skills/`，随插件信任）。
 * builtin 无条件收录（产物自带，与二进制同信任级）；dev/market 以
 * plugin-state.v2 的 enabled 为门——禁用的插件不进 skills 发现面。
 */
export async function collectPluginSkillDirs(input: {
  builtinRoot: string | undefined
  stateEntries: readonly { dir: string; enabled: boolean }[]
}): Promise<string[]> {
  const dirs: string[] = []
  if (input.builtinRoot) {
    try {
      for (const entry of await readdir(input.builtinRoot, { withFileTypes: true }))
        if (entry.isDirectory()) dirs.push(join(input.builtinRoot, entry.name, 'skills'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  for (const entry of input.stateEntries) if (entry.enabled) dirs.push(join(entry.dir, 'skills'))
  return dirs
}

/** 插件工具输出的不可信包裹转义（与 MCP 工具同策略）。 */
export function escapeUntrustedText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * H1：插件 hook 派发器——已激活插件的 hook 订阅按装载顺序执行，首个 HookResult
 * （veto/rewrite）生效；handler 错误 fail-open（warn 后继续），回合中止即停止
 * 派发。独立导出以便沙箱 e2e 正测（veto 必须真的拦下工具调用）。
 */
export function createPluginHookDispatcher(
  entries: readonly {
    name: string
    handle?: Pick<ActivatedLocalPlugin, 'hooks'> | undefined
  }[],
  logger: { warn(message: string): void },
): ToolHookDispatcher {
  return (event, payload, options) => {
    const run = async (): Promise<ToolHookOutcome | undefined> => {
      for (const loaded of entries) {
        if (!loaded.handle) continue
        if (options?.signal?.aborted) return undefined
        for (const hook of loaded.handle.hooks) {
          if (hook.event !== event) continue
          try {
            const result = (await hook.invoke(payload)) as
              | { veto?: unknown; reason?: unknown; value?: unknown }
              | undefined
            if (result && typeof result === 'object') {
              return {
                ...(result.veto === true
                  ? {
                      veto: true,
                      ...(typeof result.reason === 'string' ? { reason: result.reason } : {}),
                    }
                  : {}),
                ...('value' in result ? { value: result.value } : {}),
              }
            }
          } catch (error) {
            logger.warn(
              `plugin hook ${event} from ${loaded.name} failed (fail-open): ${
                error instanceof Error ? error.message : String(error)
              }`,
            )
          }
        }
      }
      return undefined
    }
    return run()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// createPluginDomain（P1-04d part2）：本地插件三源生命周期的完整装配。
// 从 createProductionPorts 闭包迁入；宿主读数（home/version/telemetry/logger/
// slash 注册表/appliedEnv/builtinTools/liveToolServices/内置根解析）经 options
// 注入，builtinToolsDisabled 与 liveToolServices、loadedPluginEntries 是共享
// 可变引用（跨域状态按引用共享，与原闭包语义一致）。行为等价。
// ─────────────────────────────────────────────────────────────────────────────

/** 已激活插件的运行登记表条目（createRunner 的 H3/G/H5 装配读它）。 */
export interface LoadedPluginEntry {
  readonly source: 'builtin' | 'dev' | 'market'
  readonly name: string
  readonly version: string
  readonly dir: string
  readonly handle: ActivatedLocalPlugin
  readonly unsubscribes: readonly (() => void)[]
}

/** /status 插件页签的数据枢纽：render 回调读最近一次组装的会话用量（数据同源）。 */
export interface LocalPluginHub {
  readonly tabs: readonly StatusTabContribution[]
  onUsage(usage: StatusPanelData['usage']): void
}

export interface PluginDomainOptions {
  readonly home: string
  readonly volundVersion: string
  readonly logger: Logger
  readonly emitTelemetry: (
    name: string,
    category: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown> | void
  readonly slashCommands: SlashCommandRegistryLike
  /** [env] applyEnv 应用值快照（config 域写入，/env 桥数据源读取）。 */
  readonly getAppliedEnv: () => Record<string, string> | undefined
  /** H2：活会话内核的 tools 服务集合（插件卸载广播摘除）。 */
  readonly liveToolServices: Set<import('@volund/kernel').ToolsService>
  /** 内置插件根目录解析（锚点在宿主包，P1-04d part1）。 */
  readonly resolveBuiltinPluginRoot: () => string | undefined
}

export interface PluginDomain {
  readonly pluginRoot: string
  /** legacy Catalog 端口（deny-only，§19 PK-P0-0）。 */
  readonly legacyPluginPort: PluginPort
  readonly localPluginState: LocalPluginStateStore
  readonly loadedPluginEntries: LoadedPluginEntry[]
  readonly localPluginHub: LocalPluginHub
  readonly localPlugins: LocalPluginPort
  /** F1：第一方工具域禁用名单（[plugins] builtin_disabled；共享可变引用）。 */
  readonly builtinToolsDisabled: Set<string>
  readonly ensureBuiltinToolsConfig: () => Promise<void>
}

import {
  activateLocalPlugin,
  LEGACY_PLUGIN_UNAVAILABLE,
  PluginManager,
  validateManifest,
} from '@volund/plugin-runtime'
import type { StatusTabContribution } from '@volund/plugin-runtime'
import type { PluginInstallResult, PluginInventory, PluginInventoryEntry } from '@volund/plugin-sdk'
import { productIdentity } from '@volund/shared'
import type { Logger } from '@volund/shared'
import { builtinToolDomains } from '@volund/tools'

import { builtinDisabledFrom, updateConfigBuiltinDisabled } from './config-edit'
import {
  fetchMarketIndex,
  installFromMarket,
  isLocalMarketSource,
  marketInstallRoot,
  normalizePluginName,
  readMarketIntegrity,
  readMarketSource,
  uninstallMarketDir,
} from './plugin-market'
import type { MarketIndex } from './plugin-market'
import { isPluginApproved, LocalPluginStateStore } from './plugin-state'
import type { LocalPluginStateEntry } from './plugin-state'
import { readEffectiveEnv } from './plugins-domain-env'
import type { LocalPluginPort, PluginPort } from './ports'
import type { StatusPanelData } from './status-view'

export function createPluginDomain(options: PluginDomainOptions): PluginDomain {
  const builtinToolsDisabled = new Set<string>()
  let builtinToolsConfigLoaded = false
  async function ensureBuiltinToolsConfig(): Promise<void> {
    if (builtinToolsConfigLoaded) return
    builtinToolsConfigLoaded = true
    try {
      const config = await loadTomlFile(join(options.home, 'config.toml'), {
        onWarning: (message) => options.logger.warn(message),
      })
      for (const domain of builtinDisabledFrom(config.plugins)) builtinToolsDisabled.add(domain)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const pluginRoot = join(options.home, 'plugins')
  const plugins = new PluginManager(pluginRoot, options.volundVersion, async () => false)
  const pluginsReady = plugins.init()
  void pluginsReady.catch(() => undefined)
  // 唯一的本地插件 v2 生命周期状态源。legacy plugins/plugins.json 继续 deny-only，
  // 不参与安装/批准/启用/装载决策。
  const localPluginState = new LocalPluginStateStore(options.home)
  const localPluginStateReady = localPluginState.init()
  void localPluginStateReady.catch(() => undefined)
  // PLUGIN-STATUS-UI-r1 / PLUGIN-MANAGER-r1 本地插件路径：内置（apps/cli/plugins/，
  // 随产物分发）、dev（~/.volund/plugins-dev + VOLUND_DEV_PLUGINS）、市场
  // （[plugins] market 下载到 ~/.volund/plugins/<name>/）三个发现源、同一条链路——
  // 经 volund-sandbox --run-plugin 子进程激活，代码全程不出沙箱；主进程只见到经
  // 权限 guard 的桥方法。贡献的 /status 页签汇入 runtimeStatusData。
  // legacy plugins/plugins.json 继续 deny-only；本地三源只由同级
  // plugin-state.v2.json 决定 approved/enabled，绝不从安装目录推断为可执行。
  interface LoadedPluginEntry {
    readonly source: 'builtin' | 'dev' | 'market'
    readonly name: string
    readonly version: string
    readonly dir: string
    readonly handle: ActivatedLocalPlugin
    readonly unsubscribes: readonly (() => void)[]
  }
  const loadedPluginEntries: LoadedPluginEntry[] = []
  // 插件 render 回调里 volund.session.getUsage() 读到的值：最近一次 /status 组装的
  // 会话用量（同一轮 refresh 内先算 usage 再调 render，数据同源）。
  let lastSessionUsage: StatusPanelData['usage']
  const localPluginHub = {
    get tabs(): readonly StatusTabContribution[] {
      return loadedPluginEntries.flatMap((entry) => [...entry.handle.statusTabs])
    },
    onUsage(usage: StatusPanelData['usage']): void {
      lastSessionUsage = usage
    },
  }
  // 市场索引缓存（/plugins 反复打开不重复拉取；install/uninstall 后失效）。
  let marketIndexCache: { source: string; fetchedAt: number; index: MarketIndex } | undefined
  const MARKET_INDEX_TTL_MS = 60_000
  // 桥 RPC 10s 超时（plugin_host.mjs）：安装整体 deadline 控制在 9s 内，
  // 保证宿主先给出明确结果，而不是插件侧先报 bridge call timed out。
  const MARKET_INSTALL_DEADLINE_MS = 9_000
  async function cachedMarketIndex(
    source: string,
    fresh = false,
    signal?: AbortSignal,
  ): Promise<MarketIndex> {
    if (
      !fresh &&
      marketIndexCache &&
      marketIndexCache.source === source &&
      Date.now() - marketIndexCache.fetchedAt < MARKET_INDEX_TTL_MS
    )
      return marketIndexCache.index
    const index = await fetchMarketIndex(source, signal)
    marketIndexCache = { source, fetchedAt: Date.now(), index }
    return index
  }
  async function activateLocal(
    dir: string,
    source: LoadedPluginEntry['source'],
    integrity?: Record<string, string>,
  ) {
    const resolved = resolve(dir)
    const manifest = validateManifest(
      JSON.parse(await readFile(join(resolved, 'manifest.json'), 'utf8')),
      options.volundVersion,
    )
    const lifecycle = await localPluginState.discover(manifest, source, resolved)
    if (!isPluginApproved(lifecycle))
      throw new PluginError(
        'plugin_approval_required',
        `${manifest.name} requires approval for ${manifest.version} / ${lifecycle.permissionHash}`,
      )
    if (!lifecycle.enabled)
      throw new PluginError('plugin_disabled', `${manifest.name} is installed but disabled`)
    const activated = await activateLocalPlugin({
      dir: resolved,
      volundVersion: options.volundVersion,
      dataDirRoot: join(options.home, source === 'market' ? 'plugins-data' : 'plugins-dev-data'),
      ...(integrity ? { integrity } : {}),
      services: {
        log: (level, message) =>
          void options.emitTelemetry('plugin.log', 'plugin', { level, message }),
        getSessionUsage: () =>
          lastSessionUsage
            ? {
                inputTokens: lastSessionUsage.tokens.input,
                outputTokens: lastSessionUsage.tokens.output,
                cost: lastSessionUsage.costUSD,
              }
            : null,
        // /env 等内置插件的数据源：宿主侧重读 config.toml [env] 段并与
        // process.env 对比（沙箱内读不到主进程环境）。
        getEffectiveEnv: () => readEffectiveEnv(options.home, options.getAppliedEnv()),
        // /plugins 内置插件的数据源与动作（宿主侧；沙箱内无网络）。
        listPlugins: () => pluginInventory(),
        inspectPlugin: (name: string) => inspectPlugin(name),
        installMarketPlugin: (name: string) => installMarketPlugin(name),
        approvePlugin: (name: string, hash: string) => approvePlugin(name, hash),
        enablePlugin: (name: string) => enablePlugin(name),
        disablePlugin: (name: string) => disablePlugin(name),
        uninstallMarketPlugin: (name: string) => uninstallMarketPlugin(name),
      },
    })
    loadedPluginEntries.push({
      source,
      name: activated.manifest.name,
      version: activated.manifest.version,
      dir: resolved,
      handle: activated,
      // 插件贡献的斜杠命令进 MutableSlashCommandRegistry（UI 经 subscribe 热更新）。
      unsubscribes: registerPluginCommands(
        options.slashCommands,
        activated.manifest.name,
        activated.commands,
        (message) => options.logger.warn(message),
      ),
    })
    return { name: activated.manifest.name, statusTabs: activated.statusTabs.length }
  }
  /** 停用并摘除单个已装载插件（uninstall / 同名重装换新版时用）。 */
  async function unloadPlugin(name: string): Promise<LoadedPluginEntry | undefined> {
    const index = loadedPluginEntries.findIndex((entry) => entry.name === name)
    if (index < 0) return undefined
    const [entry] = loadedPluginEntries.splice(index, 1)
    for (const unsubscribe of entry?.unsubscribes || []) unsubscribe()
    await entry?.handle?.deactivate()
    // H2：对每个活会话内核摘除该插件的贡献工具（下会话自然不再注册）。
    if (entry) for (const tools of options.liveToolServices) tools.unregisterPlugin(entry.name)
    return entry
  }
  async function inventoryEntry(entry: LocalPluginStateEntry): Promise<PluginInventoryEntry> {
    const loaded = loadedPluginEntries.find((candidate) => candidate.name === entry.name)
    let permissions: PluginInventoryEntry['permissions']
    try {
      permissions = validateManifest(
        JSON.parse(await readFile(join(entry.dir, 'manifest.json'), 'utf8')),
        options.volundVersion,
      ).permissions
    } catch {
      permissions = undefined
    }
    return {
      name: entry.name,
      version: entry.version,
      dir: entry.dir,
      source: entry.source,
      commands: loaded?.handle.commands.length ?? 0,
      statusTabs: loaded?.handle.statusTabs.length ?? 0,
      lifecycle: {
        permissionHash: entry.permissionHash,
        approved: isPluginApproved(entry),
        enabled: entry.enabled,
        loaded: Boolean(loaded),
      },
      ...(permissions ? { permissions } : {}),
    }
  }
  async function inventorySnapshot(
    source: LoadedPluginEntry['source'],
  ): Promise<PluginInventoryEntry[]> {
    const state = await localPluginState.list()
    return Promise.all(
      state.filter((entry) => entry.source === source).map((entry) => inventoryEntry(entry)),
    )
  }
  async function inspectPlugin(input: string): Promise<PluginInventoryEntry> {
    const name = normalizePluginName(input)
    const current = await localPluginState.get(name)
    if (!current) throw new PluginError('plugin_not_installed', name)
    const manifest = validateManifest(
      JSON.parse(await readFile(join(current.dir, 'manifest.json'), 'utf8')),
      options.volundVersion,
    )
    return inventoryEntry(await localPluginState.discover(manifest, current.source, current.dir))
  }
  /** volund.plugins.list 的宿主实现：三源快照 + 市场索引（未配置/失败给 error）。 */
  async function pluginInventory(): Promise<PluginInventory> {
    let registry: PluginInventory['market']['registry']
    try {
      const source = await readMarketSource(options.home)
      if (!source)
        registry = {
          error:
            'no market configured — add `[plugins] market = "https://…/index.json"` to ~/.volund/config.toml',
        }
      else {
        const index = await cachedMarketIndex(source)
        registry = {
          source,
          plugins: index.plugins.map(({ name, version, description, publisher }) => ({
            name,
            version,
            ...(description ? { description } : {}),
            ...(publisher ? { publisher } : {}),
          })),
        }
      }
    } catch (error) {
      registry = { error: error instanceof Error ? error.message : String(error) }
    }
    return {
      domains: localPlugins ? await localPlugins.builtinDomains() : [],
      builtin: await inventorySnapshot('builtin'),
      dev: await inventorySnapshot('dev'),
      market: { installed: await inventorySnapshot('market'), registry },
    }
  }
  /** volund.plugins.install：只下载、校验、登记。批准与启用必须由后续显式命令完成。 */
  async function installMarketPlugin(input: string): Promise<PluginInstallResult> {
    const name = normalizePluginName(input)
    const source = await readMarketSource(options.home)
    if (!source)
      throw new Error('no market configured — set [plugins] market in ~/.volund/config.toml')
    if (!isLocalMarketSource(source))
      throw new PluginError(
        'plugin_registry_signature_required',
        'remote market installs require a verified publisher signature and trusted key',
      )
    // 整个安装（索引 + 全部文件）共享一个 9s deadline（见 MARKET_INSTALL_DEADLINE_MS）。
    const deadline = AbortSignal.timeout(MARKET_INSTALL_DEADLINE_MS)
    const index = await cachedMarketIndex(source, true, deadline)
    const entry = index.plugins.find((candidate) => candidate.name === name)
    if (!entry) throw new Error(`${name} not found in market index (${source})`)
    // 同名已装载（旧版本）先停用；换新版后必须重新批准，绝不自动重启。
    await unloadPlugin(name)
    const installed = await installFromMarket({
      home: options.home,
      source,
      entry,
      volundVersion: options.volundVersion,
      signal: deadline,
    })
    const lifecycle = await localPluginState.discover(installed.manifest, 'market', installed.dir)
    marketIndexCache = undefined
    void options.emitTelemetry('plugin.market_installed', 'plugin', {
      name,
      version: installed.version,
    })
    return {
      name: installed.name,
      version: installed.version,
      dir: installed.dir,
      permissionHash: lifecycle.permissionHash,
      approvalRequired: true,
      permissions: installed.manifest.permissions,
    }
  }
  async function approvePlugin(input: string, expectedHash: string): Promise<PluginInventoryEntry> {
    const inspected = await inspectPlugin(input)
    const approved = await localPluginState.approve(inspected.name, expectedHash)
    return inventoryEntry(approved)
  }
  async function enablePlugin(input: string): Promise<PluginInventoryEntry> {
    const inspected = await inspectPlugin(input)
    const enabled = await localPluginState.setEnabled(inspected.name, true)
    if (!loadedPluginEntries.some((entry) => entry.name === enabled.name))
      await activateLocal(
        enabled.dir,
        enabled.source,
        enabled.source === 'market' ? await readMarketIntegrity(enabled.dir) : undefined,
      )
    return inventoryEntry((await localPluginState.get(enabled.name)) ?? enabled)
  }
  async function disablePlugin(input: string): Promise<PluginInventoryEntry> {
    const inspected = await inspectPlugin(input)
    await unloadPlugin(inspected.name)
    return inventoryEntry(await localPluginState.setEnabled(inspected.name, false))
  }
  /**
   * volund.plugins.uninstall / 端口卸载的宿主实现：停用（热——命令与页签当场
   * 摘除）+ 删除 ~/.volund/plugins/<name>/。仅市场插件可卸载：内置随产物分发、
   * dev 目录归开发者管理，命中这两类时给出明确拒绝而不是裸 plugin_not_installed。
   */
  async function uninstallMarketPlugin(input: string): Promise<{ name: string }> {
    const name = normalizePluginName(input)
    const state = await localPluginState.get(name)
    const loaded = loadedPluginEntries.find((entry) => entry.name === name)
    const source = loaded?.source ?? state?.source
    if (source === 'builtin')
      throw new Error(
        `${name} is a builtin plugin shipped with the ${productIdentity.shortName} artifact; it cannot be uninstalled`,
      )
    if (source === 'dev')
      throw new Error(
        `${name} is a dev plugin (from ~/.volund/plugins-dev/ or VOLUND_DEV_PLUGINS); remove its directory and restart the REPL to unload it`,
      )
    await unloadPlugin(name)
    await uninstallMarketDir(options.home, name)
    await localPluginState.remove(name)
    marketIndexCache = undefined
    return { name }
  }
  // 本地插件装载端口（PLUGIN-STATUS-UI-r1 / PLUGIN-MANAGER-r1）：内置插件发现源是
  // 产物自带的 apps/cli/plugins/<name>/；dev 插件发现源是正式约定目录
  // ~/.volund/plugins-dev/<name>/ 自动发现（含 manifest.json 的子目录才激活，单个
  // 失败不阻塞启动），VOLUND_DEV_PLUGINS=<dir>[,<dir>...] 仅用于仓库内插件开发的
  // 额外路径；市场插件装在 ~/.volund/plugins/<name>/（带 volund-market.json 完整性
  // 映射，激活期重验）。数据目录在 ~/.volund/plugins-dev-data/<name>/（市场插件为
  // ~/.volund/plugins-data/<name>/），与插件代码目录分离（沙箱内代码只读）。
  const localPlugins = {
    async activateLocal(dir: string) {
      return activateLocal(dir, 'dev')
    },
    async loadDevPlugins(extraDirs: readonly string[] = []) {
      const candidates: string[] = []
      // 约定目录：plugins-dev 下每个含 manifest.json 的子目录
      try {
        for (const entry of await readdir(join(options.home, 'plugins-dev'), {
          withFileTypes: true,
        }))
          if (entry.isDirectory() || entry.isSymbolicLink())
            candidates.push(join(options.home, 'plugins-dev', entry.name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      candidates.push(...extraDirs)
      return this.loadLocalPluginsFrom(candidates, 'dev')
    },
    /**
     * 内置插件（apps/cli/plugins/<name>/，随产物分发）：与 dev 插件同一条
     * 沙箱/桥链路，差异仅在目录来源。内置插件只信产物本身，manifest 校验、
     * bundle 完整性检查、权限 guard 一样不少。
     */
    /** F1：第一方工具域清单（enabled = 未列入 [plugins] builtin_disabled）。 */
    async builtinDomains() {
      await ensureBuiltinToolsConfig()
      return builtinToolDomains().map((domain) => ({
        id: domain.id,
        label: domain.label,
        description: domain.description,
        enabled: !builtinToolsDisabled.has(domain.id),
      }))
    },
    async setBuiltinDomain(id: string, enabled: boolean) {
      if (!/^volund\.(core-tools|exec|orchestration)$/.test(id))
        throw new Error(`Unknown builtin tool domain: ${id}`)
      await updateConfigBuiltinDisabled({ home: options.home, domain: id, disable: !enabled })
      if (enabled) builtinToolsDisabled.delete(id)
      else builtinToolsDisabled.add(id)
    },
    async loadBuiltinPlugins() {
      const root = options.resolveBuiltinPluginRoot()
      if (!root) return { loaded: [], failed: [] }
      const candidates: string[] = []
      try {
        for (const entry of await readdir(root, { withFileTypes: true }))
          if (entry.isDirectory()) candidates.push(join(root, entry.name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return this.loadLocalPluginsFrom(candidates, 'builtin')
    },
    /**
     * 市场插件：~/.volund/plugins/<name>/ 自动发现（dot 目录
     * 跳过——staging 与 legacy 状态文件不在此列，但防御性排除；无 manifest.json
     * 的目录跳过）。发现只登记；approved + enabled 后才逐文件重验并激活。
     */
    async loadMarketPlugins() {
      const root = marketInstallRoot(options.home)
      const candidates: string[] = []
      try {
        for (const entry of await readdir(root, { withFileTypes: true }))
          if (
            (entry.isDirectory() || entry.isSymbolicLink()) &&
            !entry.name.startsWith('.') &&
            entry.name !== 'plugins.json'
          )
            candidates.push(join(root, entry.name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const loaded: { name: string; statusTabs: number }[] = []
      const failed: { dir: string; error: string }[] = []
      for (const candidate of candidates) {
        try {
          await access(join(candidate, 'manifest.json'))
        } catch {
          continue // 无 manifest 的目录不视为插件（legacy 状态文件等）
        }
        try {
          const manifest = validateManifest(
            JSON.parse(await readFile(join(candidate, 'manifest.json'), 'utf8')),
            options.volundVersion,
          )
          const lifecycle = await localPluginState.discover(manifest, 'market', resolve(candidate))
          if (!isPluginApproved(lifecycle) || !lifecycle.enabled) continue
          loaded.push(
            await activateLocal(candidate, 'market', await readMarketIntegrity(candidate)),
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          failed.push({ dir: candidate, error: message })
          void options.emitTelemetry('plugin.local_load_failed', 'plugin', {
            dir: basename(candidate),
            error: message,
          })
        }
      }
      return { loaded, failed }
    },
    async inspectPlugin(input: string) {
      return inspectPlugin(input)
    },
    async approvePlugin(input: string, hash: string) {
      return approvePlugin(input, hash)
    },
    async enablePlugin(input: string) {
      return enablePlugin(input)
    },
    async disablePlugin(input: string) {
      return disablePlugin(input)
    },
    async loadLocalPluginsFrom(candidates: readonly string[], source: LoadedPluginEntry['source']) {
      const loaded: { name: string; statusTabs: number }[] = []
      const failed: { dir: string; error: string }[] = []
      for (const candidate of candidates) {
        try {
          await access(join(candidate, 'manifest.json'))
        } catch {
          continue // 无 manifest 的目录不视为插件
        }
        try {
          loaded.push(await activateLocal(candidate, source))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          failed.push({ dir: candidate, error: message })
          void options.emitTelemetry('plugin.local_load_failed', 'plugin', {
            dir: basename(candidate),
            error: message,
          })
        }
      }
      return { loaded, failed }
    },
    /**
     * 卸载市场插件（端口面，管理命令/未来 CLI 子命令用；桥上经
     * volund.plugins.uninstall 走同一实现）：热生效——停用、摘命令与页签、
     * 删目录，当前会话立即可见。内置/dev 插件明确拒绝（见实现内说明）。
     */
    async uninstallMarketPlugin(input: string) {
      return uninstallMarketPlugin(input)
    },
    async deactivateAll() {
      const entries = loadedPluginEntries.splice(0)
      await Promise.allSettled(
        entries.map(async (entry) => {
          for (const unsubscribe of entry.unsubscribes) unsubscribe()
          await entry.handle.deactivate()
        }),
      )
    },
  }
  // P1-04b：Memory 四件套的单一组合点在 app-runtime（createMemoryStack）。

  const legacyPluginPort: PluginPort = {
    async install(_source) {
      throw new PluginError(
        LEGACY_PLUGIN_UNAVAILABLE.code,
        `${LEGACY_PLUGIN_UNAVAILABLE.detail} Reopen requires ${LEGACY_PLUGIN_UNAVAILABLE.reopenCondition}.`,
      )
    },
    async uninstall(name) {
      assertLegacyPluginName(name)
      if (await localPluginState.get(name))
        throw new PluginError(
          'plugin_lifecycle_authority_mismatch',
          `${name} is managed by plugin-state.v2.json; use /plugins uninstall ${name.replace(/^volund-plugin-/, '')}`,
        )
      await pluginsReady
      await plugins.uninstall(name)
    },
    async list() {
      await pluginsReady
      return plugins.list()
    },
    async setEnabled(name, enabled) {
      assertLegacyPluginName(name)
      if (enabled)
        throw new PluginError(
          LEGACY_PLUGIN_UNAVAILABLE.code,
          `${LEGACY_PLUGIN_UNAVAILABLE.detail} Reopen requires ${LEGACY_PLUGIN_UNAVAILABLE.reopenCondition}.`,
        )
      await pluginsReady
      await plugins.setEnabled(name, enabled)
    },
    async availability() {
      return LEGACY_PLUGIN_UNAVAILABLE
    },
    async doctor(name) {
      assertLegacyPluginName(name)
      await pluginsReady
      const approvals = plugins.list()
      const state = Object.hasOwn(approvals, name) ? approvals[name] : undefined
      if (!state) throw new PluginError('plugin_not_installed', name)
      const diagnostic = await readContainedPluginDiagnostic(
        pluginRoot,
        name,
        state.version,
        options.volundVersion,
      )
      return {
        name,
        version: diagnostic.version,
        permissions: diagnostic.permissions,
        compatibility: diagnostic.compatibility,
        availability: LEGACY_PLUGIN_UNAVAILABLE,
      }
    },
  }

  return {
    pluginRoot,
    legacyPluginPort,
    localPluginState,
    loadedPluginEntries,
    localPluginHub,
    localPlugins,
    builtinToolsDisabled,
    ensureBuiltinToolsConfig,
  }
}
