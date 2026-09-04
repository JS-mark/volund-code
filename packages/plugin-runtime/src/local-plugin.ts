import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { startPluginHost } from '@volund/native-bridge'
import type {
  EffectiveEnvEntry,
  PluginInstallResult,
  PluginInventory,
  PluginInventoryEntry,
  PluginManifest,
} from '@volund/plugin-sdk'

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
 * 插件贡献的斜杠命令（commands.register）。run 经 callback.invoke 回到沙箱执行
 * 插件 handler；返回值约定：string → 作为系统消息进 transcript；其他 → 静默成功。
 * order 是可选排序键（CommandSpec.order，建议列表 / /help 升序）。
 */
export interface CommandContribution {
  readonly name: string
  readonly description: string
  readonly order?: number
  run(args: readonly string[]): Promise<unknown>
}

/**
 * G 插件一等公民：插件贡献的工具（tools.register）。invoke 经 callback.invoke
 * 回到沙箱执行插件 handler；宿主侧包成 tool-kit Tool（permissionSpec 收敛到
 * {custom:{pluginTool:{plugin,tool}}}，进统一权限决策链）注册进内核 tools 服务。
 * 名字必须带 `plugin:<manifest.name>:` 前缀（与 ToolRegistry 的 plugin 来源约束
 * 一致，避免与内置/MCP 工具撞名）。
 */
export interface ToolContribution {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  invoke(input: unknown): Promise<unknown>
}

/** 插件可订阅的 hook 事件全集（plugin-sdk HookEvent 同名）。 */
export const HOOK_EVENTS: ReadonlySet<string> = new Set([
  'prePrompt',
  'postPrompt',
  'preToolUse',
  'postToolUse',
  'sessionStart',
  'sessionEnd',
  'pluginEnabled',
  'pluginDisabled',
  'permissionsChanged',
  'memory.preRecall',
  'memory.postRecall',
  'memory.preWrite',
  'memory.postWrite',
  'memory.preRead',
  'deleted',
])

/**
 * 插件贡献的 hook 订阅（hooks.on）。handler 经 callback.invoke 回到沙箱执行，
 * 返回 HookResult（{veto?, reason?, value?}）；preToolUse/postToolUse 由
 * ToolExecutor 的 dispatchHook 管线消费，其余事件等宿主广播面接通。
 */
export interface HookContribution {
  readonly event: string
  readonly plugin: string
  invoke(payload: unknown): Promise<unknown>
}

/**
 * H3：插件贡献的提示词 fragment（prompt.contribute）。静态文本（桥上传值，
 * 不传回调）；createRunner 把已激活插件的 fragment 注册进每会话 composer，
 * id 加 `plugin:<名>:` 命名空间防撞，priority 缺省 600（skills 800 / builtin
 * 1000 之下）。
 */
export interface PromptContribution {
  readonly id: string
  readonly content: string
  readonly priority: number
}

/**
 * 本地（dev / 内置 / 市场）插件可用的宿主侧服务集。刻意保持最小：日志、会话
 * 用量快照、[env] 生效快照、装载清单与市场管理、/status 贡献注册。其余 bridge
 * 方法一律 unknown-method 拒绝。
 */
export interface LocalPluginServices {
  log?(level: string, message: string, meta?: unknown): void
  getSessionUsage?(): unknown
  /** [env] 配置段的生效快照（每次调用重读 config.toml，与 process.env 对比）。 */
  getEffectiveEnv?(): Promise<readonly EffectiveEnvEntry[]> | readonly EffectiveEnvEntry[]
  /** 装载清单（内置 / dev / 市场三源 + 市场索引，宿主侧计算）。 */
  listPlugins?(): Promise<PluginInventory>
  /** 从市场安装（宿主侧拉取 + digest 校验 + 落盘；不批准、不激活）。 */
  installMarketPlugin?(name: string): Promise<PluginInstallResult>
  inspectPlugin?(name: string): Promise<PluginInventoryEntry>
  approvePlugin?(name: string, permissionHash: string): Promise<PluginInventoryEntry>
  enablePlugin?(name: string): Promise<PluginInventoryEntry>
  disablePlugin?(name: string): Promise<PluginInventoryEntry>
  /** 卸载市场插件（停用 + 删目录）。 */
  uninstallMarketPlugin?(name: string): Promise<{ name: string }>
}

export interface ActivatedLocalPlugin {
  readonly manifest: PluginManifest
  readonly statusTabs: readonly StatusTabContribution[]
  readonly statusSections: readonly StatusSectionContribution[]
  readonly commands: readonly CommandContribution[]
  readonly tools: readonly ToolContribution[]
  readonly hooks: readonly HookContribution[]
  readonly prompts: readonly PromptContribution[]
  deactivate(): Promise<void>
}

