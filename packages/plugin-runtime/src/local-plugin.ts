import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { startPluginHost } from '@apollo-code/native-bridge'
import type { PluginManifest } from '@apollo-code/plugin-sdk'

import { PluginBridgeServer, PluginCallbackRef, PluginBridgeError } from './bridge-server'
import { BRIDGE_PERMISSIONS, createRpcGuard, PluginError } from './index'
import { sandboxProfile, validateManifest, verifyBundle } from './index'

/** 插件贡献的 /status 页签；render 经 callback.invoke 回到沙箱内的插件进程取值。 */
export interface StatusTabContribution {
  readonly id: string
  readonly label: string
  render(): Promise<unknown>
}

export interface StatusSectionContribution {
  readonly id: string
  readonly title: string
  render(): Promise<unknown>
}

/**
 * 本地（dev）插件可用的宿主侧服务集。刻意保持最小：日志、会话用量快照、
 * /status 贡献注册。其余 bridge 方法一律 unknown-method 拒绝。
 */
export interface LocalPluginServices {
  log?(level: string, message: string, meta?: unknown): void
  getSessionUsage?(): unknown
}

export interface ActivatedLocalPlugin {
  readonly manifest: PluginManifest
  readonly statusTabs: readonly StatusTabContribution[]
  readonly statusSections: readonly StatusSectionContribution[]
  deactivate(): Promise<void>
}

export interface ActivateLocalPluginOptions {
  /** 本地插件目录（含 manifest.json + bundled 单文件 ESM 入口）。 */
  dir: string
  apolloVersion: string
  /** 插件数据根目录；实际数据目录 = dataDirRoot/<manifest.name>（沙箱内唯一可写根）。 */
  dataDirRoot: string
  services: LocalPluginServices
  signal?: AbortSignal
  /** 覆盖握手等待（host.ready / host.activated）超时，测试用。 */
  handshakeTimeoutMs?: number
}

/**
 * 本地插件桥请求的分发器（独立导出以便单测）：权限 guard → 方法路由。
 * 返回的 contributions 数组随调用累积。
 */
export function createLocalPluginDispatch(options: {
  manifest: PluginManifest
  invokeCallback: (ref: PluginCallbackRef) => Promise<unknown>
  services: LocalPluginServices
  contributions: {
    statusTabs: StatusTabContribution[]
    statusSections: StatusSectionContribution[]
  }
}): (method: string, params: unknown) => unknown {
  const { manifest, invokeCallback, services, contributions } = options
  // 与 BridgeRuntime.create 同一约定：manifest.permissions.apollo 记权限名，
  // 桥方法经 BRIDGE_PERMISSIONS 映射后比对（deny-by-default）。
  const guard = createRpcGuard({
    ...manifest,
    permissions: {
      ...manifest.permissions,
      apollo: manifest.permissions.apollo.map((method) => BRIDGE_PERMISSIONS[method] ?? method),
    },
  })
  return (method, params) => {
    const short = method.startsWith('apollo.') ? method.slice('apollo.'.length) : method
    // 与 BridgeRuntime 的 check 一致：调用方法先映射到权限名再比对。
    guard('local', BRIDGE_PERMISSIONS[short] ?? short)
    if (short === 'ui.status.registerTab') {
      const tab = readTabSpec(params)
      contributions.statusTabs.push({
        id: tab.id,
        label: tab.label,
        render: () => invokeCallback(tab.render),
      })
      return null
    }
    if (short === 'ui.status.registerSection') {
      const section = readSectionSpec(params)
      contributions.statusSections.push({
        id: section.id,
        title: section.title,
        render: () => invokeCallback(section.render),
      })
      return null
    }
    if (short === 'session.getUsage') return services.getSessionUsage?.() ?? null
    if (['log.debug', 'log.info', 'log.warn', 'log.error'].includes(short)) {
      const level = short.slice('log.'.length)
      const args = Array.isArray(params) ? params : [params]
      services.log?.(level, typeof args[0] === 'string' ? args[0] : '', args[1])
      return null
    }
    throw new PluginError('plugin_rpc_method_denied', short)
  }
}

