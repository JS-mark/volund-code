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
 *   两者都缺省时生成 bootstrap client（只打印一次明文 secret，落盘只存哈希）
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
  hashGatewayClient,
  parseGatewayClients,
} from '@volund/gateway-server'
import type { GatewayHubLike, GatewayModelListing } from '@volund/gateway-server'
import type { GatewayOAuthClient, GeneratedGatewayClient } from '@volund/gateway-server'
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
  /** bootstrap 生成的客户端（明文 secret 只经启动输出给运维一次，绝不落盘）。 */
  readonly generated: GeneratedGatewayClient | undefined
  readonly source: 'env' | 'file' | 'generated'
  /** 老格式文件（明文 secret）被自动迁移为哈希存储时为 true。 */
  readonly migrated: boolean
}

/**
 * 客户端与签名密钥解析：env 优先，其次 <home>/gateway/ 下的 0600 文件，
 * 都没有则生成 bootstrap 客户端。落盘只存 secret 的域分隔 SHA-256 哈希；
 * 读到老的明文格式时认证照常、随后整文件重写为哈希（自动迁移）。
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
      clients: parseGatewayClients(env.GATEWAY_CLIENTS).clients,
      signingKey,
      generated: undefined,
      source: 'env',
      migrated: false,
    }
  }
  const clientsFile = env.GATEWAY_CLIENTS_FILE ?? join(dir, 'clients.json')
  try {
    const parsed = parseGatewayClients(await readFile(clientsFile, 'utf8'))
    if (parsed.migratedPlaintextIds.length > 0) {
      // 自动迁移：明文条目已哈希化，整文件重写（保留 scopes 等字段由 parsed.clients 承载）。
      await writeFile(clientsFile, `${JSON.stringify(parsed.clients, null, 2)}\n`, {
        mode: 0o600,
      })
    }
    return {
      clients: parsed.clients,
      signingKey,
      generated: undefined,
      source: 'file',
      migrated: parsed.migratedPlaintextIds.length > 0,
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
  const generated = generateGatewayClient()
  const stored = hashGatewayClient(generated)
  await writeFile(clientsFile, `${JSON.stringify([stored], null, 2)}\n`, { mode: 0o600 })
  return { clients: [stored], signingKey, generated, source: 'generated', migrated: false }
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

/**
 * model 归一：[models.aliases] 别名优先（vision → anthropic/mimo-v2.5），
 * 已含 '/' 的全限定 id 原样，裸名补默认 provider 前缀。HTTP 与 WS 共用同一解析。
 */
export function createGatewayModelResolver(input: {
  aliases: ReadonlyMap<string, { provider: string; model: string }>
  defaultProvider: string
}): (model: string) => string {
  return (model) => {
    const aliased = input.aliases.get(model)
    if (aliased) return `${aliased.provider}/${aliased.model}`
    return model.includes('/') ? model : `${input.defaultProvider}/${model}`
  }
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
      const resolveModel = createGatewayModelResolver({
        aliases,
        resolveModel,
      })
      // WS 通道的 turn.submit 不经 HTTP 层解析——hub 包装里过同一解析器。
      const aliasedHub: GatewayHubLike = {
        get active() {
          return hub.active
        },
        start: (input) => hub.start(input),
        resume: (id) => hub.resume(id),
        submit: (input) => {
          const model = input.model ? resolveModel(input.model) : undefined
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
        resolveModel,
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
          : `\nbootstrap client created (secret shown ONCE here; only its SHA-256 hash is stored in ${home}/gateway/clients.json):\n` +
            `  client_id:     ${credentials.generated.id}\n` +
            `  client_secret: ${credentials.generated.secret}\n`
      }
      if (credentials.migrated && !args.json) {
        stdout += `\nnote: clients.json contained plaintext secrets and was rewritten to hashes.\n`
      }
      process.stdout.write(stdout)
      // 常驻服务：命令 promise 永不 resolve，进程生命周期由 bin.ts 的信号处理收尾。
      return new Promise(() => {}) as Promise<never>
    },
  }
}