export interface ActivateLocalPluginOptions {
  /** 本地插件目录（含 manifest.json + bundled 单文件 ESM 入口）。 */
  dir: string
  volundVersion: string
  /** 插件数据根目录；实际数据目录 = dataDirRoot/<manifest.name>（沙箱内唯一可写根）。 */
  dataDirRoot: string
  services: LocalPluginServices
  /**
   * 相对路径 → sha256（hex 或 sha256- 前缀）完整性映射（市场安装的插件带
   * volund-market.json 时由装载器传入）：激活时逐文件校验，篡改即拒载。
   */
  integrity?: Record<string, string>
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
  invokeCallback: (ref: PluginCallbackRef, args?: readonly unknown[]) => Promise<unknown>
  services: LocalPluginServices
  contributions: {
    statusTabs: StatusTabContribution[]
    statusSections: StatusSectionContribution[]
    commands: CommandContribution[]
    tools: ToolContribution[]
    hooks: HookContribution[]
    prompts: PromptContribution[]
  }
}): (method: string, params: unknown) => unknown {
  const { manifest, invokeCallback, services, contributions } = options
  // 与 BridgeRuntime.create 同一约定：manifest.permissions.volund 记权限名，
  // 桥方法经 BRIDGE_PERMISSIONS 映射后比对（deny-by-default）。
  const guard = createRpcGuard({
    ...manifest,
    permissions: {
      ...manifest.permissions,
      volund: manifest.permissions.volund.map((method) => BRIDGE_PERMISSIONS[method] ?? method),
    },
  })
  return (method, params) => {
    const short = method.startsWith('volund.') ? method.slice('volund.'.length) : method
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
    if (short === 'commands.register') {
      const command = readCommandSpec(params)
      contributions.commands.push({
        name: command.name,
        description: command.description,
        ...(command.order !== undefined ? { order: command.order } : {}),
        run: (args) => invokeCallback(command.handler, [args]),
      })
      return null
    }
    if (short === 'tools.register') {
      const spec = readToolSpec(params, manifest.name)
      // 同名重注册 = 插件侧热更新语义：先摘旧再挂新。
      const existing = contributions.tools.findIndex((tool) => tool.name === spec.name)
      if (existing >= 0) contributions.tools.splice(existing, 1)
      contributions.tools.push({
        name: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema,
        invoke: (input) => invokeCallback(spec.handler, [input]),
      })
      return null
    }
    if (short === 'tools.unregister') {
      if (typeof params !== 'string' || !params)
        throw new PluginError('plugin_rpc_params_invalid', 'tools.unregister requires a name')
      const index = contributions.tools.findIndex((tool) => tool.name === params)
      if (index >= 0) contributions.tools.splice(index, 1)
      return null
    }
    if (short === 'hooks.on') {
      const spec = readHookSpec(params)
      // 同 event+handler 重复订阅按一条计（handler 是独立 ref，findIndex 恒 -1 也无害）。
      contributions.hooks.push({
        event: spec.event,
        plugin: manifest.name,
        invoke: (payload) => invokeCallback(spec.handler, [payload]),
      })
      return null
    }
    if (short === 'session.on') {
      // H5：session.on 与 hooks.on 同语义（事件面为 sessionStart/sessionEnd 等
      // 会话生命周期事件），复用同一订阅通道。
      const spec = readHookSpec(params)
      contributions.hooks.push({
        event: spec.event,
        plugin: manifest.name,
        invoke: (payload) => invokeCallback(spec.handler, [payload]),
      })
      return null
    }
    if (short === 'prompt.contribute') {
      const spec = readPromptSpec(params)
      const existing = contributions.prompts.findIndex((prompt) => prompt.id === spec.id)
      if (existing >= 0) contributions.prompts.splice(existing, 1)
      contributions.prompts.push(spec)
      return null
    }
    if (short === 'prompt.revoke') {
      if (typeof params !== 'string' || !params)
        throw new PluginError('plugin_rpc_params_invalid', 'prompt.revoke requires an id')
      const index = contributions.prompts.findIndex((prompt) => prompt.id === params)
      if (index >= 0) contributions.prompts.splice(index, 1)
      return null
    }
    if (short === 'session.getUsage') return services.getSessionUsage?.() ?? null
    if (short === 'env.getEffective') return services.getEffectiveEnv?.() ?? []
    if (short === 'plugins.list')
      return (
        services.listPlugins?.() ?? {
          builtin: [],
          dev: [],
          market: { installed: [], registry: { error: 'plugins inventory unavailable' } },
        }
      )
    if (short === 'plugins.inspect') {
      if (typeof params !== 'string' || !params)
        throw new PluginError('plugin_rpc_params_invalid', 'plugins.inspect requires a name string')
      return services.inspectPlugin?.(params)
    }
    if (short === 'plugins.install') {
      if (typeof params !== 'string' || !params)
        throw new PluginError('plugin_rpc_params_invalid', 'plugins.install requires a name string')
      return services.installMarketPlugin?.(params)
    }
    if (short === 'plugins.approve') {
      if (
        !Array.isArray(params) ||
        params.length !== 2 ||
        typeof params[0] !== 'string' ||
        typeof params[1] !== 'string'
      )
        throw new PluginError(
          'plugin_rpc_params_invalid',
          'plugins.approve requires (name, permissionHash)',
        )
      return services.approvePlugin?.(params[0], params[1])
    }
    if (short === 'plugins.enable' || short === 'plugins.disable') {
      if (typeof params !== 'string' || !params)
        throw new PluginError('plugin_rpc_params_invalid', `${short} requires a name string`)
      return short === 'plugins.enable'
        ? services.enablePlugin?.(params)
        : services.disablePlugin?.(params)
    }
    if (short === 'plugins.uninstall') {
      if (typeof params !== 'string' || !params)
        throw new PluginError(
          'plugin_rpc_params_invalid',
          'plugins.uninstall requires a name string',
        )
      return services.uninstallMarketPlugin?.(params)
    }
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
 * 完整性/路径检查 → 沙箱 profile → volund-sandbox --run-plugin 子进程（fd3
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
    options.volundVersion,
  )
  await verifyBundle(options.dir, manifest, options.integrity)
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
    commands: [] as CommandContribution[],
    tools: [] as ToolContribution[],
    hooks: [] as HookContribution[],
    prompts: [] as PromptContribution[],
  }
  server.onRequest = createLocalPluginDispatch({
    manifest,
    invokeCallback: (ref, args) => server.invokeCallback(ref, args ?? []),
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
    get commands() {
      return contributions.commands
    },
    get tools() {
      return contributions.tools
    },
    get hooks() {
      return contributions.hooks
    },
    get prompts() {
      return contributions.prompts
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

function readCommandSpec(params: unknown): {
  name: string
  description: string
  order?: number
  handler: PluginCallbackRef
} {
  const spec = (params ?? {}) as {
    name?: unknown
    description?: unknown
    order?: unknown
    handler?: unknown
  }
  if (typeof spec.name !== 'string' || !spec.name)
    throw new PluginBridgeError('plugin_command_invalid', 'commands.register requires a name')
  if (!(spec.handler instanceof PluginCallbackRef))
    throw new PluginBridgeError(
      'plugin_command_invalid',
      'commands.register requires a handler function',
    )
  // 排序键只收有限数（桥值是任意 JSON，非法值按未设置处理）
  const order =
    typeof spec.order === 'number' && Number.isFinite(spec.order) ? spec.order : undefined
  return {
    name: spec.name,
    description: typeof spec.description === 'string' ? spec.description : '',
    ...(order !== undefined ? { order } : {}),
    handler: spec.handler,
  }
}

/** 校验 prompt.contribute 参数：id/content 非空字符串，priority 有限数。 */
function readPromptSpec(params: unknown): PromptContribution {
  const spec = (params ?? {}) as { id?: unknown; content?: unknown; priority?: unknown }
  if (typeof spec.id !== 'string' || !spec.id)
    throw new PluginBridgeError('plugin_prompt_invalid', 'prompt.contribute requires an id')
  if (typeof spec.content !== 'string' || !spec.content.trim())
    throw new PluginBridgeError('plugin_prompt_invalid', 'prompt.contribute requires content')
  const priority =
    typeof spec.priority === 'number' && Number.isFinite(spec.priority) ? spec.priority : 600
  return { id: spec.id, content: spec.content, priority }
}

/** 校验 hooks.on 参数：event ∈ HOOK_EVENTS，handler 必须是桥回调。 */
function readHookSpec(params: unknown): {
  event: string
  handler: PluginCallbackRef
} {
  // 线格式 = 插件代理对多参调用的编码 `[event, handler]`（对象形状也收，宽容省事）。
  const array = Array.isArray(params) ? params : undefined
  const spec = (array ?? params ?? {}) as {
    event?: unknown
    handler?: unknown
    0?: unknown
    1?: unknown
  }
  const event = array ? spec[0] : spec.event
  const handler = array ? spec[1] : spec.handler
  if (typeof event !== 'string' || !HOOK_EVENTS.has(event))
    throw new PluginBridgeError('plugin_hook_invalid', `hooks.on requires a known HookEvent`)
  if (!(handler instanceof PluginCallbackRef))
    throw new PluginBridgeError('plugin_hook_invalid', 'hooks.on requires a handler function')
  return { event, handler }
}

function readToolSpec(
  params: unknown,
  pluginName: string,
): {
  name: string
  description: string
  inputSchema: Readonly<Record<string, unknown>>
  handler: PluginCallbackRef
} {
  const spec = (params ?? {}) as {
    name?: unknown
    description?: unknown
    inputSchema?: unknown
    handler?: unknown
  }
  const prefix = `plugin:${pluginName}:`
  if (typeof spec.name !== 'string' || !spec.name.startsWith(prefix))
    throw new PluginBridgeError(
      'plugin_tool_invalid',
      `tools.register requires a name with '${prefix}' prefix`,
    )
  if (!(spec.handler instanceof PluginCallbackRef))
    throw new PluginBridgeError('plugin_tool_invalid', 'tools.register requires a handler function')
  if (!spec.inputSchema || typeof spec.inputSchema !== 'object' || Array.isArray(spec.inputSchema))
    throw new PluginBridgeError('plugin_tool_invalid', 'tools.register requires an inputSchema')
  return {
    name: spec.name,
    description: typeof spec.description === 'string' ? spec.description : '',
    inputSchema: spec.inputSchema as Readonly<Record<string, unknown>>,
    handler: spec.handler,
  }
}
