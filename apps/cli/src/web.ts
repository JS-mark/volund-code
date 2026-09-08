/**
 * Web 控制台的生产装配（§22 W-01）：随 TUI 静默自启，无独立 web 子命令——
 * loopback server + 静态资源定位 + 挂载 TUI 活动会话（embedded hub 不抢占会话
 * 所有权）。URL 经 onUrl 回调回填状态面板/欢迎屏的 Web 行；进入无 token 门
 * （bootstrap 自动签发 browser session）。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createMemoryPanelController, projectMemoryScope } from '@volund/app-runtime'
import { standaloneArtifactDir } from '@volund/native-bridge'
import { createWebServer } from '@volund/web-server'
import type { WebServerOptions } from '@volund/web-server'
import { createSessionGroupStore } from '@volund/web-server/session-groups'
import { SessionHub } from '@volund/web-server/session-hub'
import { createTerminalPort } from '@volund/web-server/terminal'
import { createWorkbenchPort } from '@volund/web-server/workbench'

import type { VolundPorts } from './ports'

/**
 * 嵌入式地址稳定（§22 W-1a）：端口记 <home>/web/port，下次优先复用、被占则
 * 回退随机——跨 TUI 重启同一地址可复用（书签/旧标签页）。只对本机当前用户可读。
 * （早期版本在此持久化 launch token；进入门已移除，残留文件启动时顺手清掉。）
 */
async function rememberedPort(home: string): Promise<number> {
  try {
    const raw = (await readFile(join(home, 'web', 'port'), 'utf8')).trim()
    const port = Number.parseInt(raw, 10)
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 0
  } catch {
    return 0
  }
}

async function rememberPort(home: string, port: number): Promise<void> {
  try {
    await mkdir(join(home, 'web'), { recursive: true, mode: 0o700 })
    await writeFile(join(home, 'web', 'port'), String(port), { mode: 0o600 })
  } catch {
    // 端口记忆失败不影响服务
  }
}

/** Web 资产目录：VOLUND_WEB_ASSET_DIR → 产物旁 web-assets/ → 源码布局 apps/web/out（Next 静态导出）。 */
export function webAssetDir(): string | undefined {
  const here = standaloneArtifactDir(import.meta.url, process.execPath)
  // 锚点 here 在源码布局是 apps/cli/src、dist 布局是 apps/cli/dist——
  // 两者上两级都是 apps/，web 产物在 apps/web/out。
  const candidates = [
    process.env.VOLUND_WEB_ASSET_DIR,
    join(here, 'web-assets'),
    join(here, '..', 'web-assets'),
    join(here, '..', '..', 'web', 'out'),
  ]
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate
  return undefined
}

/** W-06：模型候选 = 当前生效模型 + [models.aliases] 解析后的 provider/model 全限定 id。 */
async function listModels(ports: VolundPorts, cwd: string): Promise<unknown> {
  const status = (await ports.config?.status?.({ cwd })) as
    | { status?: readonly { label: string; value: string }[] }
    | undefined
  const currentRow = status?.status?.find((row) => row.label === 'Model')
  const rawCurrent =
    currentRow?.value && currentRow.value !== 'not available' ? currentRow.value : undefined
  const current = rawCurrent
    ? rawCurrent.includes('/')
      ? rawCurrent
      : `anthropic/${rawCurrent}`
    : undefined
  const merged = (await ports.config?.listMerged?.({ cwd })) as
    | { config?: Record<string, unknown> }
    | undefined
  const aliases =
    (
      merged?.config?.['models'] as {
        aliases?: Record<string, { provider: string; model: string }>
      }
    )?.aliases ?? {}
  const options = [
    ...(current ? [{ id: current, label: `${current}（默认）` }] : []),
    ...Object.entries(aliases)
      // 与 cli.ts buildModelPicker 同规则：只收当前 provider（anthropic）的别名。
      .filter(([, target]) => target.provider === 'anthropic')
      .map(([name, target]) => ({
        id: `${target.provider}/${target.model}`,
        label: `${name} → ${target.model}`,
      })),
  ]
  return { current, options }
}

