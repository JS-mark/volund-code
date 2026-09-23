/**
 * 配对与移动端设备凭证（远程控制 REM-r1）+ 机器注册码（多机自助接入）。
 *
 * 两种 kind：
 * - device（默认）：桌面 Web「远程控制」页经 uplink 请求 `pairing.create` →
 *   网关生成一次性短时配对码（内存态，默认 5 分钟）→ 手机站
 *   `POST /pairing/redeem` 核销 → 签发设备 JWT（默认 30 天）并登记设备。
 * - machine：已接入机器经 `POST /v1/pairing`（uplink scope）铸造注册码 →
 *   新机器 `POST /pairing/redeem`（带 kind=machine 的码）核销 → 网关铸造
 *   独立 OAuth 机器客户端（哈希落盘 + 认证面登记），明文 secret 只在核销
 *   应答里出现一次。注册码的铸造与核销信任同一前提：持有已接入机器的人
 *   = 有权接纳新机器。
 *
 * 与 OAuth client_credentials 的分工：机器凭证面向 uplink/CI（clients.json）；
 * 设备 token 面向人（手机浏览器），sub=deviceId、client=所绑定机器的 client id
 * ——网关路由与撤销都以设备注册表为准（有状态），所以 token 校验同时查注册表。
 *
 * 存储：设备注册表 JSON 落盘（0600，配对跨网关重启存活；uplink/配对码是内存态，
 * 重启后重连/重发即可）。lastSeen 节流写（≥60s 才落盘一次）。机器客户端的
 * 落盘不在本模块——认证面归 clients.json（relay-config 的 registerClient）。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { signGatewayJwt, verifyGatewayJwt } from './oauth'

/** 非易混字母表（无 0/O/1/I/L），8 位 ≈ 40 bit 熵 + 限流收敛爆破面。 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const CODE_LENGTH = 8

export interface PairedDeviceRecord {
  readonly id: string
  name: string
  readonly client: string
  readonly pairedAt: number
  lastSeen: number
  /** 最近一次配对/活跃的来源 ip（trustProxy 时为 XFF 真实地址）。 */
  lastIp?: string
  /** 配对时浏览器的 User-Agent（审计参考，可缺失）。 */
  userAgent?: string
}

export interface PairingCodeRecord {
  readonly code: string
  readonly client: string
  /** device=移动设备配对（核销签设备 token）；machine=机器注册（核销铸造 OAuth client）。 */
  readonly kind: 'device' | 'machine'
  readonly createdAt: number
  readonly expiresAt: number
}

export interface DeviceTokenClaims {
  readonly sub: string
  readonly client: string
  readonly scopes: readonly string[]
  readonly expiresAt: number
}

export interface RedeemResult {
  readonly accessToken: string
  readonly tokenType: 'Bearer'
  readonly expiresIn: number
  readonly deviceId: string
  readonly scope: string
}

export interface PairingStoreOptions {
  readonly signingKey: Uint8Array
  readonly issuer: string
  /** 设备注册表落盘路径；缺省 = 纯内存（测试）。 */
  readonly storePath?: string
  /** 配对码有效期（默认 5 分钟）。 */
  readonly codeTtlMs?: number
  /** 设备 token 有效期秒（默认 30 天）。 */
  readonly deviceTokenTtlSeconds?: number
  readonly now?: () => number
  readonly logger?: (message: string) => void
}

const DEFAULT_CODE_TTL_MS = 5 * 60_000
const DEFAULT_DEVICE_TTL_SECONDS = 30 * 24 * 3600
/** lastSeen 落盘节流。 */
const TOUCH_THROTTLE_MS = 60_000

function newPairingCode(): string {
  const bytes = randomBytes(CODE_LENGTH)
  let code = ''
  for (let index = 0; index < CODE_LENGTH; index += 1)
    code += CODE_ALPHABET[bytes[index]! % CODE_ALPHABET.length]
  return code
}

