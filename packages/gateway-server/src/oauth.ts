/**
 * 网关自建 OAuth2（client_credentials）+ HS256 JWT 签发/校验。
 *
 * 设计取舍：
 * - 面向机器对机器调用（CI / Web 后端 / 移动端后端），不做授权码跳转；
 * - JWT 用 node:crypto 的 HMAC-SHA256 手写（HS256 是唯一接受算法，写死校验，
 *   不存在 alg 混淆面），零第三方依赖；
 * - signing key 由装配侧提供（env 或 0600 持久化文件），本模块不管存储；
 * - client secret 比较走 timingSafeEqual；部署侧应配合速率限制收敛爆破面。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export interface GatewayOAuthClient {
  readonly id: string
  readonly secret: string
  readonly scopes: readonly string[]
}

export interface GatewayTokenClaims {
  readonly sub: string
  readonly scopes: readonly string[]
  /** unix 秒。 */
  readonly expiresAt: number
}

export interface IssuedToken {
  readonly accessToken: string
  readonly tokenType: 'Bearer'
  readonly expiresIn: number
}

const encoder = new TextEncoder()

function base64url(input: Uint8Array | string): string {
  return Buffer.from(input).toString('base64url')
}

function sign(input: string, key: Uint8Array): Uint8Array {
  return createHmac('sha256', key).update(input).digest()
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** clients.json / GATEWAY_CLIENTS 的解析门：任何形状不符都让启动失败（fail closed）。 */
export function parseGatewayClients(source: string): GatewayOAuthClient[] {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    throw new Error('gateway clients must be a JSON array')
  }
  if (!Array.isArray(raw)) throw new Error('gateway clients must be a JSON array')
  const seen = new Set<string>()
  const clients: GatewayOAuthClient[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('gateway client entries must be objects')
    const candidate = entry as Record<string, unknown>
    if (
      typeof candidate.id !== 'string' ||
      !/^[\w.-]{1,128}$/.test(candidate.id) ||
      typeof candidate.secret !== 'string' ||
      candidate.secret.length < 16
    )
      throw new Error('gateway client requires id (/^[\\w.-]{1,128}$/) and a secret of 16+ chars')
    if (seen.has(candidate.id)) throw new Error(`duplicate gateway client id: ${candidate.id}`)
    seen.add(candidate.id)
    const scopes = candidate.scopes
    if (
      scopes !== undefined &&
      (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string'))
    )
      throw new Error(`gateway client ${candidate.id}: scopes must be a string array`)
    clients.push({
      id: candidate.id,
      secret: candidate.secret,
      scopes: (scopes as readonly string[] | undefined) ?? ['chat'],
    })
  }
  if (clients.length === 0) throw new Error('gateway clients must not be empty')
  return clients
}

/** 生成一个随机客户端（无配置时的 bootstrap 路径，装配侧负责 0600 落盘）。 */
export function generateGatewayClient(): GatewayOAuthClient {
  return {
    id: `volund-${randomBytes(6).toString('base64url')}`,
    secret: randomBytes(32).toString('base64url'),
    scopes: ['chat', 'sessions'],
  }
}

export class GatewayOAuthServer {
  private readonly clients = new Map<string, GatewayOAuthClient>()

  constructor(
    private readonly options: {
      readonly issuer: string
      /** HS256 签名密钥；熵源由装配侧保证（随机 32B+ 或运维 secret）。 */
      readonly signingKey: Uint8Array
      readonly tokenTtlSeconds: number
      readonly clients: readonly GatewayOAuthClient[]
      /** 测试注入时钟。 */
      readonly now?: () => number
    },
  ) {
    for (const client of options.clients) this.clients.set(client.id, client)
  }

  /** client_credentials 认证：id/secret 常量时间比对；失败一律 undefined（不区分哪种错）。 */
  authenticate(clientId: string, clientSecret: string): GatewayOAuthClient | undefined {
    const client = this.clients.get(clientId)
    if (!client) return undefined
    return safeEqual(client.secret, clientSecret) ? client : undefined
  }

  /** 签发 JWT。请求的 scope 必须是客户端已授权 scope 的子集，否则 undefined。 */
  issue(client: GatewayOAuthClient, requestedScopes: readonly string[]): IssuedToken | undefined {
    const granted =
      requestedScopes.length === 0
        ? [...client.scopes]
        : requestedScopes.filter((scope) => client.scopes.includes(scope))
    if (requestedScopes.some((scope) => !client.scopes.includes(scope))) return undefined
    const now = Math.floor((this.options.now?.() ?? Date.now()) / 1000)
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    const payload = base64url(
      JSON.stringify({
        iss: this.options.issuer,
        sub: client.id,
        scope: granted.join(' '),
        iat: now,
        exp: now + this.options.tokenTtlSeconds,
        jti: randomBytes(12).toString('base64url'),
      }),
    )
    const signature = base64url(sign(`${header}.${payload}`, this.options.signingKey))
    return {
      accessToken: `${header}.${payload}.${signature}`,
      tokenType: 'Bearer',
      expiresIn: this.options.tokenTtlSeconds,
    }
  }

  /** 校验 Bearer token：签名 / iss / exp / sub 任一不过即 undefined（调用方映射 401）。 */
  verify(token: string): GatewayTokenClaims | undefined {
    const parts = token.split('.')
    if (parts.length !== 3) return undefined
    const [header, payload, signature] = parts as [string, string, string]
    if (header !== base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))) return undefined
    const expected = sign(`${header}.${payload}`, this.options.signingKey)
    let actual: Buffer
    try {
      actual = Buffer.from(signature, 'base64url')
    } catch {
      return undefined
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
    let claims: { iss?: unknown; sub?: unknown; scope?: unknown; exp?: unknown }
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    } catch {
      return undefined
    }
    if (claims.iss !== this.options.issuer) return undefined
    if (typeof claims.sub !== 'string' || !this.clients.has(claims.sub)) return undefined
    if (typeof claims.exp !== 'number') return undefined
    const now = Math.floor((this.options.now?.() ?? Date.now()) / 1000)
    if (claims.exp <= now) return undefined
    const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : []
    return { sub: claims.sub, scopes, expiresAt: claims.exp }
  }
}

/** 从运维口令派生签名密钥（短口令不直接当 HMAC key——先经 HMAC 拉伸成 32B）。 */
export function deriveSigningKey(secretMaterial: string): Uint8Array {
  return createHmac('sha256', encoder.encode('volund-gateway-signing-v1'))
    .update(secretMaterial)
    .digest()
}
