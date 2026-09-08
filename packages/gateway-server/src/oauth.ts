/**
 * 网关自建 OAuth2（client_credentials）+ HS256 JWT 签发/校验。
 *
 * 设计取舍：
 * - 面向机器对机器调用（CI / Web 后端 / 移动端后端），不做授权码跳转；
 * - JWT 用 node:crypto 的 HMAC-SHA256 手写（HS256 是唯一接受算法，写死校验，
 *   不存在 alg 混淆面），零第三方依赖；
 * - signing key 由装配侧提供（env 或 0600 持久化文件），本模块不管存储；
 * - client secret 绝不落盘：存储形态只有域分隔 SHA-256 哈希（`secretHash`），
 *   认证时哈希后常量时间比对。明文只出现在 env 注入与 bootstrap 的启动输出里。
 *   配合 GATEWAY_TOKEN_SECRET 走 env，磁盘（/data 卷）泄露换不出任何可用凭证；
 * - 部署侧应配合速率限制收敛爆破面。
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** 存储形态的客户端：只有哈希，没有明文。 */
export interface GatewayOAuthClient {
  readonly id: string
  /** sha256("volund-gateway-client-v1:" + secret) 的 hex。 */
  readonly secretHash: string
  readonly scopes: readonly string[]
}

/** bootstrap 生成的客户端：明文 secret 只存在内存与一次性启动输出里。 */
export interface GeneratedGatewayClient {
  readonly id: string
  readonly secret: string
  readonly scopes: readonly string[]
}

/** 客户端 secret 的存储哈希（域分隔；高熵随机 secret 无惧彩虹表，无需慢哈希）。 */
export function hashGatewayClientREFID_014Q(secret: string): string {
  return createHash('sha256').update(`volund-gateway-client-v1:${secret}`).digest('hex')
}

/** 生成物 → 存储形态（调用方负责把明文打印给运维一次，随后丢弃）。 */
export function hashGatewayClient(client: GeneratedGatewayClient): GatewayOAuthClient {
  return {
    id: client.id,
    secretHash: hashGatewayClientREFID_014Q(client.secret),
    scopes: client.scopes,
  }
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

/** HS256 JWT 签发原语（头部写死 `{alg:'HS256', typ:'JWT'}`；claims 原样入 payload）。 */
export function signGatewayJwt(claims: Record<string, unknown>, key: Uint8Array): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify(claims))
  const signature = base64url(sign(`${header}.${payload}`, key))
  return `${header}.${payload}.${signature}`
}

/** HS256 JWT 校验原语：签名/形状/JSON 可解析；iss/exp 等语义校验留给调用方。 */
export function verifyGatewayJwt(
  token: string,
  key: Uint8Array,
): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  const [header, payload, signature] = parts as [string, string, string]
  if (header !== base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))) return undefined
  const expected = sign(`${header}.${payload}`, key)
  let actual: Buffer
  try {
    actual = Buffer.from(signature, 'base64url')
  } catch {
    return undefined
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export interface ParsedGatewayClients {
  readonly clients: GatewayOAuthClient[]
  /** 以明文 `secret` 出现、已被哈希化的条目 id——装配侧据此重写落盘文件完成迁移。 */
  readonly migratedPlaintextIds: readonly string[]
}

/**
 * clients.json / GATEWAY_CLIENTS 的解析门：任何形状不符都让启动失败（fail closed）。
 * 条目二选一：`secret`（明文，仅 env/迁移路径）或 `secretHash`（64 位 hex，落盘形态）。
 */
export function parseGatewayClients(source: string): ParsedGatewayClients {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    throw new Error('gateway clients must be a JSON array')
  }
  if (!Array.isArray(raw)) throw new Error('gateway clients must be a JSON array')
  const seen = new Set<string>()
  const clients: GatewayOAuthClient[] = []
  const migratedPlaintextIds: string[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('gateway client entries must be objects')
    const candidate = entry as Record<string, unknown>
    if (typeof candidate.id !== 'string' || !/^[\w.-]{1,128}$/.test(candidate.id))
      throw new Error('gateway client requires id (/^[\\w.-]{1,128}$/)')
    const hasPlaintext = typeof candidate.secret === 'string'
    const hasHash = typeof candidate.secretHash === 'string'
    if (hasPlaintext === hasHash)
      throw new Error(
        `gateway client ${candidate.id}: exactly one of secret / secretHash is required`,
      )
    let secretHash: string
    if (hasPlaintext) {
      const secret = candidate.secret as string
      if (secret.length < 16)
        throw new Error(`gateway client ${candidate.id}: secret must be 16+ chars`)
      secretHash = hashGatewayClientREFID_014Q(secret)
      migratedPlaintextIds.push(candidate.id)
    } else {
      secretHash = candidate.secretHash as string
      if (!/^[0-9a-f]{64}$/.test(secretHash))
        throw new Error(`gateway client ${candidate.id}: secretHash must be 64 lowercase hex chars`)
    }
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
      secretHash,
      scopes: (scopes as readonly string[] | undefined) ?? ['chat'],
    })
  }
  if (clients.length === 0) throw new Error('gateway clients must not be empty')
  return { clients, migratedPlaintextIds }
}

/** 生成一个随机客户端（无配置时的 bootstrap 路径；明文不落盘，存储形态用 hashGatewayClient）。 */
export function generateGatewayClient(): GeneratedGatewayClient {
  return {
    id: `volund-${randomBytes(6).toString('base64url')}`,
    secret: randomBytes(32).toString('base64url'),
    // chat/sessions = API 面；uplink = 远程控制反向拨出（/uplink 门槛）。
    scopes: ['chat', 'sessions', 'uplink'],
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

  /** client_credentials 认证：明文哈希后常量时间比对；失败一律 undefined（不区分哪种错）。 */
  authenticate(clientId: string, clientSecret: string): GatewayOAuthClient | undefined {
    const client = this.clients.get(clientId)
    if (!client) return undefined
    return safeEqual(client.secretHash, hashGatewayClientREFID_014Q(clientSecret))
      ? client
      : undefined
  }

  /** 签发 JWT。请求的 scope 必须是客户端已授权 scope 的子集，否则 undefined。 */
  issue(client: GatewayOAuthClient, requestedScopes: readonly string[]): IssuedToken | undefined {
    const granted =
      requestedScopes.length === 0
        ? [...client.scopes]
        : requestedScopes.filter((scope) => client.scopes.includes(scope))
    if (requestedScopes.some((scope) => !client.scopes.includes(scope))) return undefined
    const now = Math.floor((this.options.now?.() ?? Date.now()) / 1000)
    return {
      accessToken: signGatewayJwt(
        {
          iss: this.options.issuer,
          sub: client.id,
          scope: granted.join(' '),
          iat: now,
          exp: now + this.options.tokenTtlSeconds,
          jti: randomBytes(12).toString('base64url'),
        },
        this.options.signingKey,
      ),
      tokenType: 'Bearer',
      expiresIn: this.options.tokenTtlSeconds,
    }
  }

  /** 校验 Bearer token：签名 / iss / exp / sub 任一不过即 undefined（调用方映射 401）。 */
  verify(token: string): GatewayTokenClaims | undefined {
    const claims = verifyGatewayJwt(token, this.options.signingKey)
    if (!claims) return undefined
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
