/**
 * 远程控制端口的生产装配（REM-r1）：@volund/remote-link 的 uplink + 嵌入式
 * SessionHub + [models.aliases] 解析，包装成 web-server 的 RemoteControlPort。
 *
 * 与 Web 控制台同款语义（§22 W-01/W-07）：嵌入式 hub 只挂载 TUI 活动会话
 * （不抢占所有权）；审批走共享 PermissionPromptController——手机、Web、TUI
 * 任一端决策全端清卡。start/stop 同步写回 [remote] enabled（跨重启保持）。
 */
import type { GatewayHubLike } from '@volund/gateway-server'
import { createGatewayModelResolver, readModelAliases } from '@volund/gateway-server'
import { createRemoteLink, RemoteLink } from '@volund/remote-link'
import type { RemoteLinkConfig } from '@volund/remote-link'
import type { RemoteControlPort } from '@volund/web-server'
import { SessionHub } from '@volund/web-server/session-hub'

import type { VolundPorts } from './ports'
import { listModels } from './web'

interface RemoteSection {
  readonly enabled?: boolean
  readonly gateway_url?: string
  readonly client_id?: string
  readonly client_secret?: string
}

export interface RemoteControlHandle extends RemoteControlPort {
  /** uplink 状态订阅（TUI 欢迎屏 remote 行回填）；link 未建时订阅为空操作。 */
  onState(listener: (status: RemoteControlPortStatus) => void): () => void
  /** TUI 启动钩子：[remote] enabled=true 时自动拨出（不写回配置）。 */
  startup(input: { cwd: string }): Promise<void>
  /** 进程收尾：关 uplink、摘 hub 挂载（幂等）。 */
  close(): Promise<void>
}

type RemoteControlPortStatus = ReturnType<RemoteControlPort['status']>