function safeEqualStrings(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export class PairingStore {
  private readonly codes = new Map<string, PairingCodeRecord>()
  private devices: PairedDeviceRecord[] = []
  private loaded = false
  private readonly codeTtlMs: number
  private readonly deviceTtlSeconds: number
  private readonly now: () => number
  private readonly log: (message: string) => void

  constructor(private readonly options: PairingStoreOptions) {
    this.codeTtlMs = options.codeTtlMs ?? DEFAULT_CODE_TTL_MS
    this.deviceTtlSeconds = options.deviceTokenTtlSeconds ?? DEFAULT_DEVICE_TTL_SECONDS
    this.now = options.now ?? (() => Date.now())
    this.log = options.logger ?? (() => {})
  }

  /** 惰性加载 + 过期配对码清扫（每次 create/redeem 顺带执行）。 */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (!this.options.storePath) return
    try {
      const raw = JSON.parse(await readFile(this.options.storePath, 'utf8')) as unknown
      if (Array.isArray(raw)) {
        this.devices = raw.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return []
          const record = entry as Record<string, unknown>
          if (
            typeof record.id !== 'string' ||
            typeof record.client !== 'string' ||
            typeof record.name !== 'string'
          )
            return []
          return [
            {
              id: record.id,
              name: record.name,
              client: record.client,
              pairedAt: typeof record.pairedAt === 'number' ? record.pairedAt : 0,
              lastSeen: typeof record.lastSeen === 'number' ? record.lastSeen : 0,
              ...(typeof record.lastIp === 'string' ? { lastIp: record.lastIp } : {}),
              ...(typeof record.userAgent === 'string' ? { userAgent: record.userAgent } : {}),
            },
          ]
        })
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT')
        this.log(`pairing store load failed: ${String(cause)}`)
    }
  }

  private async persist(): Promise<void> {
    if (!this.options.storePath) return
    const target = this.options.storePath
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, `${JSON.stringify(this.devices, null, 2)}\n`, { mode: 0o600 })
  }

  private sweepCodes(): void {
    const now = this.now()
    for (const [code, record] of this.codes) if (record.expiresAt <= now) this.codes.delete(code)
  }

  /** 生成一次性配对码（同 client 可并存多张；每张限核销一次）。 */
  async createCode(
    client: string,
    kind: 'device' | 'machine' = 'device',
  ): Promise<PairingCodeRecord> {
    await this.ensureLoaded()
    this.sweepCodes()
    const now = this.now()
    const record: PairingCodeRecord = {
      code: newPairingCode(),
      client,
      kind,
      createdAt: now,
      expiresAt: now + this.codeTtlMs,
    }
    this.codes.set(record.code, record)
    return record
  }

  /**
   * 核销配对码。码不存在/过期/已用一律 undefined（错误信息不区分，收敛探测面）；
   * 比对走常量时间。device → 登记设备 + 签发设备 token；machine → 只消费码，
   * 凭证铸造（clients.json 落盘 + 认证面登记）由网关侧 registerMachine 承接，
   * result 为 undefined。`deviceMeta` 是审计信息（来源 ip/UA），随设备落盘。
   */
  async redeem(
    code: string,
    deviceName: string | undefined,
    deviceMeta?: { readonly ip?: string; readonly userAgent?: string },
  ): Promise<{ record: PairingCodeRecord; result: RedeemResult | undefined } | undefined> {
    await this.ensureLoaded()
    this.sweepCodes()
    const now = this.now()
    let matched: PairingCodeRecord | undefined
    for (const record of this.codes.values()) {
      if (record.expiresAt <= now) continue
      if (safeEqualStrings(record.code, code)) matched = record
    }
    if (!matched) return undefined
    this.codes.delete(matched.code)
    if (matched.kind === 'machine') return { record: matched, result: undefined }
    const deviceId = `dev-${randomBytes(9).toString('base64url')}`
    const expiresAt = Math.floor((now + this.deviceTtlSeconds * 1000) / 1000)
    const device: PairedDeviceRecord = {
      id: deviceId,
      name:
        deviceName && deviceName.trim().slice(0, 64) ? deviceName.trim().slice(0, 64) : '移动设备',
      client: matched.client,
      pairedAt: now,
      lastSeen: now,
      ...(deviceMeta?.ip ? { lastIp: deviceMeta.ip } : {}),
      ...(deviceMeta?.userAgent ? { userAgent: deviceMeta.userAgent } : {}),
    }
    this.devices.push(device)
    await this.persist()
    const accessToken = signGatewayJwt(
      {
        iss: this.options.issuer,
        sub: deviceId,
        client: matched.client,
        scope: 'chat',
        typ: 'device',
        iat: Math.floor(now / 1000),
        exp: expiresAt,
        jti: randomBytes(12).toString('base64url'),
      },
      this.options.signingKey,
    )
    return {
      record: matched,
      result: {
        accessToken,
        tokenType: 'Bearer',
        expiresIn: this.deviceTtlSeconds,
        deviceId,
        scope: 'chat',
      },
    }
  }

  /** 设备清单（可按绑定机器过滤）。 */
  async listDevices(client?: string): Promise<readonly PairedDeviceRecord[]> {
    await this.ensureLoaded()
    return client ? this.devices.filter((device) => device.client === client) : [...this.devices]
  }

  /** 撤销设备（删除注册表条目，token 随即失效）。 */
  async revokeDevice(client: string, deviceId: string): Promise<boolean> {
    await this.ensureLoaded()
    const before = this.devices.length
    this.devices = this.devices.filter(
      (device) => !(device.client === client && device.id === deviceId),
    )
    if (this.devices.length === before) return false
    await this.persist()
    return true
  }

  /**
   * 设备 token 校验：JWT 语义 + 注册表存在性（撤销即失效）。
   * `ip` 提供时随活跃心跳刷新 lastIp（同一节流窗口内落盘）。
   */
  async verifyDeviceToken(token: string, ip?: string): Promise<DeviceTokenClaims | undefined> {
    await this.ensureLoaded()
    const claims = verifyGatewayJwt(token, this.options.signingKey)
    if (!claims || claims.typ !== 'device') return undefined
    if (claims.iss !== this.options.issuer) return undefined
    if (typeof claims.sub !== 'string' || typeof claims.client !== 'string') return undefined
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= this.now()) return undefined
    const device = this.devices.find((entry) => entry.id === claims.sub)
    if (!device || device.client !== claims.client) return undefined
    // lastSeen/lastIp 节流落盘：活跃设备每分钟最多写一次盘。
    if (this.now() - device.lastSeen >= TOUCH_THROTTLE_MS) {
      device.lastSeen = this.now()
      if (ip) device.lastIp = ip
      void this.persist().catch(() => {})
    }
    const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : []
    return { sub: claims.sub, client: claims.client, scopes, expiresAt: claims.exp }
  }
}