/**
 * PLUGIN-STATUS-UI-r1 的插件路径装载器：本地目录 → manifest 校验 + bundle
 * 完整性/路径检查 → 沙箱 profile → apollo-sandbox --run-plugin 子进程（fd3
 * JSONRPC 桥）→ activate() 期间的贡献收敛。
 *
 * 与 legacy Catalog 安装路径无关；插件代码全程只跑在沙箱子进程里（§4.7/C0），
 * 主进程仅看到经权限 guard 的桥方法调用。
 */
export async function activateLocalPlugin(
  options: ActivateLocalPluginOptions,
): Promise<ActivatedLocalPlugin> {
  const manifest = validateManifest(
    JSON.parse(await readFile(join(options.dir, 'manifest.json'), 'utf8')),
    options.apolloVersion,
  )
  await verifyBundle(options.dir, manifest)
  // 数据目录按 manifest 名派生（名字已被 validateManifest 约束为路径安全字符），
  // 与插件代码目录分离——插件在沙箱里对自己的代码目录只读。
  const dataDir = join(options.dataDirRoot, manifest.name)
  await mkdir(dataDir, { recursive: true })
  const profile = sandboxProfile(manifest, options.dir, dataDir)
  const host = await startPluginHost({
    entry: join(options.dir, manifest.main),
    dataDir,
    profile,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const server = new PluginBridgeServer(host.bridge)
  const contributions = {
    statusTabs: [] as StatusTabContribution[],
    statusSections: [] as StatusSectionContribution[],
  }
  server.onRequest = createLocalPluginDispatch({
    manifest,
    invokeCallback: (ref) => server.invokeCallback(ref),
    services: options.services,
    contributions,
  })
  try {
    await server.waitFor('host.ready', options.handshakeTimeoutMs)
    await server.waitFor('host.activated', options.handshakeTimeoutMs)
  } catch (error) {
    host.terminate()
    throw error
  }
  // 宿主进程退出时兜底终止插件子进程，避免孤儿沙箱。
  const onExit = () => host.terminate()
  process.on('exit', onExit)
  return {
    manifest,
    get statusTabs() {
      return contributions.statusTabs
    },
    get statusSections() {
      return contributions.statusSections
    },
    deactivate: async () => {
      process.off('exit', onExit)
      server.close()
      host.terminate()
      await host.exited.catch(() => undefined)
    },
  }
}

function readTabSpec(params: unknown): { id: string; label: string; render: PluginCallbackRef } {
  const spec = (params ?? {}) as { id?: unknown; label?: unknown; render?: unknown }
  if (typeof spec.id !== 'string' || !spec.id || typeof spec.label !== 'string' || !spec.label)
    throw new PluginBridgeError('plugin_status_tab_invalid', 'registerTab requires id and label')
  if (!(spec.render instanceof PluginCallbackRef))
    throw new PluginBridgeError(
      'plugin_status_tab_invalid',
      'registerTab requires a render function',
    )
  return { id: spec.id, label: spec.label, render: spec.render }
}

function readSectionSpec(params: unknown): {
  id: string
  title: string
  render: PluginCallbackRef
} {
  const spec = (params ?? {}) as { id?: unknown; title?: unknown; render?: unknown }
  if (typeof spec.id !== 'string' || !spec.id || typeof spec.title !== 'string' || !spec.title)
    throw new PluginBridgeError(
      'plugin_status_section_invalid',
      'registerSection requires id and title',
    )
  if (!(spec.render instanceof PluginCallbackRef))
    throw new PluginBridgeError(
      'plugin_status_section_invalid',
      'registerSection requires a render function',
    )
  return { id: spec.id, title: spec.title, render: spec.render }
}