export function createRemoteControlPort(ports: VolundPorts): RemoteControlHandle {
  let cwd = process.cwd()
  let link: RemoteLink | undefined
  let hub: SessionHub | undefined
  let cachedConfig: RemoteLinkConfig | undefined

  const readConfig = async (): Promise<RemoteSection> => {
    const merged = (await ports.config?.listMerged?.({ cwd }).catch(() => undefined)) as
      | { config?: Record<string, unknown> }
      | undefined
    const remote = merged?.config?.['remote'] as RemoteSection | undefined
    cachedConfig =
      remote?.gateway_url && remote?.client_id && remote?.client_secret
        ? {
            gatewayUrl: remote.gateway_url,
            clientId: remote.client_id,
            clientSecret: remote.client_secret,
          }
        : undefined
    return remote ?? {}
  }

  const persistEnabled = async (enabled: boolean): Promise<void> => {
    await ports.config?.setValue?.({ cwd, key: 'remote.enabled', value: enabled }).catch(() => {})
  }

  /** 惰性建链：嵌入式 SessionHub + 别名解析 hub 包装 + RemoteLink。 */
  const ensureLink = async (): Promise<RemoteLink> => {
    if (link) return link
    if (!ports.session.startInteractive || !ports.permissionPrompts)
      throw new Error('remote control requires the session and permission ports to be wired')
    // 远程审批卡需要权限交互离开 'none'（与 web 嵌入式同门）。
    ports.session.configurePermissionInteraction?.({ mode: 'tui' })
    const sessionHub = new SessionHub(
      { session: ports.session, permissions: ports.permissionPrompts },
      { embedded: true },
    )
    sessionHub.attachActive()
    hub = sessionHub

    const merged = (await ports.config?.listMerged?.({ cwd }).catch(() => undefined)) as
      | { config?: Record<string, unknown> }
      | undefined
    const aliases = readModelAliases(merged?.config ?? {})
    const resolveModel = createGatewayModelResolver({ aliases, defaultProvider: 'anthropic' })
    // 会话快照（移动端刷新重建视图）：hub 包装层透传 SessionHub.transcript。
    const aliasedHub: GatewayHubLike & {
      transcript(): { id?: string; cwd?: string; transcript: readonly unknown[] }
    } = {
      get active() {
        return sessionHub.active
      },
      start: (input) => sessionHub.start(input),
      resume: (id) => sessionHub.resume(id),
      submit: (input) => {
        const model = input.model ? resolveModel(input.model) : undefined
        return sessionHub.submit({
          prompt: input.prompt,
          ...(model ? { model } : {}),
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        })
      },
      // 附件暂存：uplink RPC 载 base64（JSON 帧），解码后进会话 AttachmentStore 换 handle。
      stageAttachment: (input) =>
        sessionHub.stageAttachment(
          new Uint8Array(Buffer.from(input.dataBase64, 'base64')),
          input.mime,
        ),
      // 附件字节回放（GET /v1/attachments/:handle 的隧道回程）：AttachmentStore 读字节
      // → base64 上隧道（RPC 只载 JSON）；读不到回 undefined → 网关 404。
      readAttachment: async (handle: string) => {
        const found = await sessionHub.readAttachment(handle)
        return found
          ? { mime: found.mime, dataBase64: Buffer.from(found.bytes).toString('base64') }
          : undefined
      },
      interrupt: () => sessionHub.interrupt(),
      closeActive: () => sessionHub.closeActive(),
      subscribe: (listener) => sessionHub.subscribe(listener),
      decide: (requestId, kind) => sessionHub.decide(requestId, kind),
      pendingPermissionIds: () => sessionHub.pendingPermissionIds(),
      transcript: () => sessionHub.transcript(),
      // 模型清单与 Web 控制台同源（当前生效模型 + anthropic 别名候选）。
      listModels: () => listModels(ports, cwd),
    }
    link = createRemoteLink({
      // 每次拨号前现取配置：tab 改完 [remote] 立即生效，无需重启。
      config: () => cachedConfig,
      hub: aliasedHub,
      workspaceCwd: cwd,
      listSessions: () => ports.session.list?.() ?? Promise.resolve([]),
      version: ports.identity.version,
      logger: (message) => process.stderr.write(`[remote] ${message}\n`),
    })
    return link
  }

  const refreshAndStart = async (persist: boolean): Promise<void> => {
    await readConfig()
    const active = await ensureLink()
    // 先读配置再启动：RemoteLink 的 config() 在拨号瞬间取 cachedConfig。
    active.start()
    if (persist) await persistEnabled(true)
  }

  return {
    status: () =>
      link?.status ?? {
        state: 'off' as const,
        instanceId: '',
        gatewayUrl: undefined,
        attempt: 0,
        lastError: undefined,
        lastOnlineAt: undefined,
      },
    // TUI 欢迎屏 remote 行的回填源；link 未建（[remote] 未启用）时订阅为空操作。
    onState: (listener) => link?.onState(listener) ?? (() => {}),
    start: () => {
      void refreshAndStart(true).catch((cause) => {
        process.stderr.write(
          `[remote] start failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
        )
      })
    },
    stop: async () => {
      await link?.stop()
      await persistEnabled(false).catch(() => {})
    },
    createPairing: async () => {
      const active = link ?? (await ensureLink())
      if (!link) throw new Error('remote link is not started')
      return active.createPairing()
    },
    listDevices: async () => {
      if (!link) return []
      return link.listDevices().catch(() => [])
    },
    revokeDevice: async (deviceId: string) => {
      if (!link) return false
      return link.revokeDevice(deviceId).catch(() => false)
    },
    startup: async ({ cwd: processCwd }) => {
      cwd = processCwd
      const remote = await readConfig()
      if (remote.enabled !== true) return
      if (!cachedConfig) {
        process.stderr.write('[remote] enabled but gateway_url/client_id/client_secret unset\n')
        return
      }
      await refreshAndStart(false)
    },
    close: async () => {
      await link?.stop()
      hub?.dispose()
      hub = undefined
      link = undefined
    },
  }
}
