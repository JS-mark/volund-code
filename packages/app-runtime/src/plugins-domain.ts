/**
 * PluginController 域辅助（§22.7.1 / P1-04d）：插件诊断、命令贡献注册、
 * 内置/dev 目录解析与 hook 派发器。从 apps/cli/src/runtime.ts 迁入，行为等价。
 */
import { constants as fsConstants } from 'node:fs'
import { existsSync } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

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
