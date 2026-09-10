import { randomBytes } from 'node:crypto'
/**
 * 独立远程网关（relay）的环境配置与凭证解析——从 apps/cli 的 `volund gateway`
 * 子命令迁入：网关是部署关注点，配置全部走环境变量，不经 volund CLI。
 *
 * 环境变量面（与历史 `volund gateway` relay 模式一致）：
 * - GATEWAY_HOST / GATEWAY_PORT（默认 0.0.0.0 / 8788；--port 可覆盖）
 * - GATEWAY_CLIENTS（JSON 数组）或 GATEWAY_CLIENTS_FILE（默认 <home>/gateway/clients.json）；
 *   两者都缺省时生成 bootstrap client 落盘并只打印一次 secret
 * - GATEWAY_TOKEN_SECRET；缺省生成随机密钥落盘 <home>/gateway/token-key（0600）
 * - GATEWAY_TOKEN_TTL_SECONDS（默认 3600）
 * - GATEWAY_PERMISSION_TIMEOUT_MS（默认 120000，0 关闭自动 deny）
 * - GATEWAY_QUEUE_TIMEOUT_MS（默认 600000）/ GATEWAY_MAX_TURN_HOLD_MS（默认 1800000）
 * - GATEWAY_RATE_LIMIT_RPM（默认 600）/ GATEWAY_TOKEN_RATE_LIMIT_RPM（默认 30）
 * - GATEWAY_CORS_ORIGINS（逗号分隔，默认空 = 不下发 CORS 头）
 * - GATEWAY_PUBLIC_URL（配对 URL 基地址；缺省按请求 Host 推断）
 * - GATEWAY_MOBILE_PUBLIC_URL（移动站单独部署的站点地址；配对 URL 指向它并带 &gw=）
 * - VOLUND_MOBILE_ASSET_DIR（移动站静态产物目录；单独部署时无需配置）
 *
 * relay 模式不挂本机会话：GATEWAY_PERMISSION_MODE / GATEWAY_DEFAULT_PROVIDER /
 * GATEWAY_WORKSPACE 是直挂模式遗留，独立入口不再读取（模型别名解析在本机侧）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  deriveSigningKey,
  generateGatewayClient,
  hashGatewayClient,
  parseGatewayClients,
} from './oauth'
import type { GatewayOAuthClient, GeneratedGatewayClient } from './oauth'

export interface RelayServerConfig {
  readonly host: string
  readonly port: number
  readonly tokenTtlSeconds: number
  readonly permissionTimeoutMs: number
  readonly queueTimeoutMs: number
  readonly maxTurnHoldMs: number
  readonly rateLimitPerMinute: number
  readonly tokenRateLimitPerMinute: number
  readonly corsOrigins: readonly string[]
}

function intFromEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`invalid integer value ${value} (expected ${min}..${max})`)
  return parsed
}

/** 环境变量/flag → 网关配置；非法值直接抛错（fail closed）。 */
export function resolveRelayConfig(input: {
  args: Readonly<Record<string, unknown>>
  env: NodeJS.ProcessEnv
}): RelayServerConfig {
  const { env } = input
  const portArg = typeof input.args.port === 'string' ? input.args.port : undefined
  const port = intFromEnv(portArg ?? env.GATEWAY_PORT, 8788, 1, 65535)
  return {
    host: env.GATEWAY_HOST ?? '0.0.0.0',
    port,
    tokenTtlSeconds: intFromEnv(env.GATEWAY_TOKEN_TTL_SECONDS, 3600, 1, 7 * 24 * 3600),
    permissionTimeoutMs: intFromEnv(env.GATEWAY_PERMISSION_TIMEOUT_MS, 120_000, 0, 3_600_000),
    queueTimeoutMs: intFromEnv(env.GATEWAY_QUEUE_TIMEOUT_MS, 600_000, 1_000, 3_600_000),
    maxTurnHoldMs: intFromEnv(env.GATEWAY_MAX_TURN_HOLD_MS, 1_800_000, 10_000, 7_200_000),
    rateLimitPerMinute: intFromEnv(env.GATEWAY_RATE_LIMIT_RPM, 600, 1, 1_000_000),
    tokenRateLimitPerMinute: intFromEnv(env.GATEWAY_TOKEN_RATE_LIMIT_RPM, 30, 1, 100_000),
    corsOrigins: (env.GATEWAY_CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
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
export function readModelAliases(
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

/**
 * model 归一：[models.aliases] 别名优先（vision → anthropic/mimo-v2.5），
 * 已含 '/' 的全限定 id 原样，裸名补默认 provider 前缀。网关与本机 uplink 共用。
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
