import { randomBytes } from 'node:crypto'
/**
 * `volund gateway` — 公网远程网关子命令（§GATEWAY-r1）。
 *
 * 把本机 volund 运行时（会话/工具/审批）暴露为远程 API：
 * - OAuth2 client_credentials 颁证（POST /oauth/token），HS256 JWT Bearer；
 * - POST /v1/chat/completions（OpenAI 兼容，SSE 流式）+ WS /v1/ws 交互通道；
 * - 单 runner 语义：所有 turn 串行；审批卡由 WS 客户端决策，超时自动 deny。
 *
 * 配置面（全部环境变量，不入 config.toml——网关是部署关注点不是用户偏好）：
 * - GATEWAY_HOST / GATEWAY_PORT（默认 0.0.0.0 / 8788；--port 可覆盖）
 * - GATEWAY_CLIENTS（JSON 数组）或 GATEWAY_CLIENTS_FILE（默认 <home>/gateway/clients.json）；
 *   两者都缺省时生成 bootstrap client 落盘并只打印一次 secret
 * - GATEWAY_TOKEN_SECRET；缺省生成随机密钥落盘 <home>/gateway/token-key（0600）
 * - GATEWAY_TOKEN_TTL_SECONDS（默认 3600）
 * - GATEWAY_PERMISSION_MODE（ask|auto|full，默认 auto）
 * - GATEWAY_PERMISSION_TIMEOUT_MS（默认 120000，0 关闭自动 deny）
 * - GATEWAY_QUEUE_TIMEOUT_MS（默认 600000）/ GATEWAY_MAX_TURN_HOLD_MS（默认 1800000）
 * - GATEWAY_RATE_LIMIT_RPM（默认 600）/ GATEWAY_TOKEN_RATE_LIMIT_RPM（默认 30）
 * - GATEWAY_CORS_ORIGINS（逗号分隔，默认空 = 不下发 CORS 头）
 * - GATEWAY_DEFAULT_PROVIDER（默认 openai）/ GATEWAY_WORKSPACE（默认进程 cwd）
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  createGatewayServer,
  deriveSigningKey,
  generateGatewayClient,
  parseGatewayClients,
} from '@volund/gateway-server'
import type { GatewayHubLike, GatewayModelListing } from '@volund/gateway-server'
import type { GatewayOAuthClient } from '@volund/gateway-server'
import { SessionHub } from '@volund/web-server/session-hub'

import type { VolundPorts } from '../ports'
import type { CommandContext, CommandDefinition } from '../shared/cli-types'

export interface GatewayCommandConfig {
  readonly host: string
  readonly port: number
  readonly workspace: string
  readonly tokenTtlSeconds: number
  readonly permissionMode: 'ask' | 'auto' | 'full'
  readonly permissionTimeoutMs: number
  readonly queueTimeoutMs: number
  readonly maxTurnHoldMs: number
  readonly rateLimitPerMinute: number
  readonly tokenRateLimitPerMinute: number
  readonly corsOrigins: readonly string[]
  readonly defaultProvider: string
}

function intFromEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`invalid integer value ${value} (expected ${min}..${max})`)
  return parsed
}

/** 环境变量/flag → 命令配置；非法值直接抛错（fail closed）。 */
export function resolveGatewayConfig(input: {
  args: Readonly<Record<string, unknown>>
  cwd: string
  env: NodeJS.ProcessEnv
}): GatewayCommandConfig {
  const { env } = input
  const permissionMode = env.GATEWAY_PERMISSION_MODE ?? 'auto'
  if (permissionMode !== 'ask' && permissionMode !== 'auto' && permissionMode !== 'full')
    throw new Error(`GATEWAY_PERMISSION_MODE must be ask|auto|full, got: ${permissionMode}`)
  const portArg = typeof input.args.port === 'string' ? input.args.port : undefined
  const port = intFromEnv(portArg ?? env.GATEWAY_PORT, 8788, 1, 65535)
  return {
    host: env.GATEWAY_HOST ?? '0.0.0.0',
    port,
    workspace: resolve(env.GATEWAY_WORKSPACE ?? input.cwd),
    tokenTtlSeconds: intFromEnv(env.GATEWAY_TOKEN_TTL_SECONDS, 3600, 1, 7 * 24 * 3600),
    permissionMode,
    permissionTimeoutMs: intFromEnv(env.GATEWAY_PERMISSION_TIMEOUT_MS, 120_000, 0, 3_600_000),
    queueTimeoutMs: intFromEnv(env.GATEWAY_QUEUE_TIMEOUT_MS, 600_000, 1_000, 3_600_000),
    maxTurnHoldMs: intFromEnv(env.GATEWAY_MAX_TURN_HOLD_MS, 1_800_000, 10_000, 7_200_000),
    rateLimitPerMinute: intFromEnv(env.GATEWAY_RATE_LIMIT_RPM, 600, 1, 1_000_000),
    tokenRateLimitPerMinute: intFromEnv(env.GATEWAY_TOKEN_RATE_LIMIT_RPM, 30, 1, 100_000),
    corsOrigins: (env.GATEWAY_CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    defaultProvider: env.GATEWAY_DEFAULT_PROVIDER ?? 'openai',
  }
}

export interface GatewayCredentialsResolution {
  readonly clients: readonly GatewayOAuthClient[]
  readonly signingKey: Uint8Array
  /** bootstrap 生成的客户端（需要装配侧把 secret 打印一次给运维）。 */
  readonly generated: GatewayOAuthClient | undefined
  readonly source: 'env' | 'file' | 'generated'
}

/**
 * 客户端与签名密钥解析：env 优先，其次 <home>/gateway/ 下的 0600 文件，
 * 都没有则生成 bootstrap 客户端并落盘（secret 只出现在启动输出里一次）。
 */
export async function resolveGatewayCredentials(
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<GatewayCredentialsResolution> {
  const dir = join(home, 'gateway')
  await mkdir(dir, { recursive: true, mode: 0o700 })

  let signingKey: Uint8Array
  if (env.GATEWAY_TOKEN_SECRET) {
    signingKey = deriveSigningKey(env.GATEWAY_TOKEN_SECRET)
  } else {
    const keyFile = join(dir, 'token-key')
    try {
      signingKey = deriveSigningKey((await readFile(keyFile, 'utf8')).trim())
    } catch {
      const generated = cryptoRandomKey()
      await writeFile(keyFile, generated, { mode: 0o600 })
      signingKey = deriveSigningKey(generated)
    }
  }

  if (env.GATEWAY_CLIENTS) {
    return {
      clients: parseGatewayClients(env.GATEWAY_CLIENTS),
      signingKey,
      generated: undefined,
      source: 'env',
    }
  }
  const clientsFile = env.GATEWAY_CLIENTS_FILE ?? join(dir, 'clients.json')
  try {
    return {
      clients: parseGatewayClients(await readFile(clientsFile, 'utf8')),
      signingKey,
      generated: undefined,
      source: 'file',
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
  const generated = generateGatewayClient()
  await writeFile(clientsFile, `${JSON.stringify([generated], null, 2)}\n`, { mode: 0o600 })
  return { clients: [generated], signingKey, generated, source: 'generated' }
}

function cryptoRandomKey(): string {
  // 48 字节随机 → base64url，作 HMAC 密钥的熵源绰绰有余。
  return randomBytes(48).toString('base64url')
}

/** [models.aliases] → 全限定 id 映射；别名为键（label 供 /v1/models 展示）。 */
function readModelAliases(
  merged: Record<string, unknown>,
): Map<string, { provider: string; model: string }> {
  const aliases = (merged.models as { aliases?: unknown } | undefined)?.aliases
  const out = new Map<string, { provider: string; model: string }>()
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return out
  for (const [name, value] of Object.entries(aliases as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    if (typeof entry.provider === 'string' && typeof entry.model === 'string')
      out.set(name, { provider: entry.provider, model: entry.model })
  }
  return out
}

/** /v1/models：别名展开成 provider/model 全限定 id + 各 provider 配置段提示。 */
async function listGatewayModels(
  ports: VolundPorts,
  cwd: string,
): Promise<readonly GatewayModelListing[]> {
  const merged = (await ports.config.listMerged?.({ cwd }).catch(() => undefined)) as
    | { config?: Record<string, unknown> }
    | undefined
  const config = merged?.config ?? {}
  const aliases = readModelAliases(config)
  const models: GatewayModelListing[] = [...aliases.entries()].map(([name, target]) => ({
    id: `${target.provider}/${target.model}`,
    label: `${name} → ${target.model}`,
  }))
  const providers = config.provider
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    for (const name of Object.keys(providers as Record<string, unknown>)) {
      if (!models.some((model) => model.id.startsWith(`${name}/`)))
        models.push({ id: `${name}/`, label: `${name}（任意该 provider 的模型 id）` })
    }
  }
  return models
}

export function createGatewayCommand(): CommandDefinition {
  return {
    name: 'gateway',
    async run({ args, cwd, ports }: CommandContext) {
      if (!ports.session.startInteractive || !ports.permissionPrompts) {
        const message = 'gateway requires the session and permission ports to be wired'
        return { exitCode: 1, stdout: '', stderr: message }
      }
      const config = resolveGatewayConfig({ args, cwd, env: process.env })
      const home = process.env.VOLUND_HOME ?? join(homedir(), '.volund')
      const credentials = await resolveGatewayCredentials(home, process.env)

      // 权限交互从 'none' 切到可提示：审批请求进共享队列，经 WS/超时兜底决策。
      ports.session.configurePermissionInteraction?.({ mode: 'tui' })
      ports.permissionMode?.set(config.permissionMode)

      const hub = new SessionHub({
        session: ports.session,
        permissions: ports.permissionPrompts,
      })
      // [models.aliases] 在 CLI 层解析：网关 submit 的 model 先过别名表。
      const merged = (await ports.config
        .listMerged?.({ cwd: config.workspace })
        .catch(() => undefined)) as { config?: Record<string, unknown> } | undefined
      const aliases = readModelAliases(merged?.config ?? {})
      const resolveModel = (model: string | undefined): string | undefined => {
        if (!model) return undefined
        const aliased = aliases.get(model)
        return aliased ? `${aliased.provider}/${aliased.model}` : model
      }
      // submit 前过别名表；其余方法原样委托（getter active 显式转发，避免展开丢 getter）。
      const aliasedHub: GatewayHubLike = {
        get active() {
          return hub.active
        },
        start: (input) => hub.start(input),
        resume: (id) => hub.resume(id),
        submit: (input) => {
          const model = resolveModel(input.model)
          return hub.submit({ prompt: input.prompt, ...(model ? { model } : {}) })
        },
        interrupt: () => hub.interrupt(),
        closeActive: () => hub.closeActive(),
        subscribe: (listener) => hub.subscribe(listener),
        decide: (requestId, kind) => hub.decide(requestId, kind),
        pendingPermissionIds: () => hub.pendingPermissionIds(),
      }

      const server = await createGatewayServer({
        host: config.host,
        port: config.port,
        version: ports.identity.version,
        workspaceCwd: config.workspace,
        oauth: {
          issuer: 'volund-gateway',
          signingKey: credentials.signingKey,
          tokenTtlSeconds: config.tokenTtlSeconds,
          clients: credentials.clients,
        },
        hub: aliasedHub,
        listModels: () => listGatewayModels(ports, config.workspace),
        listSessions: () => ports.session.list?.() ?? Promise.resolve([]),
        defaultProvider: config.defaultProvider,
        queueTimeoutMs: config.queueTimeoutMs,
        permissionTimeoutMs: config.permissionTimeoutMs,
        maxTurnHoldMs: config.maxTurnHoldMs,
        rateLimitPerMinute: config.rateLimitPerMinute,
        tokenRateLimitPerMinute: config.tokenRateLimitPerMinute,
        corsOrigins: config.corsOrigins,
      })

      const banner = {
        url: server.url,
        workspace: config.workspace,
        clients: credentials.source,
        permissionMode: config.permissionMode,
        endpoints: [
          'POST /oauth/token',
          'POST /v1/chat/completions',
          'GET /v1/models',
          'GET /v1/sessions',
          'GET /v1/ws (websocket)',
        ],
      }
      let stdout = args.json
        ? `${JSON.stringify(banner)}\n`
        : `volund gateway listening on ${server.url}\n` +
          `  workspace: ${config.workspace}\n` +
          `  oauth clients: ${credentials.source} (${credentials.clients.length})\n` +
          `  permission mode: ${config.permissionMode}\n` +
          banner.endpoints.map((endpoint) => `  - ${endpoint}`).join('\n') +
          '\n'
      if (credentials.generated) {
        stdout += args.json
          ? ''
          : `\nbootstrap client created (secret shown once; also in ${home}/gateway/clients.json):\n` +
            `  client_id:     ${credentials.generated.id}\n` +
            `  client_secret: ${credentials.generated.secret}\n`
      }
      process.stdout.write(stdout)
      // 常驻服务：命令 promise 永不 resolve，进程生命周期由 bin.ts 的信号处理收尾。
      return new Promise(() => {}) as Promise<never>
    },
  }
}