function buildServerOptions(
  ports: VolundPorts,
  cwd: string,
  input: {
    port: number
    home: string
    /** [web.terminal] 设置（shell 覆盖 / 字号 / 滚动缓冲）。 */
    terminal?: { shell?: string; font_size?: number; scrollback?: number } | undefined
  },
): { options: WebServerOptions; hub: SessionHub } {
  // §22 W-07 多路审批：共享 PermissionPromptController（runtime 装配进权限链），
  // TUI 与 Web 订阅同一队列，任一端决策全端清卡。
  const sessionHub = new SessionHub(
    { session: ports.session, permissions: ports.permissionPrompts! },
    { embedded: true },
  )
  const management: NonNullable<WebServerOptions['management']> = {
    ...(ports.memory && ports.memoryRecall
      ? {
          memory: createMemoryPanelController(
            ports.memory,
            ports.memoryRecall,
            projectMemoryScope(cwd),
          ),
        }
      : {}),
    ...(ports.skill ? { skill: ports.skill } : {}),
    ...(ports.mcp ? { mcp: ports.mcp } : {}),
    ...(ports.localPlugins && ports.plugin
      ? {
          plugins: {
            builtinDomains: () => ports.localPlugins!.builtinDomains(),
            setBuiltinDomain: (id: string, enabled: boolean) =>
              ports.localPlugins!.setBuiltinDomain(id, enabled),
            availability: () => ports.plugin!.availability(),
          },
        }
      : {}),
    ...(ports.telemetry
      ? {
          telemetry: {
            summary: () => ports.telemetry!.summary(),
            health: () => ports.telemetry!.health(),
          },
        }
      : {}),
  }
  return {
    options: {
      host: '127.0.0.1',
      port: input.port,
      staticDir: webAssetDir(),
      sessionHub,
      embedded: true,
      management,
      ...(ports.changes ? { changes: ports.changes } : {}),
      models: { list: () => listModels(ports, cwd) },
      // 侧栏会话分组：与端口记忆同目录（<home>/web/），跨重启保留。
      sessionGroups: createSessionGroupStore(join(input.home, 'web', 'session-groups.json')),
      // 工作台（右侧栏）：文件树/搜索/git 锚定本工作区 cwd；终端是交互式 shell（WS）。
      workbench: createWorkbenchPort(cwd),
      terminal: createTerminalPort(cwd, {
        ...(input.terminal?.shell ? { shell: input.terminal.shell } : {}),
        ...(typeof input.terminal?.font_size === 'number'
          ? { fontSize: input.terminal.font_size }
          : {}),
        ...(typeof input.terminal?.scrollback === 'number'
          ? { scrollback: input.terminal.scrollback }
          : {}),
      }),
      ...(ports.permissionMode
        ? {
            permissionMode: {
              current: () => ports.permissionMode!.current() ?? 'ask',
              set: (mode: 'ask' | 'auto' | 'full') => ports.permissionMode!.set(mode),
            },
          }
        : {}),
      ports: {
        identity: ports.identity,
        cwd,
        ...(ports.session ? { session: ports.session } : {}),
        ...(ports.config
          ? {
              config: {
                ...(ports.config.status
                  ? { status: (input: { cwd: string }) => ports.config!.status!(input) }
                  : {}),
                ...(ports.config.setValue
                  ? {
                      setValue: (input: { cwd: string; key: string; value: unknown }) =>
                        ports.config!.setValue!(input as never),
                    }
                  : {}),
                // W-13 设置页全量配置：读取（合并视图）/清除/文件路径。
                ...(ports.config.unsetValue
                  ? {
                      unsetValue: (args: { cwd: string; key: string }) =>
                        ports.config!.unsetValue!(args as never),
                    }
                  : {}),
                ...(ports.config.listMerged
                  ? {
                      listMerged: (args: { cwd: string }) => ports.config!.listMerged!(args),
                    }
                  : {}),
                ...(ports.config.filePaths
                  ? { filePaths: (args: { cwd: string }) => ports.config!.filePaths!(args) }
                  : {}),
              },
            }
          : {}),
        ...(ports.native ? { native: ports.native } : {}),
      },
    },
    hub: sessionHub,
  }
}

/** VolundPorts['web'] 的生产实现：只有 startEmbedded（随 TUI 自启，进程退出时关闭）。 */
export function createWebPort(
  ports: VolundPorts,
  hooks?: { onUrl?: (url: string | undefined) => void },
): NonNullable<VolundPorts['web']> {
  return {
    async startEmbedded({ cwd }) {
      // 静默自启门：[web] enabled=false 或 VOLUND_WEB=0|false 时不起服务。
      // 配置在这里经 listMerged 读（runtime 的异步 config 预读与启动竞态无关）。
      const envFlag = process.env.VOLUND_WEB
      if (envFlag === '0' || envFlag === 'false') return undefined
      const merged = (await ports.config?.listMerged?.({ cwd }).catch(() => undefined)) as
        | { config?: Record<string, unknown> }
        | undefined
      const webConfig = merged?.config?.['web'] as
        | {
            enabled?: boolean
            port?: number
            terminal?: { shell?: string; font_size?: number; scrollback?: number }
          }
        | undefined
      if (webConfig?.enabled === false) return undefined
      // Web 审批卡走 SSE + decide 端点；权限交互模式须离开默认 'none'（否则一律静默 deny）。
      ports.session.configurePermissionInteraction?.({ mode: 'tui' })
      // 地址稳定：端口记住上次、被占回退随机；进入无 token 门（bootstrap 自动签发）。
      const home = process.env.VOLUND_HOME ?? join(homedir(), '.volund')
      // 旧版本的持久化 launch token 已废弃，顺手清理（不存在则忽略）。
      await rm(join(home, 'web', 'token'), { force: true }).catch(() => {})
      const configuredPort =
        typeof webConfig?.port === 'number' && Number.isInteger(webConfig.port) ? webConfig.port : 0
      const preferred = configuredPort !== 0 ? configuredPort : await rememberedPort(home)
      const built = buildServerOptions(ports, cwd, {
        port: preferred,
        home,
        ...(webConfig?.terminal ? { terminal: webConfig.terminal } : {}),
      })
      let handle
      try {
        handle = await createWebServer(built.options)
      } catch (cause) {
        // 记忆/配置的端口被占（多开 TUI 等）→ 回退随机端口，地址仍可用。
        if ((cause as NodeJS.ErrnoException).code !== 'EADDRINUSE' || preferred === 0) throw cause
        handle = await createWebServer({ ...built.options, port: 0 })
      }
      await rememberPort(home, handle.port)
      // 挂载 TUI 的活动会话（并订阅后续激活）；hub 不拥有会话。
      built.hub.attachActive()
      hooks?.onUrl?.(handle.url)
      return {
        url: handle.url,
        port: handle.port,
        close: async () => {
          built.hub.dispose()
          await handle.close()
          hooks?.onUrl?.(undefined)
        },
      }
    },
  }
}
